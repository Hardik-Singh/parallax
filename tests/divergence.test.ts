import { describe, it, expect, beforeEach } from 'vitest';
import { Parallax } from '../src/parallax.js';
import type { ActionExecutor, ActionObject } from '../src/types.js';

describe('divergence detection', () => {
  let p: Parallax;
  let agentId: string;
  let agent2Id: string;

  beforeEach(async () => {
    p = new Parallax();
    const agent = await p.createAgent({ type: 'Agent', properties: { name: 'main' } });
    agentId = agent.id;
    const agent2 = await p.createAgent({ type: 'Agent', properties: { name: 'other' } });
    agent2Id = agent2.id;
  });

  it('undeclared input consumed is detected', async () => {
    const run = await p.createRun(agentId);

    const artifact = await p.createArtifact({
      type: 'data',
      producedByActionId: 'ext',
      runId: run.id,
      content: { secret: true },
      reusable: false,
      properties: {},
    });

    // Plan action with no declared inputs
    const action = await p.planAction(run.id, {
      type: 'step',
      actionKind: 'ToolCall',
      runId: run.id,
      effectful: false,
      declared: { inputs: [] },
      agentId,
      properties: {},
    });

    // Manually simulate observed state where it consumed an undeclared input
    const obj = await p.findByHash(action.id) as ActionObject;
    obj.observed = {
      consumedInputIds: [artifact.id],
      producedArtifactIds: [],
      status: 'completed',
    };
    // Force update (we're testing divergence detection, not execution)
    await (p as any).store.putObject(obj);

    const div = await p.getDivergence(run.id);
    expect(div.events.some((e) => e.type === 'undeclared_input_consumed')).toBe(true);
  });

  it('declared input never observed is detected', async () => {
    const run = await p.createRun(agentId);

    const artifact = await p.createArtifact({
      type: 'data',
      producedByActionId: 'ext',
      runId: run.id,
      content: { data: 1 },
      reusable: false,
      properties: {},
    });

    const action = await p.planAction(run.id, {
      type: 'step',
      actionKind: 'ToolCall',
      runId: run.id,
      effectful: false,
      declared: { inputs: [{ objectId: artifact.id }] },
      agentId,
      properties: {},
    });

    // Simulate execution that didn't consume declared input
    const obj = await p.findByHash(action.id) as ActionObject;
    obj.observed = {
      consumedInputIds: [],
      producedArtifactIds: [],
      status: 'completed',
    };
    await (p as any).store.putObject(obj);

    const div = await p.getDivergence(run.id);
    expect(div.events.some((e) => e.type === 'declared_input_never_observed')).toBe(true);
  });

  it('agent attribution mismatch is detected', async () => {
    const run = await p.createRun(agentId);

    // Create action attributed to a different agent
    const action = await p.planAction(run.id, {
      type: 'step',
      actionKind: 'ToolCall',
      runId: run.id,
      effectful: false,
      declared: { inputs: [] },
      agentId: agent2Id, // different agent!
      properties: {},
    });

    // Simulate observed state
    const obj = await p.findByHash(action.id) as ActionObject;
    obj.observed = {
      consumedInputIds: [],
      producedArtifactIds: [],
      status: 'completed',
    };
    await (p as any).store.putObject(obj);

    const div = await p.getDivergence(run.id);
    expect(div.events.some((e) => e.type === 'agent_attribution_mismatch')).toBe(true);
  });

  it('run shape divergence is detected across two runs', async () => {
    const run1 = await p.createRun(agentId);
    const run2 = await p.createRun(agentId);

    // Run 1 has 2 actions
    await p.planAction(run1.id, {
      type: 'step',
      actionKind: 'Decision',
      runId: run1.id,
      effectful: false,
      declared: { inputs: [] },
      agentId,
      properties: { step: 1 },
    });
    await p.planAction(run1.id, {
      type: 'step',
      actionKind: 'ToolCall',
      runId: run1.id,
      effectful: false,
      declared: { inputs: [] },
      agentId,
      properties: { step: 2 },
    });

    // Run 2 has 1 action
    await p.planAction(run2.id, {
      type: 'step',
      actionKind: 'Decision',
      runId: run2.id,
      effectful: false,
      declared: { inputs: [] },
      agentId,
      properties: { step: 1 },
    });

    const diff = await p.diffRuns(run1.id, run2.id);
    expect(diff.kind).toBe('DivergenceRecord');
    expect(diff.runId).toBe(run1.id);
    expect(diff.comparedRunId).toBe(run2.id);
    expect(diff.events.some((e) => e.type === 'run_shape_divergence')).toBe(true);
  });

  it('diffRuns returns a valid DivergenceRecord', async () => {
    const run1 = await p.createRun(agentId);
    const run2 = await p.createRun(agentId);

    const diff = await p.diffRuns(run1.id, run2.id);
    expect(diff.kind).toBe('DivergenceRecord');
    expect(diff.id).toBeDefined();
    expect(diff.runId).toBe(run1.id);
    expect(diff.comparedRunId).toBe(run2.id);
    expect(Array.isArray(diff.events)).toBe(true);
    expect(typeof diff.summary).toBe('string');
  });
});
