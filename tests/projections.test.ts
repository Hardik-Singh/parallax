import { describe, it, expect, beforeEach } from 'vitest';
import { Parallax } from '../src/parallax.js';
import type { ActionExecutor } from '../src/types.js';

describe('graph projections', () => {
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

  it('getDependencyGraph returns only DEPENDS_ON relations', async () => {
    const art = await p.createArtifact({
      type: 'input',
      producedByActionId: 'ext',
      runId,
      content: { v: 1 },
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

    const depGraph = await p.getDependencyGraph(runId);
    for (const rel of depGraph.relations) {
      expect(rel.type).toBe('DEPENDS_ON');
    }
    expect(depGraph.relations.length).toBeGreaterThan(0);
  });

  it('getExecutionGraph returns only CAUSED, CONSUMED, PRODUCED relations', async () => {
    const art = await p.createArtifact({
      type: 'input',
      producedByActionId: 'ext',
      runId,
      content: { v: 1 },
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

    const execGraph = await p.getExecutionGraph(runId);
    const allowedTypes = new Set(['CAUSED', 'CONSUMED', 'PRODUCED']);
    for (const rel of execGraph.relations) {
      expect(allowedTypes.has(rel.type)).toBe(true);
    }
    // Should have at least CONSUMED and PRODUCED
    expect(execGraph.relations.length).toBeGreaterThanOrEqual(2);
  });

  it('execution graph includes CAUSED relation between producer and consumer actions', async () => {
    const producer = await p.planAction(runId, {
      type: 'produce',
      actionKind: 'ToolCall',
      runId,
      effectful: false,
      declared: { inputs: [] },
      agentId,
      properties: {},
    });
    await p.executeAction(producer.id);

    const run = await p.getRun(runId);
    const producedArtifactId = run.artifactIds[0];

    const consumer = await p.planAction(runId, {
      type: 'consume',
      actionKind: 'ToolCall',
      runId,
      effectful: false,
      declared: { inputs: [{ objectId: producedArtifactId }] },
      agentId,
      properties: {},
    });
    await p.executeAction(consumer.id);

    const execGraph = await p.getExecutionGraph(runId);
    expect(
      execGraph.relations.some(
        (rel) => rel.type === 'CAUSED' && rel.from === producer.id && rel.to === consumer.id,
      ),
    ).toBe(true);
  });
});
