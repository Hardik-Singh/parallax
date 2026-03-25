import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Parallax } from '../src/parallax.js';
import type { ActionExecutor } from '../src/types.js';

describe('caching', () => {
  let p: Parallax;
  let agentId: string;
  let runId: string;
  let executionCount: number;

  const countingExecutor: ActionExecutor = {
    canExecute: () => true,
    execute: async () => {
      executionCount++;
      return {
        outputs: { result: 'computed' },
        producedArtifacts: [
          {
            type: 'output',
            content: { result: 'computed' },
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
    p.registerExecutor('ToolCall', countingExecutor);
    const agent = await p.createAgent({ type: 'Agent', properties: {} });
    agentId = agent.id;
    const run = await p.createRun(agentId);
    runId = run.id;
  });

  it('pure action cache hit skips re-execution', async () => {
    // First execution
    const action1 = await p.planAction(runId, {
      type: 'step',
      actionKind: 'ToolCall',
      runId,
      effectful: false,
      declared: { inputs: [] },
      agentId,
      properties: { task: 'compute' },
    });
    await p.executeAction(action1.id);
    expect(executionCount).toBe(1);

    // Create a second run with identical action
    const run2 = await p.createRun(agentId);
    const action2 = await p.planAction(run2.id, {
      type: 'step',
      actionKind: 'ToolCall',
      runId: run2.id,
      effectful: false,
      declared: { inputs: [] },
      agentId,
      properties: { task: 'compute' },
    });
    const result = await p.executeAction(action2.id);

    // Should have been a cache hit — executor not called again
    expect(executionCount).toBe(1);
    expect(result.observed!.cacheHit).toBe(true);
  });

  it('changed upstream dependency invalidates cache', async () => {
    const inputArt = await p.createArtifact({
      type: 'input',
      producedByActionId: 'ext',
      runId,
      content: { value: 1 },
      reusable: true,
      properties: {},
    });

    const action1 = await p.planAction(runId, {
      type: 'step',
      actionKind: 'ToolCall',
      runId,
      effectful: false,
      declared: { inputs: [{ objectId: inputArt.id }] },
      agentId,
      properties: {},
    });
    await p.executeAction(action1.id);
    expect(executionCount).toBe(1);

    // Different input artifact (different content = different id)
    const run2 = await p.createRun(agentId);
    const inputArt2 = await p.createArtifact({
      type: 'input',
      producedByActionId: 'ext',
      runId: run2.id,
      content: { value: 999 },
      reusable: true,
      properties: {},
    });

    const action2 = await p.planAction(run2.id, {
      type: 'step',
      actionKind: 'ToolCall',
      runId: run2.id,
      effectful: false,
      declared: { inputs: [{ objectId: inputArt2.id }] },
      agentId,
      properties: {},
    });
    await p.executeAction(action2.id);

    // Different dependency = cache miss = executor called
    expect(executionCount).toBe(2);
  });
});
