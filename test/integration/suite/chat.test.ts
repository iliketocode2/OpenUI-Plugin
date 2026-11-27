import * as assert from 'node:assert/strict';
import { EXTENSION_ID } from '../extensionId';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';
import type { TranscriptItem } from '../../../src/shared/protocol';
import type { WireMessage } from '../../../src/owui/types';
import { MockOwui, sseChunks } from '../../mock-owui/server';

const KEY = 'sk-integration';
let mock: MockOwui;
let api: TestApi;

async function configure(settings: Record<string, unknown>): Promise<void> {
  const c = vscode.workspace.getConfiguration('owuiAgent');
  for (const [k, v] of Object.entries(settings)) await c.update(k, v, vscode.ConfigurationTarget.Global);
}

function transcript(): TranscriptItem[] {
  return api.controller.viewState().transcript;
}

function last<K extends TranscriptItem['kind']>(kind: K): Extract<TranscriptItem, { kind: K }> {
  const items = transcript().filter((t): t is Extract<TranscriptItem, { kind: K }> => t.kind === kind);
  const item = items[items.length - 1];
  assert.ok(item, `no ${kind} item in transcript`);
  return item;
}

function sentMessages(index: number): WireMessage[] {
  return (mock.chatRequests()[index]!.body as { messages: WireMessage[] }).messages;
}

describe('OWUI Agent chat (integration)', () => {
  before(async () => {
    mock = new MockOwui({ apiKey: KEY, models: { data: [{ id: 'chat-model', name: 'Mock Model', info: { params: { num_ctx: 16384 }, meta: { capabilities: { vision: false } } } }] } });
    await mock.start();
    const ext = vscode.extensions.getExtension<TestApi>(EXTENSION_ID);
    assert.ok(ext, 'extension not found');
    const exported = await ext.activate();
    assert.ok(exported, 'test API is only exported in test mode');
    api = exported;
    await configure({ baseUrl: mock.baseUrl, models: {} });
    await api.keys.set(KEY);
    await api.controller.refresh();
  });

  after(async () => {
    await mock?.stop();
  });

  beforeEach(() => {
    api.controller.newSession();
    mock.requests.length = 0;
  });

  it('opens in a workspace whose path contains spaces', () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder);
    assert.match(folder.uri.fsPath, / /);
  });

  it('connects, lists models and reads the context size from Open WebUI', () => {
    const state = api.controller.viewState();
    assert.equal(state.connection.status, 'ok');
    assert.equal(state.connection.serverVersion, '0.12.0');
    assert.deepEqual(state.models.map((m) => m.id), ['chat-model']);
    assert.equal(state.selectedModel, 'chat-model');
    assert.equal(state.models[0]!.contextSource, 'server');
    assert.equal(state.sovereignty, 'unverified');
  });

  it('renders the chat view without errors', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.owuiAgent');
    await new Promise((r) => setTimeout(r, 500));
  });

  it('streams a reply, keeps reasoning separate and never sends reasoning back', async () => {
    mock.enqueue(
      { kind: 'sse', chunks: sseChunks({ reasoning: 'SECRET-REASONING step by step', content: 'Hello from the mock.', usage: { prompt_tokens: 120, completion_tokens: 8 } }) },
      { kind: 'sse', chunks: sseChunks({ content: '<think>inline thoughts</think>Second answer.', usage: { prompt_tokens: 140, completion_tokens: 6 } }) },
      { kind: 'sse', chunks: sseChunks({ content: 'Third.', usage: { prompt_tokens: 160, completion_tokens: 2 } }) },
    );
    await api.controller.send('Say hello');
    const first = last('assistant');
    assert.equal(first.text, 'Hello from the mock.');
    assert.equal(first.reasoning, 'SECRET-REASONING step by step');
    assert.equal(first.streaming, false);

    await api.controller.send('Again');
    const second = last('assistant');
    assert.equal(second.text, 'Second answer.');
    assert.equal(second.reasoning, 'inline thoughts');

    await api.controller.send('Once more');
    const sent = sentMessages(2);
    assert.equal(sent[0]!.role, 'system');
    assert.ok(String(sent[0]!.content).includes(vscode.workspace.workspaceFolders![0]!.uri.fsPath));
    const assistantContents = sent.filter((m) => m.role === 'assistant').map((m) => m.content);
    assert.deepEqual(assistantContents, ['Hello from the mock.', 'Second answer.']);
    assert.ok(!JSON.stringify(sent).includes('SECRET-REASONING'));
    assert.ok(!JSON.stringify(sent).includes('inline thoughts'));
    assert.equal(api.controller.viewState().usage?.estimated, false);
  });

  it('warns when the server reports far fewer prompt tokens than were sent', async () => {
    mock.enqueue({ kind: 'sse', chunks: sseChunks({ content: 'I only saw the end.', usage: { prompt_tokens: 300, completion_tokens: 5 } }) });
    await api.controller.send(`Summarize this:\n${'All work and no play makes a dull report. '.repeat(400)}`);
    const warning = last('warning');
    assert.match(warning.text, /probably truncated/);
  });

  it('warns once per model when usage is missing', async () => {
    mock.enqueue({ kind: 'sse', chunks: sseChunks({ content: 'no usage' }) }, { kind: 'sse', chunks: sseChunks({ content: 'still none' }) });
    await api.controller.send('one');
    await api.controller.send('two');
    const warnings = transcript().filter((t) => t.kind === 'warning' && /Usage/.test(t.text));
    assert.equal(warnings.length, 1, JSON.stringify(transcript().map((t) => [t.kind, 'text' in t ? t.text.slice(0, 120) : ''])));
    api.controller.newSession();
    mock.enqueue({ kind: 'sse', chunks: sseChunks({ content: 'three' }) });
    await api.controller.send('three');
    assert.equal(transcript().filter((t) => t.kind === 'warning').length, 0);
  });

  it('refuses to send a prompt that cannot fit the context window', async () => {
    await configure({ models: { 'chat-model': { contextSize: 1024 } } });
    try {
      await api.controller.send(`x ${'lorem ipsum dolor sit amet '.repeat(400)}`);
      assert.match(last('error').text, /does not fit/);
      assert.equal(mock.chatRequests().length, 0);
    } finally {
      await configure({ models: {} });
    }
  });

  it('stops a streaming reply and keeps the partial text', async () => {
    mock.enqueue({ kind: 'sse', chunks: sseChunks({ content: 'one two three four five six seven eight', pieces: 8 }), delayMs: 150 });
    const done = api.controller.send('count slowly');
    const streamed = () => transcript().some((t) => t.kind === 'assistant' && t.text.length > 0);
    for (let waited = 0; !streamed() && waited < 10_000; waited += 25) await new Promise((r) => setTimeout(r, 25));
    api.controller.stop();
    await done;
    const item = last('assistant');
    assert.equal(item.stopped, true);
    assert.ok(item.text.length > 0 && item.text.length < 'one two three four five six seven eight'.length);
    assert.equal(api.controller.viewState().busy, false);
  });

  it('retries a dropped stream and shows the final answer', async () => {
    mock.enqueue({ kind: 'sse', chunks: sseChunks({ content: 'partial partial partial', pieces: 3 }), dropAfter: 2, delayMs: 20 }, { kind: 'sse', chunks: sseChunks({ content: 'recovered' }) });
    await api.controller.send('flaky');
    assert.equal(last('assistant').text, 'recovered');
    assert.equal(mock.chatRequests().length, 2);
  });

  it('asks for a new API key when Open WebUI rejects it', async () => {
    await api.keys.set('sk-wrong');
    try {
      await api.controller.send('hi');
      const err = last('error');
      assert.equal(err.action, 'setApiKey');
      assert.match(err.text, /rejected/);
    } finally {
      await api.keys.set(KEY);
      await api.controller.refresh();
    }
  });

  it('marks a model as local and updates the sovereignty indicator', async () => {
    await api.controller.setModelLocal('chat-model', true);
    assert.equal(api.controller.viewState().sovereignty, 'local');
    await api.controller.setModelLocal('chat-model', false);
    assert.equal(api.controller.viewState().sovereignty, 'unverified');
  });

  it('warms up a local model in the background, shows it in the view, and does not repeat it', async () => {
    const until = async (cond: () => boolean, what: string) => {
      for (let waited = 0; !cond(); waited += 20) {
        if (waited > 5000) assert.fail(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    mock.enqueue({ kind: 'sse', chunks: sseChunks({ content: '.' }), headersDelayMs: 400 });
    try {
      await api.controller.setModelLocal('chat-model', true);
      await until(() => api.controller.viewState().warmUp?.status === 'warming', 'the warm-up to start');
      assert.equal(api.controller.viewState().warmUp?.modelId, 'chat-model');
      await until(() => api.controller.viewState().warmUp === undefined, 'the warm-up to finish');
      const warm = mock.chatRequests();
      assert.equal(warm.length, 1);
      assert.equal((warm[0]!.body as { max_tokens: number }).max_tokens, 1);
      api.controller.warmUp();
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(mock.chatRequests().length, 1, 'the same prompt should not be warmed twice');
      // A new session has its own scratchpad path in the instructions, so its prompt differs and is warmed again.
      mock.enqueue({ kind: 'sse', chunks: sseChunks({ content: '.' }) });
      api.controller.newSession();
      await until(() => mock.chatRequests().length === 2 && api.controller.viewState().warmUp === undefined, 'the new session to be warmed');
    } finally {
      await api.controller.setModelLocal('chat-model', false);
    }
  });

  it('shows a failed warm-up without retrying it, and clears it when the model no longer qualifies', async () => {
    const until = async (cond: () => boolean, what: string) => {
      for (let waited = 0; !cond(); waited += 20) {
        if (waited > 5000) assert.fail(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    mock.enqueue({ kind: 'json', status: 503, body: { detail: 'model is loading elsewhere' } });
    try {
      await api.controller.setModelLocal('chat-model', true);
      await until(() => api.controller.viewState().warmUp?.status === 'failed', 'the warm-up to fail');
      assert.equal(mock.chatRequests().length, 1, 'a failed warm-up is not retried');
      assert.match(api.controller.viewState().warmUp?.error ?? '', /503/);
    } finally {
      await api.controller.setModelLocal('chat-model', false);
    }
    await until(() => api.controller.viewState().warmUp === undefined, 'the warning to clear');
  });

  it('reconnects when the base URL changes, but not for settings that only change the view', async () => {
    const modelRequests = () => mock.requests.filter((r) => r.path === '/api/models').length;
    const before = modelRequests();
    await configure({ 'agent.maxIterations': 51 });
    await api.controller.setModelLocal('chat-model', true);
    await api.controller.setModelLocal('chat-model', false);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(modelRequests(), before);
    await configure({ 'agent.maxIterations': undefined });
    await configure({ baseUrl: `${mock.baseUrl}/` });
    for (let waited = 0; modelRequests() === before && waited < 5000; waited += 25) await new Promise((r) => setTimeout(r, 25));
    assert.ok(modelRequests() > before, 'changing the base URL should reconnect');
    await configure({ baseUrl: mock.baseUrl });
  });

  it('stores the API key only in SecretStorage, never in settings', () => {
    const all = JSON.stringify(vscode.workspace.getConfiguration('owuiAgent'));
    assert.ok(!all.includes(KEY));
  });
});
