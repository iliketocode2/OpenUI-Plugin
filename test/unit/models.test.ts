import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTEXT, parseModelList, resolveModel } from '../../src/owui/models';
import { loadFixture } from '../mock-owui/server';

describe('parseModelList', () => {
  it('parses the recorded Open WebUI 0.12 model list', () => {
    const models = parseModelList(JSON.parse(loadFixture('live/models.json')));
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: 'qwen3.6:27b', vision: true, usageCapability: true });
    expect(models[0]!.contextSize).toBeUndefined();
  });

  it('reads num_ctx from params or params.options and skips malformed entries', () => {
    const models = parseModelList({
      data: [
        { id: 'b', info: { params: { num_ctx: 32768 } } },
        { id: 'a', name: 'Alpha', info: { params: { options: { num_ctx: '8192' } } } },
        { name: 'no id' },
        null,
      ],
    });
    expect(models.map((m) => [m.id, m.contextSize])).toEqual([
      ['a', 8192],
      ['b', 32768],
    ]);
  });

  it('reads the model maximum from Ollama details without treating it as the running context', () => {
    const [m] = parseModelList({ data: [{ id: 'qwen3.5:9b', info: { params: {} }, ollama: { details: { context_length: 262144 } } }] });
    expect(m).toMatchObject({ id: 'qwen3.5:9b', maxContext: 262144 });
    expect(m!.contextSize).toBeUndefined();
    expect(resolveModel(m!, undefined)).toMatchObject({ contextSize: DEFAULT_CONTEXT, contextSource: 'default', maxContext: 262144 });
    expect(resolveModel(m!, { contextSize: 16384 })).toMatchObject({ contextSize: 16384, contextSource: 'setting', maxContext: 262144 });
  });

  it('accepts a bare array', () => {
    expect(parseModelList([{ id: 'x' }]).map((m) => m.id)).toEqual(['x']);
  });
});

describe('resolveModel', () => {
  it('prefers the user setting, then the server, then a 16k default capped at the model maximum', () => {
    expect(DEFAULT_CONTEXT).toBe(16384);
    expect(resolveModel({ id: 'm', name: 'm' }, undefined)).toMatchObject({ contextSize: 16384, contextSource: 'default', toolMode: 'auto', local: false });
    expect(resolveModel({ id: 'm', name: 'm', maxContext: 8192 }, undefined)).toMatchObject({ contextSize: 8192, contextSource: 'default' });
    expect(resolveModel({ id: 'm', name: 'm', contextSize: 16384 }, undefined)).toMatchObject({ contextSize: 16384, contextSource: 'server' });
    expect(resolveModel({ id: 'm', name: 'm', contextSize: 16384 }, { contextSize: 8192, local: true, toolMode: 'text' })).toMatchObject({
      contextSize: 8192,
      contextSource: 'setting',
      local: true,
      toolMode: 'text',
    });
  });
});
