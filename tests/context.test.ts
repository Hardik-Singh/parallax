import { describe, it, expect, beforeEach } from 'vitest';
import { Parallax } from '../src/parallax.js';

describe('scoped context', () => {
  let p: Parallax;
  let agentId: string;
  let runId: string;

  beforeEach(async () => {
    p = new Parallax();
    const agent = await p.createAgent({ type: 'Agent', properties: {} });
    agentId = agent.id;
    const run = await p.createRun(agentId);
    runId = run.id;
  });

  it('getScopedContext respects select', async () => {
    const artifact = await p.createArtifact({
      type: 'input',
      producedByActionId: 'ext',
      runId,
      content: { x: 1, y: 2, z: 3 },
      reusable: true,
      properties: {},
    });

    const action = await p.planAction(runId, {
      type: 'step',
      actionKind: 'ToolCall',
      runId,
      effectful: false,
      declared: {
        inputs: [{ objectId: artifact.id, select: ['x', 'z'] }],
      },
      agentId,
      properties: {},
    });

    const ctx = await p.getScopedContext(action.id);
    expect(ctx).toEqual({ x: 1, z: 3 });
    expect(ctx).not.toHaveProperty('y');
  });

  it('getScopedContext respects alias', async () => {
    const artifact = await p.createArtifact({
      type: 'input',
      producedByActionId: 'ext',
      runId,
      content: { x: 1, y: 2 },
      reusable: true,
      properties: {},
    });

    const action = await p.planAction(runId, {
      type: 'step',
      actionKind: 'ToolCall',
      runId,
      effectful: false,
      declared: {
        inputs: [{ objectId: artifact.id, alias: 'myInput' }],
      },
      agentId,
      properties: {},
    });

    const ctx = await p.getScopedContext(action.id);
    expect(ctx).toEqual({ myInput: { x: 1, y: 2 } });
  });

  it('getScopedContext throws on key collision', async () => {
    const art1 = await p.createArtifact({
      type: 'input',
      producedByActionId: 'ext',
      runId,
      content: { x: 1 },
      reusable: true,
      properties: {},
    });

    const art2 = await p.createArtifact({
      type: 'input',
      producedByActionId: 'ext2',
      runId,
      content: { x: 2 },
      reusable: true,
      properties: {},
    });

    const action = await p.planAction(runId, {
      type: 'step',
      actionKind: 'ToolCall',
      runId,
      effectful: false,
      declared: {
        inputs: [
          { objectId: art1.id },
          { objectId: art2.id },
        ],
      },
      agentId,
      properties: {},
    });

    await expect(p.getScopedContext(action.id)).rejects.toThrow(/collision/i);
  });
});
