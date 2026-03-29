import { describe, it, expect, beforeEach } from 'vitest';
import { Parallax } from '../src/parallax.js';
import { runAgentLoop } from '../src/loop.js';
import type { AgentLoopDriver } from '../src/loop.js';
import type { LLMAdapter } from '../src/llm.js';
import type { ParallaxTool } from '../src/tool.js';

describe('AgentLoop', () => {
  let p: Parallax;
  let agentId: string;
  let runId: string;
  let llmCallCount: number;
  let toolCallCount: number;

  const mockAdapter: LLMAdapter = {
    generate: async (input) => {
      llmCallCount++;
      return {
        output: `Response to: ${input.prompt}`,
        usage: { input: 100, output: 50 },
      };
    },
  };

  const mockWeatherTool: ParallaxTool = {
    name: 'fetch_weather',
    description: 'Fetch current weather',
    effectful: true,
    execute: async (input) => {
      toolCallCount++;
      return { location: input.location as string, tempC: 22, conditions: 'sunny' };
    },
  };

  beforeEach(async () => {
    llmCallCount = 0;
    toolCallCount = 0;
    p = new Parallax();
    p.registerLLM(mockAdapter);
    p.registerTool(mockWeatherTool);
    const agent = await p.createAgent({ type: 'Agent', properties: {} });
    agentId = agent.id;
    const run = await p.createRun(agentId);
    runId = run.id;
  });

  it('loop stops immediately when driver returns stop', async () => {
    const driver: AgentLoopDriver = async () => ({
      type: 'stop',
      reason: 'nothing to do',
    });

    const result = await runAgentLoop(p, runId, { driver });

    expect(result.stoppedBy).toBe('driver');
    expect(result.iterations).toBe(1);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].type).toBe('stop');
    if (result.steps[0].type === 'stop') {
      expect(result.steps[0].reason).toBe('nothing to do');
    }
  });

  it('loop executes model decisions', async () => {
    let iteration = 0;
    const driver: AgentLoopDriver = async () => {
      if (iteration++ < 2) {
        return {
          type: 'model',
          reason: `step ${iteration}`,
          model: {
            model: 'test-model',
            prompt: `Step ${iteration}`,
            agentId,
          },
        };
      }
      return { type: 'stop', reason: 'done' };
    };

    const result = await runAgentLoop(p, runId, { driver });

    expect(result.stoppedBy).toBe('driver');
    expect(result.iterations).toBe(3);
    expect(llmCallCount).toBe(2);
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0].type).toBe('model');
    expect(result.steps[1].type).toBe('model');
    expect(result.steps[2].type).toBe('stop');
  });

  it('loop executes tool decisions', async () => {
    let iteration = 0;
    const driver: AgentLoopDriver = async () => {
      if (iteration++ < 1) {
        return {
          type: 'tool',
          reason: 'fetch weather data',
          tool: {
            type: 'fetch-weather',
            toolName: 'fetch_weather',
            toolInput: { location: 'Seattle' },
            declared: { inputs: [], intendedEffect: 'Fetch weather' },
            agentId,
          },
        };
      }
      return { type: 'stop' };
    };

    const result = await runAgentLoop(p, runId, { driver });

    expect(result.stoppedBy).toBe('driver');
    expect(toolCallCount).toBe(1);
    expect(result.steps[0].type).toBe('tool');
    if (result.steps[0].type === 'tool') {
      expect(result.steps[0].result.output).toEqual({
        location: 'Seattle',
        tempC: 22,
        conditions: 'sunny',
      });
    }
  });

  it('loop mixes model and tool actions in one run', async () => {
    const sequence: Array<'tool' | 'model' | 'stop'> = ['tool', 'model', 'tool', 'stop'];
    let step = 0;

    const driver: AgentLoopDriver = async () => {
      const type = sequence[step++];
      if (type === 'tool') {
        return {
          type: 'tool',
          tool: {
            type: 'fetch-weather',
            toolName: 'fetch_weather',
            toolInput: { location: `Location-${step}` },
            declared: { inputs: [] },
            agentId,
          },
        };
      }
      if (type === 'model') {
        return {
          type: 'model',
          model: { model: 'test-model', prompt: `Analyze step ${step}`, agentId },
        };
      }
      return { type: 'stop' };
    };

    const result = await runAgentLoop(p, runId, { driver });

    expect(result.iterations).toBe(4);
    expect(result.steps.map((s) => s.type)).toEqual(['tool', 'model', 'tool', 'stop']);
    expect(toolCallCount).toBe(2);
    expect(llmCallCount).toBe(1);
  });

  it('loop enforces maxIterations', async () => {
    // Driver that never stops
    const driver: AgentLoopDriver = async ({ iteration }) => ({
      type: 'model',
      model: { model: 'test-model', prompt: `Iteration ${iteration}`, agentId },
    });

    const result = await runAgentLoop(p, runId, { driver, maxIterations: 3 });

    expect(result.stoppedBy).toBe('maxIterations');
    expect(result.iterations).toBe(3);
    expect(llmCallCount).toBe(3);
    expect(result.steps).toHaveLength(3);
  });

  it('loop-created actions carry iteration metadata', async () => {
    let iteration = 0;
    const driver: AgentLoopDriver = async () => {
      if (iteration++ < 2) {
        return {
          type: 'tool',
          reason: `reason-${iteration}`,
          tool: {
            type: 'fetch-weather',
            toolName: 'fetch_weather',
            toolInput: { location: `City-${iteration}` },
            declared: { inputs: [] },
            agentId,
          },
        };
      }
      return { type: 'stop' };
    };

    await runAgentLoop(p, runId, { driver });

    const actions = await p.actions.forRun(runId);
    // Filter to only loop-created actions (those with loopIteration metadata)
    const loopActions = actions.filter((a) => a.properties.loopIteration !== undefined);
    expect(loopActions).toHaveLength(2);

    expect(loopActions[0].properties.loopIteration).toBe(0);
    expect(loopActions[0].properties.loopReason).toBe('reason-1');

    expect(loopActions[1].properties.loopIteration).toBe(1);
    expect(loopActions[1].properties.loopReason).toBe('reason-2');
  });

  it('loop-created actions are attached to the run', async () => {
    const driver: AgentLoopDriver = async ({ iteration }) => {
      if (iteration < 2) {
        return {
          type: 'model',
          model: { model: 'test-model', prompt: `Step ${iteration}`, agentId },
        };
      }
      return { type: 'stop' };
    };

    const result = await runAgentLoop(p, runId, { driver });

    const run = result.run;
    // Each model action produces 1 action with artifacts
    expect(run.actionIds.length).toBe(2);
    expect(run.artifactIds.length).toBeGreaterThan(0);
  });

  it('driver receives updated state each iteration', async () => {
    const observedIterations: number[] = [];
    const observedActionCounts: number[] = [];
    const observedArtifactCounts: number[] = [];

    const driver: AgentLoopDriver = async ({ iteration, actions, artifacts }) => {
      observedIterations.push(iteration);
      observedActionCounts.push(actions.length);
      observedArtifactCounts.push(artifacts.length);

      if (iteration < 2) {
        return {
          type: 'tool',
          tool: {
            type: 'fetch-weather',
            toolName: 'fetch_weather',
            toolInput: { location: 'Test' },
            declared: { inputs: [] },
            agentId,
          },
        };
      }
      return { type: 'stop' };
    };

    await runAgentLoop(p, runId, { driver });

    expect(observedIterations).toEqual([0, 1, 2]);
    // Actions accumulate: 0 before first, 1 after first tool, 2 after second
    expect(observedActionCounts).toEqual([0, 1, 2]);
    // Each tool action produces 2 artifacts (tool-request + tool-result)
    expect(observedArtifactCounts).toEqual([0, 2, 4]);
  });

  it('throws when model decision has no model opts', async () => {
    const driver: AgentLoopDriver = async () => ({
      type: 'model',
    });

    await expect(runAgentLoop(p, runId, { driver })).rejects.toThrow(
      "decision type is 'model' but no model opts provided",
    );
  });

  it('throws when tool decision has no tool opts', async () => {
    const driver: AgentLoopDriver = async () => ({
      type: 'tool',
    });

    await expect(runAgentLoop(p, runId, { driver })).rejects.toThrow(
      "decision type is 'tool' but no tool opts provided",
    );
  });

  it('replay works on runs produced by runAgentLoop', async () => {
    let iteration = 0;
    const driver: AgentLoopDriver = async () => {
      if (iteration++ < 2) {
        return {
          type: 'tool',
          tool: {
            type: 'fetch-weather',
            toolName: 'fetch_weather',
            toolInput: { location: 'Denver' },
            declared: { inputs: [] },
            agentId,
          },
        };
      }
      return { type: 'stop' };
    };

    const loopResult = await runAgentLoop(p, runId, { driver });
    expect(toolCallCount).toBe(2);

    // Replay the run — effectful tools should not re-execute
    const replayed = await p.replayRun(runId);

    expect(toolCallCount).toBe(2); // No additional calls
    const replayedActions = await p.actions.forRun(replayed.id);
    const originalActions = await p.actions.forRun(runId);
    expect(replayedActions).toHaveLength(originalActions.length);
  });

  it('loop with maxIterations=0 returns immediately', async () => {
    let driverCalled = false;
    const driver: AgentLoopDriver = async () => {
      driverCalled = true;
      return { type: 'stop' };
    };

    const result = await runAgentLoop(p, runId, { driver, maxIterations: 0 });

    expect(driverCalled).toBe(false);
    expect(result.stoppedBy).toBe('maxIterations');
    expect(result.iterations).toBe(0);
    expect(result.steps).toHaveLength(0);
  });

  it('throws when maxIterations is negative', async () => {
    const driver: AgentLoopDriver = async () => ({ type: 'stop' });

    await expect(runAgentLoop(p, runId, { driver, maxIterations: -1 })).rejects.toThrow(
      'runAgentLoop requires maxIterations to be a non-negative integer',
    );
  });

  it('throws when maxIterations is not an integer', async () => {
    const driver: AgentLoopDriver = async () => ({ type: 'stop' });

    await expect(
      runAgentLoop(p, runId, { driver, maxIterations: 1.5 }),
    ).rejects.toThrow('runAgentLoop requires maxIterations to be a non-negative integer');
  });
});
