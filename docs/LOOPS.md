# Agent Loops

Parallax provides a lightweight agent-loop helper that orchestrates repeated think/act/observe cycles using existing actions. Loop iterations are ordinary Parallax actions underneath — the same ontology, replay, and divergence semantics apply.

## Quick Start

```typescript
import { Parallax, runAgentLoop } from '@invariance/parallax';
import type { AgentLoopDriver } from '@invariance/parallax';

const p = new Parallax();
p.registerLLM(adapter);
p.registerTool(weatherTool);

const agent = await p.createAgent({ type: 'weather-agent', properties: {} });
const run = await p.createRun(agent.id);

const driver: AgentLoopDriver = async ({ artifacts, iteration }) => {
  if (iteration === 0) {
    return {
      type: 'tool',
      reason: 'fetch initial data',
      tool: {
        type: 'fetch-weather',
        toolName: 'fetch_weather',
        toolInput: { location: 'Seattle' },
        declared: { inputs: [] },
        agentId: agent.id,
      },
    };
  }

  if (iteration === 1) {
    return {
      type: 'model',
      reason: 'analyze conditions',
      model: {
        model: 'claude-sonnet-4-20250514',
        prompt: 'Summarize weather risk',
        agentId: agent.id,
      },
    };
  }

  return { type: 'stop', reason: 'analysis complete' };
};

const result = await runAgentLoop(p, run.id, { driver, maxIterations: 10 });

console.log(result.iterations);  // 3
console.log(result.stoppedBy);   // 'driver'
console.log(result.steps);      // [{ type: 'tool', ... }, { type: 'model', ... }, { type: 'stop', ... }]
```

## How It Works

`runAgentLoop` is a thin orchestration layer. On each iteration it:

1. Loads current run state (run, actions, artifacts)
2. Calls the driver with that state plus the iteration count
3. Executes the driver's decision via `runModelAction` or `runToolAction`
4. Repeats until the driver returns `stop` or `maxIterations` is reached

No second execution engine. The loop operates entirely through existing Parallax action APIs.

## Types

### AgentLoopDecision

The driver returns one of these on each iteration:

```typescript
interface AgentLoopDecision {
  type: 'model' | 'tool' | 'stop';
  reason?: string;
  model?: CreateModelActionOpts;   // required when type is 'model'
  tool?: CreateToolActionOpts;     // required when type is 'tool'
}
```

### AgentLoopDriver

A callback that inspects current state and decides the next step:

```typescript
type AgentLoopDriver = (state: {
  run: RunObject;
  actions: ActionObject[];
  artifacts: ArtifactObject[];
  iteration: number;
}) => Promise<AgentLoopDecision>;
```

### AgentLoopResult

What `runAgentLoop` returns:

```typescript
interface AgentLoopResult {
  run: RunObject;
  iterations: number;
  steps: AgentLoopStepResult[];
  stoppedBy: 'driver' | 'maxIterations';
}
```

## Stop Conditions

Two ways a loop ends:

1. **Driver returns `stop`** — explicit termination with an optional reason
2. **`maxIterations` reached** — safety limit (defaults to 100)

Check `result.stoppedBy` to distinguish the two.

## Iteration Metadata

Each loop-created action carries metadata in `properties`:

```typescript
{
  loopIteration: 0,    // zero-based iteration index
  loopReason: '...',   // from decision.reason, if provided
}
```

This enables queries and inspection without inventing new object kinds:

```typescript
const actions = await p.actions.forRun(run.id);
const loopActions = actions.filter(a => a.properties.loopIteration !== undefined);
```

## Replay

Runs produced by `runAgentLoop` replay like any other Parallax run:

```typescript
const result = await runAgentLoop(p, run.id, { driver });
const replayed = await p.replayRun(run.id);
```

Effectful actions are reused. Pure actions use caching. The loop structure is preserved through standard action and artifact replay semantics.

## Example: Conditional Data Gathering

A loop that fetches weather, checks risk, and gathers more data only if risk is elevated:

```typescript
const driver: AgentLoopDriver = async ({ artifacts, iteration }) => {
  if (iteration === 0) {
    return {
      type: 'tool',
      reason: 'fetch weather snapshot',
      tool: {
        type: 'fetch-weather',
        toolName: 'fetch_weather',
        toolInput: { location: 'Riverside County' },
        declared: { inputs: [] },
      },
    };
  }

  // Check the last tool result
  const lastResult = artifacts.filter(a => a.type === 'tool-result').pop();
  const risk = lastResult?.content?.output?.risk;

  if (risk === 'high' && iteration === 1) {
    return {
      type: 'model',
      reason: 'elevated risk — generate detailed analysis',
      model: {
        model: 'claude-sonnet-4-20250514',
        prompt: 'Analyze fire risk factors and recommend actions',
      },
    };
  }

  return { type: 'stop', reason: risk === 'high' ? 'analysis complete' : 'risk is low' };
};
```

## Design Notes

- The driver owns all decision logic. Parallax provides structure and bookkeeping.
- Loop iterations are ordinary actions — no special loop object kind.
- The driver receives fresh state each iteration, so decisions can react to previous outputs.
- `runAgentLoop` is a free function, not a method on `Parallax`. This keeps the core class focused on primitive operations.
