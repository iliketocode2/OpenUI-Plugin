import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyStore } from '../../src/config/secrets';
import { EventEmitter } from './vscode-stub';

function fakeSecrets() {
  const changed = new EventEmitter<{ key: string }>();
  const state = { value: undefined as string | undefined, staleRead: undefined as string | undefined };
  return {
    state,
    fire: () => changed.fire({ key: 'owuiAgent.apiKey' }),
    secrets: {
      get: async () => (state.staleRead !== undefined ? state.staleRead : state.value),
      store: async (_k: string, v: string) => {
        state.value = v;
      },
      delete: async () => {
        state.value = undefined;
      },
      onDidChange: changed.event,
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ApiKeyStore', () => {
  it('keeps its own latest write when a late change event and a stale read arrive', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const f = fakeSecrets();
    const store = new ApiKeyStore(f.secrets as never);
    await store.set('sk-old');
    await store.set('sk-new');
    f.state.staleRead = 'sk-old';
    f.fire();
    expect(await store.get()).toBe('sk-new');
    await store.clear();
    f.fire();
    expect(await store.get()).toBeUndefined();
  });

  it('picks up a genuine change made elsewhere after its own writes have settled', async () => {
    vi.useFakeTimers({ now: 2_000_000 });
    const f = fakeSecrets();
    const store = new ApiKeyStore(f.secrets as never);
    await store.set('sk-mine');
    vi.setSystemTime(2_000_000 + 10_000);
    f.state.value = 'sk-from-another-window';
    let notified = 0;
    store.onDidChange(() => notified++);
    f.fire();
    expect(notified).toBe(1);
    expect(await store.get()).toBe('sk-from-another-window');
  });

  it('does not let a read that started before a write overwrite it', async () => {
    const f = fakeSecrets();
    f.state.value = 'sk-initial';
    const store = new ApiKeyStore(f.secrets as never);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = f.secrets.get;
    f.secrets.get = async () => {
      const v = await original();
      await gate;
      return v;
    };
    const pending = store.get();
    await store.set('sk-written-meanwhile');
    f.secrets.get = original;
    release();
    expect(await pending).toBe('sk-written-meanwhile');
    expect(await store.get()).toBe('sk-written-meanwhile');
  });
});
