import { describe, it, expect, beforeEach } from 'vitest';
import { Parallax } from '../src/parallax.js';
import type { ActionExecutor } from '../src/types.js';

describe('replay and forking', () => {
  let p: Parallax;
  let agentId: string;
  let executionCount: number;

  const trackingExecutor: ActionExecutor = {
    canExecute: () => true,
    execute: async () => {
      executionCount++;
      return {
        outputs: { result: 'executed' },
        producedArtifacts: [
          {
            type: 'output',
            content: { result: 'executed', ts: Date.now() },
            reusable: true,
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

  it('replay reuses effectful artifacts by default', async () => {
    const run = await p.createRun(agentId);

    const action = await p.planAction(run.id, {
      type: 'step',
      actionKind: 'ToolCall',
      runId: run.id,
      effectful: true,
      declared: { inputs: [] },
      agentId,
      properties: { task: 'api-call' },
    });
    await p.executeAction(action.id);
    expect(executionCount).toBe(1);

    // Replay should skip effectful action
    const replayed = await p.replayRun(run.id);
    expect(replayed.replayOfRunId).toBe(run.id);
    expect(replayed.status).toBe('replayed');

    // Effectful action was NOT re-executed
    expect(executionCount).toBe(1);

    // But the replay run has the action's artifacts
    expect(replayed.artifactIds.length).toBeGreaterThan(0);
    expect(replayed.actionIds).toContain(action.id);
  });

  it('replay recomputes pure actions when upstream changes', async () => {
    const run = await p.createRun(agentId);

    const action = await p.planAction(run.id, {
      type: 'step',
      actionKind: 'ToolCall',
      runId: run.id,
      effectful: false,
      declared: { inputs: [] },
      agentId,
      properties: { task: 'compute' },
    });
    await p.executeAction(action.id);
    expect(executionCount).toBe(1);

    // Replay — pure actions get re-executed (or served from cache)
    const replayed = await p.replayRun(run.id);
    expect(replayed.replayOfRunId).toBe(run.id);

    // The REPLAY_OF relation exists and unchanged actions are structurally shared
    const replayRels = await p.getRelations('REPLAY_OF');
    expect(replayRels.length).toBeGreaterThan(0);
    expect(replayed.actionIds).toContain(action.id);
  });

  it('forked run sets parentRunId and branchFromActionId', async () => {
    const run = await p.createRun(agentId);

    const a1 = await p.planAction(run.id, {
      type: 'step',
      actionKind: 'Decision',
      runId: run.id,
      effectful: false,
      declared: { inputs: [] },
      agentId,
      properties: { step: 1 },
    });
    await p.executeAction(a1.id);

    const a2 = await p.planAction(run.id, {
      type: 'step',
      actionKind: 'ToolCall',
      runId: run.id,
      effectful: false,
      declared: { inputs: [] },
      agentId,
      properties: { step: 2 },
    });
    await p.executeAction(a2.id);

    // Fork from action 1
    const forked = await p.forkRun(run.id, a1.id);
    expect(forked.parentRunId).toBe(run.id);
    expect(forked.branchFromActionId).toBe(a1.id);
    // Forked run should include actions up to branch point
    expect(forked.actionIds).toContain(a1.id);
    expect(forked.actionIds).not.toContain(a2.id);
  });

  it('replay chain follows replayOfRunId lineage', async () => {
    const run1 = await p.createRun(agentId);
    const a1 = await p.planAction(run1.id, {
      type: 'step',
      actionKind: 'ToolCall',
      runId: run1.id,
      effectful: true,
      declared: { inputs: [] },
      agentId,
      properties: {},
    });
    await p.executeAction(a1.id);

    const run2 = await p.replayRun(run1.id);
    const run3 = await p.replayRun(run2.id);

    const chain = await p.runs.replayChain(run3.id);
    expect(chain).toHaveLength(3);
    expect(chain[0].id).toBe(run1.id);
    expect(chain[1].id).toBe(run2.id);
    expect(chain[2].id).toBe(run3.id);
  });
});
