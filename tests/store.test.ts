import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryParallaxStore } from '../src/store/memory.js';
import type { BaseObject, RunObject, Relation } from '../src/types.js';

describe('InMemoryParallaxStore', () => {
  let store: InMemoryParallaxStore;

  beforeEach(() => {
    store = new InMemoryParallaxStore();
  });

  it('stores and retrieves objects', async () => {
    const obj: BaseObject = {
      id: 'test-1',
      kind: 'Agent',
      type: 'Agent',
      properties: { name: 'test' },
      createdAt: new Date().toISOString(),
    };
    await store.putObject(obj);
    expect(await store.getObject('test-1')).toEqual(obj);
  });

  it('stores and retrieves runs', async () => {
    const run: RunObject = {
      id: 'run-1',
      kind: 'Run',
      type: 'Run',
      agentId: 'agent-1',
      status: 'active',
      actionIds: [],
      artifactIds: [],
      properties: {},
      createdAt: new Date().toISOString(),
    };
    await store.putRun(run);
    expect(await store.getRun('run-1')).toEqual(run);
    // Runs are also stored as objects
    expect(await store.getObject('run-1')).toEqual(run);
  });

  it('filters relations by type and endpoints', async () => {
    const rel: Relation = {
      id: 'rel-1',
      type: 'DEPENDS_ON',
      from: 'a',
      to: 'b',
    };
    await store.putRelation(rel);

    expect(await store.getRelations('DEPENDS_ON')).toHaveLength(1);
    expect(await store.getRelations('CAUSED')).toHaveLength(0);
    expect(await store.getRelations('DEPENDS_ON', 'a')).toHaveLength(1);
    expect(await store.getRelations('DEPENDS_ON', 'x')).toHaveLength(0);
    expect(await store.getRelations(undefined, undefined, 'b')).toHaveLength(1);
  });

  it('queries objects by kind and filter', async () => {
    const obj1: BaseObject = {
      id: 'a1',
      kind: 'Agent',
      type: 'Agent',
      agentId: 'x',
      properties: {},
      createdAt: new Date().toISOString(),
    };
    const obj2: BaseObject = {
      id: 'a2',
      kind: 'Agent',
      type: 'Agent',
      agentId: 'y',
      properties: {},
      createdAt: new Date().toISOString(),
    };
    await store.putObject(obj1);
    await store.putObject(obj2);

    expect(await store.query('Agent')).toHaveLength(2);
    expect(await store.query('Agent', { agentId: 'x' })).toHaveLength(1);
    expect(await store.query('Artifact')).toHaveLength(0);
  });

  it('findByHash looks up by object id', async () => {
    const obj: BaseObject = {
      id: 'hash-abc',
      kind: 'Agent',
      type: 'Agent',
      properties: {},
      createdAt: new Date().toISOString(),
    };
    await store.putObject(obj);
    expect(await store.findByHash('hash-abc')).toEqual(obj);
    expect(await store.findByHash('nonexistent')).toBeUndefined();
  });
});
