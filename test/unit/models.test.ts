import { describe, expect, it } from 'vitest';
import { ASSUMED_CONTEXT, parseModelList, resolveModel } from '../../src/owui/models';
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

  it('accepts a bare array', () => {
    expect(parseModelList([{ id: 'x' }]).map((m) => m.id)).toEqual(['x']);
  });
});

describe('resolveModel', () => {
  it('prefers the user setting, then the server, then the assumption', () => {
    expect(resolveModel({ id: 'm', name: 'm' }, undefined)).toMatchObject({ contextSize: ASSUMED_CONTEXT, contextSource: 'assumed', toolMode: 'auto', local: false });
    expect(resolveModel({ id: 'm', name: 'm', contextSize: 16384 }, undefined)).toMatchObject({ contextSize: 16384, contextSource: 'server' });
    expect(resolveModel({ id: 'm', name: 'm', contextSize: 16384 }, { contextSize: 8192, local: true, toolMode: 'text' })).toMatchObject({
      contextSize: 8192,
      contextSource: 'setting',
      local: true,
      toolMode: 'text',
    });
  });
});
