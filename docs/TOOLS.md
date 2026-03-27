# Tool Execution

Parallax treats tool calls as `ToolCall` actions — the same ontology, replay, and divergence semantics apply. This guide covers the tool interface, registration, convenience helpers, and end-to-end examples.

## Quick Start

### 1. Define a tool

A `ParallaxTool` wraps any function with a name and an execute method:

```typescript
import type { ParallaxTool } from '@invariance/parallax';

const weatherTool: ParallaxTool = {
  name: 'fetch_weather',
  description: 'Fetch current weather for a location',
  effectful: true,  // default — marks this as having side effects
  async execute(input) {
    const res = await fetch(`https://api.weather.com/${input.location}`);
    return await res.json();
  },
};
```

**`effectful`** controls replay and caching behavior:
- `true` (default): the tool has side effects. Results are reused during replay instead of re-executing.
- `false`: the tool is pure. Results are cached and recomputed only when upstream dependencies change.

### 2. Register it

```typescript
import { Parallax } from '@invariance/parallax';

const p = new Parallax();
p.registerTool(weatherTool);
```

You can register multiple tools. Each is looked up by name during execution.

### 3. Run a tool action

```typescript
const agent = await p.createAgent({ type: 'weather-agent', properties: {} });
const run = await p.createRun(agent.id);

const result = await p.runToolAction(run.id, {
  type: 'fetch-weather',
  toolName: 'fetch_weather',
  toolInput: { location: 'Seattle' },
  declared: { inputs: [], intendedEffect: 'Fetch weather data' },
  agentId: agent.id,
});

console.log(result.output);  // { temperature: 18, conditions: 'cloudy', ... }
console.log(result.action.status);  // 'completed'
```

`runToolAction` is a convenience wrapper that:
1. Plans a `ToolCall` action via `createToolAction`
2. Executes it
3. Returns the action and tool output in a flat result

If the same completed action is requested again with identical stable inputs, `runToolAction` returns the existing completed action without re-executing.

## Artifact Conventions

The `ToolExecutor` automatically produces these artifacts:

| Type | Content | When |
|------|---------|------|
| `tool-request` | `{ toolName, input }` | Always |
| `tool-result` | `{ toolName, output }` | Always |

Artifacts are non-reusable (scoped to their run/action). During replay, effectful actions and their artifacts are structurally shared.

## Metrics

Timing is captured in `action.observed.metrics`:

```typescript
const { action } = result;
console.log(action.observed?.metrics?.durationMs);   // 234
console.log(action.observed?.metrics?.startedAt);    // ISO timestamp
console.log(action.observed?.metrics?.completedAt);  // ISO timestamp
```

## Replay Behavior

Effectful tools (default) are structurally shared during replay — the tool is not called again:

```typescript
const result = await p.runToolAction(run.id, {
  type: 'fetch-weather',
  toolName: 'fetch_weather',
  toolInput: { location: 'Seattle' },
  declared: { inputs: [] },
});

const replayed = await p.replayRun(run.id);
// fetch_weather was NOT called again. Replayed run shares the same action and artifacts.
```

To force re-execution during replay:

```typescript
const replayed = await p.replayRun(run.id, { skipEffectful: false });
```

Pure tools (`effectful: false`) use caching. Cache hits skip re-execution. Use `cachePolicy: 'recompute'` to force re-execution:

```typescript
const result = await p.runToolAction(run.id, {
  type: 'analyze',
  toolName: 'analyze_data',
  declared: { inputs: [{ objectId: dataArtifact.id }] },
  cachePolicy: 'recompute',  // force re-execution
});
```

## Declaring Dependencies

Use `declared.inputs` to connect a tool action to the dependency graph. This enables scoped context resolution and divergence detection:

```typescript
const weatherArtifact = /* ... produced by a previous action ... */;

const result = await p.runToolAction(run.id, {
  type: 'analyze-risk',
  toolName: 'analyze_conditions',
  declared: {
    inputs: [{ objectId: weatherArtifact.id }],
    intendedEffect: 'Analyze weather risk',
  },
  agentId: agent.id,
});
```

The tool's `execute` function receives a merged context of `toolInput` and the materialized declared inputs. For artifacts, the content is materialized; for other objects, the properties are materialized.

## Divergence Detection

Tool actions participate in the same divergence detection as all other actions:

- **undeclared_input_consumed**: Tool consumed an input not in `declared.inputs`
- **declared_input_never_observed**: A declared input was never used
- **context_scope_violation**: Tool accessed fields outside the allowed `select` scope
- **effectful_action_re_executed**: Effectful tool was re-executed during replay instead of reused

```typescript
const divergence = await p.getDivergence(run.id);
for (const event of divergence.events) {
  console.log(`${event.type}: ${event.description}`);
}
```

## Step-by-Step Control

For more control, use `createToolAction` and `executeAction` separately:

```typescript
const action = await p.createToolAction(run.id, {
  type: 'fetch-weather',
  toolName: 'fetch_weather',
  toolInput: { location: 'Portland' },
  declared: { inputs: [] },
  agentId: agent.id,
});

// Inspect the planned action before executing
console.log(action.declared.inputs);
console.log(action.properties.toolName);

const executed = await p.executeAction(action.id);
console.log(executed.observed?.producedArtifactIds);
```

## Tool Lookup

```typescript
p.registerTool(myTool);

const tool = p.getTool('my_tool');
console.log(tool?.name);        // 'my_tool'
console.log(tool?.description); // 'Does something useful'
console.log(tool?.effectful);   // true
```

## Example: Weather Analysis Pipeline

A multi-step pipeline that fetches weather data, analyzes conditions, and produces a risk report:

```typescript
import { Parallax } from '@invariance/parallax';
import type { ParallaxTool } from '@invariance/parallax';

// 1. Define tools
const fetchWeather: ParallaxTool = {
  name: 'fetch_weather',
  effectful: true,
  async execute(input) {
    return { location: input.location, tempC: 35, humidity: 0.15, wind: 45 };
  },
};

const analyzeRisk: ParallaxTool = {
  name: 'analyze_risk',
  effectful: false,
  async execute(input) {
    const risk = (input.tempC as number) > 30 && (input.humidity as number) < 0.2
      ? 'high' : 'low';
    return { risk, factors: ['temperature', 'humidity'] };
  },
};

// 2. Set up runtime
const p = new Parallax();
p.registerTool(fetchWeather);
p.registerTool(analyzeRisk);

const agent = await p.createAgent({ type: 'weather-agent', properties: {} });
const run = await p.createRun(agent.id, { goalDescription: 'Assess fire risk' });

// 3. Fetch weather (effectful)
const weather = await p.runToolAction(run.id, {
  type: 'fetch-weather',
  toolName: 'fetch_weather',
  toolInput: { location: 'California' },
  declared: { inputs: [] },
  agentId: agent.id,
});

// 4. Analyze risk (pure, depends on weather)
const weatherArtifactId = weather.action.observed!.producedArtifactIds[1]; // tool-result
const risk = await p.runToolAction(run.id, {
  type: 'analyze-risk',
  toolName: 'analyze_risk',
  declared: { inputs: [{ objectId: weatherArtifactId }] },
  agentId: agent.id,
});

console.log(risk.output);  // { risk: 'high', factors: ['temperature', 'humidity'] }

// 5. Replay — fetch_weather is NOT called again
const replayed = await p.replayRun(run.id);

// 6. Check for divergence
const divergence = await p.getDivergence(run.id);
console.log(divergence.summary);
```
