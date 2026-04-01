import { describe, it, expect, beforeEach } from 'vitest';
import { Parallax } from '../src/parallax.js';
import type { ActionExecutor, ArtifactObject } from '../src/types.js';

describe('checkpoints, branching, and selective replay', () => {
  let p: Parallax;
  let agentId: string;
  let executionCount: number;

  const trackingExecutor: ActionExecutor = {
    canExecute: () => true,
    execute: async (_action, context) => {
      executionCount++;
      return {
        outputs: { result: 'executed', input: context },
        producedArtifacts: [
          {
            type: 'output',
            content: { result: 'executed', ts: Date.now() },
            reusable: false,
            properties: {},
          },
        ],
      };
    },
  };

  beforeEach(async () => {
    executionCount = 0;
    p = new Parallax();
    p.registerExecutor('ToolCall', trackingExecutor);
    p.registerExecutor('Decision', trackingExecutor);
    const agent = await p.createAgent({ type: 'Agent', properties: {} });
    agentId = agent.id;
  });

  // ---------------------------------------------------------------------------
  // Checkpoint CRUD
  // ---------------------------------------------------------------------------

  it('createCheckpoint at latest action', async () => {
    const run = await p.createRun(agentId);

    const a1 = await p.planAction(run.id, {
      type: 'fetch',
      actionKind: 'ToolCall',
      runId: run.id,
      effectful: true,
      declared: { inputs: [] },
      agentId,
      properties: {},
    });
    await p.executeAction(a1.id);

    const a2 = await p.planAction(run.id, {
      type: 'analyze',
      actionKind: 'Decision',
      runId: run.id,
      effectful: false,
      declared: { inputs: [] },
      agentId,
      properties: {},
    });
    await p.executeAction(a2.id);

    const cp = await p.createCheckpoint(run.id, { name: 'analysis-done' });

    expect(cp.type).toBe('checkpoint');
    expect(cp.kind).toBe('Artifact');
    expect((cp.content as Record<string, unknown>).name).toBe('analysis-done');
    expect((cp.content as Record<string, unknown>).actionId).toBe(a2.id);
    expect((cp.content as Record<string, unknown>).artifactIds).toBeDefined();
  });

  it('createCheckpoint with explicit actionId', async () => {
    const run = await p.createRun(agentId);

    const a1 = await p.planAction(run.id, {
      type: 'fetch',
      actionKind: 'ToolCall',
      runId: run.id,
      effectful: true,
      declared: { inputs: [] },
      agentId,
      properties: {},
    });
    await p.executeAction(a1.id);

    const a2 = await p.planAction(run.id, {
      type: 'analyze',
      actionKind: 'Decision',
      runId: run.id,
      effectful: false,
      declared: { inputs: [] },
      agentId,
      properties: {},
    });
    await p.executeAction(a2.id);

    const cp = await p.createCheckpoint(run.id, {
      name: 'after-fetch',
      actionId: a1.id,
    });

    expect((cp.content as Record<string, unknown>).actionId).toBe(a1.id);
    // Snapshot should only include artifacts from a1
    const snapshotIds = (cp.content as Record<string, unknown>).artifactIds as string[];
    expect(snapshotIds.length).toBeGreaterThan(0);
  });

  it('getCheckpoint retrieves by name', async () => {
    const run = await p.createRun(agentId);
    const a1 = await p.planAction(run.id, {
      type: 'step',
      actionKind: 'ToolCall',
      runId: run.id,
      effectful: false,
      declared: { inputs: [] },
      agentId,
      properties: {},
    });
    await p.executeAction(a1.id);

    await p.createCheckpoint(run.id, { name: 'my-cp' });

    const found = await p.getCheckpoint(run.id, 'my-cp');
    expect(found).toBeDefined();
    expect((found!.content as Record<string, unknown>).name).toBe('my-cp');

    const notFound = await p.getCheckpoint(run.id, 'nonexistent');
    expect(notFound).toBeUndefined();
  });

  it('listCheckpoints returns all checkpoints for a run', async () => {
    const run = await p.createRun(agentId);
    const a1 = await p.planAction(run.id, {
      type: 'step',
      actionKind: 'ToolCall',
      runId: run.id,
      effectful: false,
      declared: { inputs: [] },
      agentId,
      properties: {},
    });
    await p.executeAction(a1.id);

    const a2 = await p.planAction(run.id, {
      type: 'step2',
      actionKind: 'Decision',
      runId: run.id,
      effectful: false,
      declared: { inputs: [] },
      agentId,
      properties: { n: 2 },
    });
    await p.executeAction(a2.id);

    await p.createCheckpoint(run.id, { name: 'cp-1', actionId: a1.id });
    await p.createCheckpoint(run.id, { name: 'cp-2', actionId: a2.id });

    const checkpoints = await p.listCheckpoints(run.id);
    expect(checkpoints).toHaveLength(2);
    const names = checkpoints.map(
      (c) => (c.content as Record<string, unknown>).name,
    );
    expect(names).toContain('cp-1');
    expect(names).toContain('cp-2');
  });

  // ---------------------------------------------------------------------------
  // Branching
  // ---------------------------------------------------------------------------

  it('branchFromCheckpoint shares prefix, excludes tail', async () => {
    const run = await p.createRun(agentId);

    const a1 = await p.planAction(run.id, {
      type: 'fetch',
      actionKind: 'ToolCall',
      runId: run.id,
      effectful: true,
      declared: { inputs: [] },
      agentId,
      properties: {},
    });
    await p.executeAction(a1.id);

    const a2 = await p.planAction(run.id, {
      type: 'analyze',
      actionKind: 'Decision',
      runId: run.id,
      effectful: false,
      declared: { inputs: [] },
      agentId,
      properties: {},
    });
    await p.executeAction(a2.id);

    const a3 = await p.planAction(run.id, {
      type: 'dispatch',
      actionKind: 'ToolCall',
      runId: run.id,
      effectful: true,
      declared: { inputs: [] },
      agentId,
      properties: { step: 3 },
    });
    await p.executeAction(a3.id);

    await p.createCheckpoint(run.id, { name: 'after-analyze', actionId: a2.id });

    const branch = await p.branchFromCheckpoint(run.id, 'after-analyze');
    expect(branch.parentRunId).toBe(run.id);
    expect(branch.branchFromActionId).toBe(a2.id);
    expect(branch.actionIds).toContain(a1.id);
    expect(branch.actionIds).toContain(a2.id);
    expect(branch.actionIds).not.toContain(a3.id);
  });

  // ---------------------------------------------------------------------------
  // Replay from checkpoint
  // ---------------------------------------------------------------------------

  it('replayFromCheckpoint shares prefix, re-executes tail', async () => {
    const run = await p.createRun(agentId);

    const a1 = await p.planAction(run.id, {
      type: 'fetch',
      actionKind: 'ToolCall',
      runId: run.id,
      effectful: true,
      declared: { inputs: [] },
      agentId,
      properties: {},
    });
    await p.executeAction(a1.id);

    const a2 = await p.planAction(run.id, {
      type: 'analyze',
      actionKind: 'Decision',
      runId: run.id,
      effectful: false,
      declared: { inputs: [] },
      agentId,
      properties: {},
      cachePolicy: 'recompute',
    });
    await p.executeAction(a2.id);

    await p.createCheckpoint(run.id, { name: 'after-fetch', actionId: a1.id });
    expect(executionCount).toBe(2);

    const replayed = await p.replayFromCheckpoint(run.id, 'after-fetch');

    // a1 was effectful -> structurally shared (not re-executed)
    // a2 was pure with recompute -> re-executed
    expect(executionCount).toBe(3);

    expect(replayed.status).toBe('replayed');
    expect(replayed.parentRunId).toBe(run.id);
    expect(replayed.branchFromActionId).toBe(a1.id);
    expect(replayed.replayOfRunId).toBe(run.id);

    // Prefix action is shared
    expect(replayed.actionIds).toContain(a1.id);
    // Tail action was replayed — new action in run
    expect(replayed.actionIds).not.toContain(a2.id);
    expect(replayed.actionIds.length).toBe(2);
  });

  it('replayFromAction shares prefix, re-executes tail', async () => {
    const run = await p.createRun(agentId);

    const a1 = await p.planAction(run.id, {
      type: 'fetch',
      actionKind: 'ToolCall',
      runId: run.id,
      effectful: true,
      declared: { inputs: [] },
      agentId,
      properties: {},
    });
    await p.executeAction(a1.id);

    const a2 = await p.planAction(run.id, {
      type: 'analyze',
      actionKind: 'Decision',
      runId: run.id,
      effectful: false,
      declared: { inputs: [] },
      agentId,
      properties: {},
      cachePolicy: 'recompute',
    });
    await p.executeAction(a2.id);

    const a3 = await p.planAction(run.id, {
      type: 'dispatch',
      actionKind: 'ToolCall',
      runId: run.id,
      effectful: false,
      declared: { inputs: [] },
      agentId,
      properties: { step: 3 },
      cachePolicy: 'recompute',
    });
    await p.executeAction(a3.id);

    expect(executionCount).toBe(3);

    const replayed = await p.replayFromAction(run.id, a1.id);

    // a1 shared, a2 + a3 re-executed
    expect(executionCount).toBe(5);
    expect(replayed.actionIds).toContain(a1.id);
    expect(replayed.actionIds).not.toContain(a2.id);
    expect(replayed.actionIds).not.toContain(a3.id);
    expect(replayed.actionIds.length).toBe(3);
  });

  it('effectful tail actions are structurally shared by default', async () => {
    const run = await p.createRun(agentId);

    const a1 = await p.planAction(run.id, {
      type: 'fetch',
      actionKind: 'ToolCall',
      runId: run.id,
      effectful: true,
      declared: { inputs: [] },
      agentId,
      properties: {},
    });
    await p.executeAction(a1.id);

    const a2 = await p.planAction(run.id, {
      type: 'deploy',
      actionKind: 'ToolCall',
      runId: run.id,
      effectful: true,
      declared: { inputs: [] },
      agentId,
      properties: { step: 2 },
    });
    await p.executeAction(a2.id);

    expect(executionCount).toBe(2);

    // Replay from a1 — a2 is effectful so should be shared, not re-executed
    const replayed = await p.replayFromAction(run.id, a1.id);
    expect(executionCount).toBe(2); // no new executions
    expect(replayed.actionIds).toContain(a1.id);
    expect(replayed.actionIds).toContain(a2.id); // structurally shared
  });

  it('diffRuns between original and replayed branch shows shape divergence', async () => {
    const run = await p.createRun(agentId);

    const a1 = await p.planAction(run.id, {
      type: 'fetch',
      actionKind: 'ToolCall',
      runId: run.id,
      effectful: true,
      declared: { inputs: [] },
      agentId,
      properties: {},
    });
    await p.executeAction(a1.id);

    const a2 = await p.planAction(run.id, {
      type: 'analyze',
      actionKind: 'Decision',
      runId: run.id,
      effectful: false,
      declared: { inputs: [] },
      agentId,
      properties: {},
      cachePolicy: 'recompute',
    });
    await p.executeAction(a2.id);

    await p.createCheckpoint(run.id, { name: 'cp', actionId: a1.id });
    const branch = await p.branchFromCheckpoint(run.id, 'cp');

    // Original has 2 actions, branch has 1
    const diff = await p.diffRuns(run.id, branch.id);
    expect(diff.events.some((e) => e.type === 'run_shape_divergence')).toBe(true);
  });
});
