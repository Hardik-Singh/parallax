import { describe, it, expect, beforeEach } from 'vitest';
import { Parallax } from '../src/parallax.js';
import type { ActionExecutor, ActionObject } from '../src/types.js';

describe('action execution', () => {
  let p: Parallax;
  let agentId: string;
  let runId: string;

  const simpleExecutor: ActionExecutor = {
    canExecute: () => true,
    execute: async (_action, context) => ({
      outputs: { result: 'done', input: context },
      producedArtifacts: [
        {
          type: 'output',
          content: { result: 'done' },
          reusable: true,
          properties: {},
        },
      ],
    }),
  };

  beforeEach(async () => {
    p = new Parallax();
    p.registerExecutor('ToolCall', simpleExecutor);
    const agent = await p.createAgent({ type: 'Agent', properties: {} });
    agentId = agent.id;
    const run = await p.createRun(agentId);
    runId = run.id;
  });

  it('action execution produces observed state and artifacts', async () => {
    const action = await p.planAction(runId, {
      type: 'step',
      actionKind: 'ToolCall',
      runId,
      effectful: false,
      declared: { inputs: [] },
      agentId,
      properties: {},
    });

    const executed = await p.executeAction(action.id);
    expect(executed.status).toBe('completed');
    expect(executed.observed).toBeDefined();
    expect(executed.observed!.status).toBe('completed');
    expect(executed.observed!.producedArtifactIds).toHaveLength(1);
    expect(executed.observed!.cacheHit).toBe(false);

    // Artifact is linked to the run
    const run = await p.getRun(runId);
    expect(run.artifactIds).toHaveLength(1);

    // PRODUCED relation exists
    const produced = await p.getRelations('PRODUCED', action.id);
    expect(produced).toHaveLength(1);
  });

  it('events fire during execution', async () => {
    const events: string[] = [];
    p.on('action:started', () => events.push('started'));
    p.on('action:completed', () => events.push('completed'));

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
    expect(events).toEqual(['started', 'completed']);
  });
});
