import { describe, it, expect, beforeEach } from 'vitest';
import { Parallax } from '../src/parallax.js';
import type { ParallaxTool } from '../src/tool.js';

describe('ToolExecution', () => {
  let p: Parallax;
  let agentId: string;
  let runId: string;
  let fetchCallCount: number;

  const mockWeatherTool: ParallaxTool = {
    name: 'fetch_weather',
    description: 'Fetch current weather for a location',
    effectful: true,
    execute: async (input) => {
      fetchCallCount++;
      return {
        location: input.location as string,
        tempC: 22,
        conditions: 'sunny',
      };
    },
  };

  const mockAnalyzeTool: ParallaxTool = {
    name: 'analyze_conditions',
    description: 'Analyze weather conditions',
    effectful: false,
    execute: async (input) => {
      return {
        risk: 'low',
        summary: `Conditions at ${input.location ?? 'unknown'}: ${input.conditions ?? 'n/a'}`,
      };
    },
  };

  beforeEach(async () => {
    fetchCallCount = 0;
    p = new Parallax();
    p.registerTool(mockWeatherTool);
    p.registerTool(mockAnalyzeTool);
    const agent = await p.createAgent({ type: 'Agent', properties: {} });
    agentId = agent.id;
    const run = await p.createRun(agentId);
    runId = run.id;
  });

  it('registerTool makes tool available via getTool', () => {
    expect(p.getTool('fetch_weather')).toBeDefined();
    expect(p.getTool('fetch_weather')!.name).toBe('fetch_weather');
    expect(p.getTool('nonexistent')).toBeUndefined();
  });

  it('createToolAction creates a valid ToolCall action', async () => {
    const action = await p.createToolAction(runId, {
      type: 'fetch-weather',
      toolName: 'fetch_weather',
      toolInput: { location: 'Seattle' },
      declared: { inputs: [], intendedEffect: 'Fetch weather data' },
      agentId,
    });

    expect(action.actionKind).toBe('ToolCall');
    expect(action.status).toBe('planned');
    expect(action.effectful).toBe(true);
    expect(action.properties.toolName).toBe('fetch_weather');
    expect(action.properties.toolInput).toEqual({ location: 'Seattle' });
  });

  it('runToolAction produces tool-request and tool-result artifacts', async () => {
    const result = await p.runToolAction(runId, {
      type: 'fetch-weather',
      toolName: 'fetch_weather',
      toolInput: { location: 'Seattle' },
      declared: { inputs: [], intendedEffect: 'Fetch weather data' },
      agentId,
    });

    expect(result.output).toEqual({
      location: 'Seattle',
      tempC: 22,
      conditions: 'sunny',
    });
    expect(result.action.status).toBe('completed');
    expect(result.action.observed!.producedArtifactIds).toHaveLength(2);

    const artifacts = await p.artifacts.forRun(runId);
    const request = artifacts.find((a) => a.type === 'tool-request');
    const resultArt = artifacts.find((a) => a.type === 'tool-result');

    expect(request).toBeDefined();
    expect(request!.content.toolName).toBe('fetch_weather');
    expect(request!.content.input).toEqual({ location: 'Seattle' });

    expect(resultArt).toBeDefined();
    expect(resultArt!.content.toolName).toBe('fetch_weather');
    expect(resultArt!.content.output).toEqual({
      location: 'Seattle',
      tempC: 22,
      conditions: 'sunny',
    });
  });

  it('tool metrics are recorded', async () => {
    const result = await p.runToolAction(runId, {
      type: 'fetch-weather',
      toolName: 'fetch_weather',
      toolInput: { location: 'Portland' },
      declared: { inputs: [] },
      agentId,
    });

    const metrics = result.action.observed!.metrics!;
    expect(metrics.startedAt).toBeDefined();
    expect(metrics.completedAt).toBeDefined();
    expect(metrics.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('effectful tool replay reuses prior outputs by default', async () => {
    await p.runToolAction(runId, {
      type: 'fetch-weather',
      toolName: 'fetch_weather',
      toolInput: { location: 'Denver' },
      declared: { inputs: [] },
      agentId,
    });

    expect(fetchCallCount).toBe(1);

    const replayed = await p.replayRun(runId);

    // Tool should NOT have been called again
    expect(fetchCallCount).toBe(1);

    // Replayed run should share the same artifacts
    const originalArtifacts = await p.artifacts.forRun(runId);
    const replayedArtifacts = await p.artifacts.forRun(replayed.id);
    expect(replayedArtifacts).toHaveLength(originalArtifacts.length);
    expect(replayedArtifacts[0].id).toBe(originalArtifacts[0].id);
  });

  it('pure tool uses caching — cache hit skips re-execution', async () => {
    let analyzeCallCount = 0;
    const countingTool: ParallaxTool = {
      name: 'counting_analyze',
      effectful: false,
      execute: async (input) => {
        analyzeCallCount++;
        return { result: 'done' };
      },
    };

    const cp = new Parallax();
    cp.registerTool(countingTool);
    const agent = await cp.createAgent({ type: 'Agent', properties: {} });

    // First run
    const run1 = await cp.createRun(agent.id);
    await cp.runToolAction(run1.id, {
      type: 'analyze',
      toolName: 'counting_analyze',
      declared: { inputs: [] },
      agentId: agent.id,
    });
    expect(analyzeCallCount).toBe(1);

    // Second run with identical action — should hit cache
    const run2 = await cp.createRun(agent.id);
    await cp.runToolAction(run2.id, {
      type: 'analyze',
      toolName: 'counting_analyze',
      declared: { inputs: [] },
      agentId: agent.id,
    });
    expect(analyzeCallCount).toBe(1);
  });

  it('pure tool recomputes when cachePolicy is recompute', async () => {
    let analyzeCallCount = 0;
    const countingTool: ParallaxTool = {
      name: 'recompute_analyze',
      effectful: false,
      execute: async () => {
        analyzeCallCount++;
        return { result: 'done' };
      },
    };

    const cp = new Parallax();
    cp.registerTool(countingTool);
    const agent = await cp.createAgent({ type: 'Agent', properties: {} });

    const run1 = await cp.createRun(agent.id);
    await cp.runToolAction(run1.id, {
      type: 'analyze',
      toolName: 'recompute_analyze',
      declared: { inputs: [] },
      agentId: agent.id,
      cachePolicy: 'recompute',
    });
    expect(analyzeCallCount).toBe(1);

    // Same action with recompute — should execute again
    const run2 = await cp.createRun(agent.id);
    await cp.runToolAction(run2.id, {
      type: 'analyze',
      toolName: 'recompute_analyze',
      declared: { inputs: [] },
      agentId: agent.id,
      cachePolicy: 'recompute',
    });
    expect(analyzeCallCount).toBe(2);
  });

  it('tool action respects scoped context from declared inputs', async () => {
    // Create an artifact that the tool action will consume
    const weatherArtifact = await p.createArtifact({
      type: 'weather-snapshot',
      producedByActionId: agentId,
      runId,
      content: { location: 'Miami', tempC: 30, conditions: 'humid' },
      reusable: true,
      properties: {},
    });

    const result = await p.runToolAction(runId, {
      type: 'analyze',
      toolName: 'analyze_conditions',
      declared: { inputs: [{ objectId: weatherArtifact.id }] },
      agentId,
    });

    // The tool receives the artifact content as context
    expect(result.output.summary).toContain('Miami');
    expect(result.output.summary).toContain('humid');

    const artifacts = await p.artifacts.forRun(runId);
    const request = artifacts.find((a) => a.type === 'tool-request');
    expect(request?.content.input).toMatchObject({
      location: 'Miami',
      tempC: 30,
      conditions: 'humid',
    });
  });

  it('undeclared input consumption surfaces in divergence reporting', async () => {
    // Create an artifact and a tool action that doesn't declare it
    const secretArtifact = await p.createArtifact({
      type: 'secret-data',
      producedByActionId: agentId,
      runId,
      content: { secret: 'password123' },
      reusable: true,
      properties: {},
    });

    const result = await p.runToolAction(runId, {
      type: 'fetch-weather',
      toolName: 'fetch_weather',
      toolInput: { location: 'NYC' },
      declared: { inputs: [] },
      agentId,
    });

    // Manually mark undeclared consumption (simulating runtime instrumentation)
    const action = result.action;
    action.observed!.consumedInputIds = [
      ...action.observed!.consumedInputIds,
      secretArtifact.id,
    ];
    // Persist the modified action
    await (p as any).store.putObject(action);

    const divergence = await p.getDivergence(runId);
    const undeclared = divergence.events.find(
      (e) => e.type === 'undeclared_input_consumed',
    );
    expect(undeclared).toBeDefined();
    expect(undeclared!.description).toContain(secretArtifact.id);
  });

  it('runToolAction throws if no tools registered', async () => {
    const plain = new Parallax();
    const agent = await plain.createAgent({ type: 'Agent', properties: {} });
    const run = await plain.createRun(agent.id);

    await expect(
      plain.runToolAction(run.id, {
        type: 'fetch',
        toolName: 'fetch_weather',
        declared: { inputs: [] },
      }),
    ).rejects.toThrow('No tools registered');
  });

  it('runToolAction is idempotent for the same completed action', async () => {
    const first = await p.runToolAction(runId, {
      type: 'fetch-weather',
      toolName: 'fetch_weather',
      toolInput: { location: 'Boston' },
      declared: { inputs: [] },
      agentId,
    });

    const second = await p.runToolAction(runId, {
      type: 'fetch-weather',
      toolName: 'fetch_weather',
      toolInput: { location: 'Boston' },
      declared: { inputs: [] },
      agentId,
    });

    expect(fetchCallCount).toBe(1);
    expect(second.action.id).toBe(first.action.id);
    expect(second.output).toEqual(first.output);
  });
});
