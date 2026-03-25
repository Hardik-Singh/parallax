import { describe, it, expect, beforeEach } from 'vitest';
import { Parallax } from '../src/parallax.js';
import type { ActionExecutor } from '../src/types.js';

describe('operational query APIs', () => {
  let p: Parallax;
  let agentId: string;
  let runId: string;

  const executor: ActionExecutor = {
    canExecute: () => true,
    execute: async () => ({
      outputs: { result: 'done' },
      producedArtifacts: [
        {
          type: 'output',
          content: { data: 1 },
          reusable: true,
          properties: {},
        },
      ],
    }),
  };

  beforeEach(async () => {
    p = new Parallax();
    p.registerExecutor('ToolCall', executor);
    const agent = await p.createAgent({ type: 'Agent', properties: {} });
    agentId = agent.id;
    const run = await p.createRun(agentId);
    runId = run.id;
  });

  it('actions.forRun returns actions in a run', async () => {
    await p.planAction(runId, {
      type: 'step',
      actionKind: 'ToolCall',
      runId,
      effectful: false,
      declared: { inputs: [] },
      agentId,
      properties: { n: 1 },
    });
    await p.planAction(runId, {
      type: 'step',
      actionKind: 'ToolCall',
      runId,
      effectful: false,
      declared: { inputs: [] },
      agentId,
      properties: { n: 2 },
    });

    const actions = await p.actions.forRun(runId);
    expect(actions).toHaveLength(2);
    expect(actions[0].kind).toBe('Action');
  });

  it('actions.forAgent returns actions by agent', async () => {
    await p.planAction(runId, {
      type: 'step',
      actionKind: 'ToolCall',
      runId,
      effectful: false,
      declared: { inputs: [] },
      agentId,
      properties: {},
    });

    const actions = await p.actions.forAgent(agentId);
    expect(actions.length).toBeGreaterThanOrEqual(1);
  });

  it('actions.thatProduced and thatConsumed work with artifacts', async () => {
    const art = await p.createArtifact({
      type: 'input',
      producedByActionId: 'ext',
      runId,
      content: { x: 1 },
      reusable: true,
      properties: {},
    });

    const action = await p.planAction(runId, {
      type: 'step',
      actionKind: 'ToolCall',
      runId,
      effectful: false,
      declared: { inputs: [{ objectId: art.id }] },
      agentId,
      properties: {},
    });

    await p.executeAction(action.id);

    const consumed = await p.actions.thatConsumed(art.id);
    expect(consumed.length).toBeGreaterThanOrEqual(1);

    const run = await p.getRun(runId);
    const producedArtifactId = run.artifactIds.find((id) => id !== art.id);
    if (producedArtifactId) {
      const produced = await p.actions.thatProduced(producedArtifactId);
      expect(produced.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('artifacts.forRun returns artifacts in a run', async () => {
    const action = await p.planAction(runId, {
      type: 'step',
      actionKind: 'ToolCall',
      runId,
      effectful: false,
      declared: { inputs: [] },
      agentId,
      properties: {},
    });
    await p.executeAction(action.id);

    const arts = await p.artifacts.forRun(runId);
    expect(arts.length).toBeGreaterThanOrEqual(1);
    expect(arts[0].kind).toBe('Artifact');
  });

  it('reusable artifacts are shared across runs by content', async () => {
    const shared = await p.createArtifact({
      type: 'input',
      producedByActionId: 'ext',
      runId,
      content: { shared: true },
      reusable: true,
      properties: {},
    });

    const run2 = await p.createRun(agentId);
    const sharedAgain = await p.createArtifact({
      type: 'input',
      producedByActionId: 'other-ext',
      runId: run2.id,
      content: { shared: true },
      reusable: true,
      properties: {},
    });

    expect(sharedAgain.id).toBe(shared.id);

    const sharedAcrossRuns = await p.artifacts.sharedAcrossRuns();
    expect(sharedAcrossRuns.some((artifact) => artifact.id === shared.id)).toBe(true);
  });

  it('runs.forAgent returns runs by agent', async () => {
    const runs = await p.runs.forAgent(agentId);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0].agentId).toBe(agentId);
  });
});
