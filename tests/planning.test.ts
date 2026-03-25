import { describe, it, expect, beforeEach } from 'vitest';
import { Parallax } from '../src/parallax.js';
import type { ActionObject } from '../src/types.js';

describe('object creation and planning', () => {
  let p: Parallax;
  let agentId: string;
  let runId: string;

  beforeEach(async () => {
    p = new Parallax();
    const agent = await p.createAgent({ type: 'Agent', properties: { name: 'test-agent' } });
    agentId = agent.id;
    const run = await p.createRun(agentId);
    runId = run.id;
  });

  it('duplicate stable object inserted twice returns existing object', async () => {
    const agent1 = await p.createAgent({ type: 'Agent', properties: { name: 'dedup' } });
    const agent2 = await p.createAgent({ type: 'Agent', properties: { name: 'dedup' } });
    expect(agent1.id).toBe(agent2.id);
  });

  it('artifact contentHash matches BLAKE3 hash of content', async () => {
    const content = { result: 42, data: 'hello' };
    const artifact = await p.createArtifact({
      type: 'output',
      producedByActionId: 'action-1',
      runId,
      content,
      reusable: true,
      properties: {},
    });
    expect(artifact.contentHash).toBe(p.hash(content));
  });

  it('planAction creates matching DEPENDS_ON relations', async () => {
    // Create an artifact to depend on
    const artifact = await p.createArtifact({
      type: 'input',
      producedByActionId: 'external',
      runId,
      content: { value: 1 },
      reusable: true,
      properties: {},
    });

    const action = await p.planAction(runId, {
      type: 'step',
      actionKind: 'ToolCall',
      runId,
      effectful: false,
      declared: {
        inputs: [{ objectId: artifact.id }],
      },
      agentId,
      properties: {},
    });

    const deps = await p.getRelations('DEPENDS_ON', action.id);
    expect(deps).toHaveLength(1);
    expect(deps[0].to).toBe(artifact.id);
  });

  it('planAction creates PART_OF and PERFORMED_BY relations', async () => {
    const action = await p.planAction(runId, {
      type: 'step',
      actionKind: 'Decision',
      runId,
      effectful: false,
      declared: { inputs: [] },
      agentId,
      properties: {},
    });

    const partOf = await p.getRelations('PART_OF', action.id);
    expect(partOf).toHaveLength(1);
    expect(partOf[0].to).toBe(runId);

    const performedBy = await p.getRelations('PERFORMED_BY', action.id);
    expect(performedBy).toHaveLength(1);
    expect(performedBy[0].to).toBe(agentId);
  });

  it('shared reusable artifact referenced by two runs resolves to same id', async () => {
    const run2 = await p.createRun(agentId);

    const art1 = await p.createArtifact({
      type: 'shared',
      producedByActionId: 'ext',
      runId,
      content: { shared: true },
      reusable: true,
      properties: {},
    });

    const art2 = await p.createArtifact({
      type: 'shared',
      producedByActionId: 'ext',
      runId,
      content: { shared: true },
      reusable: true,
      properties: {},
    });

    expect(art1.id).toBe(art2.id);
  });
});
