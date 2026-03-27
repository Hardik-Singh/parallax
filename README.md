# @invariance/parallax

Ontology-backed dual-graph runtime for AI agents.

Parallax models actions, artifacts, goals, agents, and runs as first-class content-addressed objects. It maintains both **declared dependency structure** and **observed execution structure**. The difference between those two views is where bugs, drift, and unexpected behavior live.

## Install

```bash
npm install @invariance/parallax
```

## Core Concepts

### Ontology Objects

Every meaningful thing in an agent's execution is a first-class object:

| Object | Purpose |
|---|---|
| **Action** | A discrete agent step — tool call, decision, inference, sub-agent dispatch |
| **Artifact** | A durable output produced by an action — reusable across runs |
| **Agent** | An identity that owns actions and runs |
| **Run** | An ordered operational narrative of actions and artifacts |
| **Goal** | What a run is trying to achieve |
| **DivergenceRecord** | A structured report of declared-vs-observed mismatches |

### Dual Graph

Every action has two sides:

- **Declared**: what it says it needs (`declared.inputs`)
- **Observed**: what it actually consumed and produced at runtime (`observed`)

Parallax maintains both as typed relations:

- **Dependency graph** — `DEPENDS_ON` relations (declared structure)
- **Execution graph** — `CAUSED`, `CONSUMED`, `PRODUCED` relations (observed behavior)
- **Provenance graph** — `PERFORMED_BY`, `PRODUCED`, `REPLAY_OF`, `PART_OF`
- **Violation graph** — `VIOLATES`

### Content Addressing

All objects are identified by a BLAKE3 hash of their stable identity fields. Mutable runtime state such as timestamps, observed metrics, and errors is excluded from the hash.

Important semantics:

- reusable artifacts deduplicate by content, not by producing run
- non-reusable artifacts stay run-local
- runs are unique operational sessions, not deduplicated objects
- replay prefers structural sharing for unchanged completed actions and artifacts

## Quick Start

```typescript
import { Parallax } from '@invariance/parallax';
import type { LLMAdapter } from '@invariance/parallax';

const adapter: LLMAdapter = {
  async generate({ model, prompt }) {
    const response = await yourProvider.complete({ model, prompt });
    return {
      output: response.text,
      usage: { input: response.inputTokens, output: response.outputTokens },
    };
  },
};

const p = new Parallax();
p.registerLLM(adapter);

const agent = await p.createAgent({ type: 'response-agent', properties: { name: 'my-agent' } });
const run = await p.createRun(agent.id, { goalDescription: 'Summarize document' });

const doc = await p.createArtifact({
  type: 'prompt-input',
  producedByActionId: agent.id,
  runId: run.id,
  content: { text: 'Long source document...' },
  reusable: true,
  properties: {},
});

const result = await p.runModelAction(run.id, {
  model: 'claude-sonnet-4-20250514',
  prompt: `Summarize this:\n\n${doc.content.text}`,
  inputs: [{ objectId: doc.id, select: ['text'] }],
  agentId: agent.id,
});

console.log(result.response);

const report = await p.getDivergence(run.id);
const replayed = await p.replayRun(run.id);
```

## API

### Object Creation

```typescript
createAgent(props): Promise<AgentObject>
createRun(agentId, opts?): Promise<RunObject>
createGoal(runId, description): Promise<GoalObject>
createArtifact(props): Promise<ArtifactObject>
planAction(runId, props): Promise<ActionObject>
```

### Execution

```typescript
registerExecutor(actionKind, executor): void
executeAction(actionId): Promise<ActionObject>
```

Executors implement `ActionExecutor`:

```typescript
interface ActionExecutor {
  canExecute(action: ActionObject): boolean;
  execute(action: ActionObject, context: Record<string, unknown>): Promise<{
    outputs: Record<string, unknown>;
    producedArtifacts?: Omit<ArtifactObject, 'id' | 'kind' | 'producedByActionId' | 'runId' | 'contentHash' | 'createdAt'>[];
    metrics?: ExecutionMetrics;
  }>;
}
```

If an executor returns `metrics`, they are persisted in `action.observed.metrics`.

### LLM Integration

```typescript
registerLLM(adapter): void
createModelAction(runId, opts): Promise<ActionObject>
runModelAction(runId, opts): Promise<ModelActionResult>
```

Register an `LLMAdapter` to enable `ModelInference` actions. `runModelAction` plans, executes, and returns the response in one call:

```typescript
p.registerLLM({
  generate: async ({ model, prompt, system }) => {
    const res = await yourProvider.complete({ model, prompt, system });
    return { output: res.text, usage: { input: res.inputTokens, output: res.outputTokens } };
  },
});

const result = await p.runModelAction(run.id, {
  model: 'claude-sonnet-4-20250514',
  prompt: 'Summarize this diff',
  inputs: [{ objectId: diffArtifact.id }],
  agentId: agent.id,
});

console.log(result.response);   // LLM output
console.log(result.usage);      // { input, output }
console.log(result.toolCalls);  // tool calls if any
```

Model actions are `effectful: true` by default — replay reuses them without re-calling the LLM. The executor produces `llm-response` and `tool-request` artifacts automatically.

See [docs/LLM.md](./docs/LLM.md) for full examples including a multi-step coding agent.

### Tool Execution

```typescript
registerTool(tool): void
getTool(name): ParallaxTool | undefined
createToolAction(runId, opts): Promise<ActionObject>
runToolAction(runId, opts): Promise<ToolActionResult>
```

Register `ParallaxTool` implementations to enable `ToolCall` actions. `runToolAction` plans, executes, and returns the output in one call:

```typescript
import type { ParallaxTool } from '@invariance/parallax';

const fetchWeather: ParallaxTool = {
  name: 'fetch_weather',
  effectful: true,
  async execute(input) {
    return { tempC: 22, conditions: 'sunny', location: input.location };
  },
};

p.registerTool(fetchWeather);

const result = await p.runToolAction(run.id, {
  type: 'fetch-weather',
  toolName: 'fetch_weather',
  toolInput: { location: 'Seattle' },
  declared: { inputs: [] },
  agentId: agent.id,
});

console.log(result.output);  // { tempC: 22, conditions: 'sunny', location: 'Seattle' }
```

Tools default to `effectful: true` — replay reuses them without re-calling the tool. Set `effectful: false` for pure tools that should use caching. The executor produces `tool-request` and `tool-result` artifacts automatically.

`tool-request` captures the final merged input the tool received after combining `toolInput` with scoped declared context.

See [docs/TOOLS.md](./docs/TOOLS.md) for full examples including multi-step pipelines with replay.

### Scoped Context

```typescript
getScopedContext(actionId): Promise<Record<string, unknown>>
```

Resolves exactly the objects listed in `declared.inputs`. Supports `select` (field filtering), `alias` (namespacing), and throws on key collisions. Never exposes undeclared upstream objects.

For v1, context materialization works like this:

- `Artifact` dependencies expose `artifact.content`
- all other dependencies expose `object.properties`

If you want Parallax to detect field-level scope violations, you can instrument an action with:

```typescript
properties: {
  accessedFields: {
    [artifactId]: ['fieldA', 'fieldB']
  }
}
```

Parallax will compare those fields against each dependency's `select`.

### Graph Projections

```typescript
getDependencyGraph(runId): Promise<GraphProjection>   // DEPENDS_ON only
getExecutionGraph(runId): Promise<GraphProjection>    // CAUSED, CONSUMED, PRODUCED only
getProvenanceGraph(objectId): Promise<GraphProjection>
```

### Divergence Detection

```typescript
getDivergence(runId): Promise<DivergenceRecord>
diffRuns(runAId, runBId): Promise<DivergenceRecord>
explainDivergence(runAId, runBId): Promise<DivergenceRecord>
```

Detects:
- `undeclared_input_consumed` — action consumed an object not in `declared.inputs`
- `declared_input_never_observed` — declared dependency never appeared in `observed.consumedInputIds`
- `context_scope_violation` — action accessed fields outside allowed scope
- `effectful_action_re_executed` — effectful action was re-run when reuse was expected
- `agent_attribution_mismatch` — action agent differs from run agent (excluding sub-agent patterns)
- `run_shape_divergence` — action sequence or dependency structure differs between runs
- `goal_drift` — action conflicts with active goal state
- `unexpected_causal_edge` — observed causal relationship without declared dependency

### Replay & Forking

```typescript
replayRun(runId, opts?): Promise<RunObject>    // opts.skipEffectful defaults to true
forkRun(runId, fromActionId): Promise<RunObject>
```

Replay creates a new run linked via `replayOfRunId`.

Current replay behavior:

- effectful actions are reused by default
- unchanged completed actions are structurally shared into the replayed run
- reusable artifacts are structurally shared across runs
- pure actions are recomputed only when they cannot be safely reused or are forced with `cachePolicy: 'recompute'`

Forking creates a new run with `parentRunId` and `branchFromActionId`, copying actions up to the branch point.

### Operational Queries

```typescript
p.actions.forRun(runId)
p.actions.forAgent(agentId)
p.actions.thatConsumed(artifactId)
p.actions.thatProduced(artifactId)
p.actions.thatViolatedScope(runId)

p.artifacts.forRun(runId)
p.artifacts.forGoal(goalId)
p.artifacts.sharedAcrossRuns()

p.runs.forAgent(agentId)
p.runs.replayChain(runId)
```

### Relations

```typescript
link(type, fromId, toId, properties?): Promise<Relation>
getRelations(type, fromId?, toId?): Promise<Relation[]>
```

Nine relation types: `DEPENDS_ON`, `CAUSED`, `PRODUCED`, `CONSUMED`, `PERFORMED_BY`, `PART_OF`, `TARGETS`, `REPLAY_OF`, `VIOLATES`.

`CAUSED` edges are emitted from a producing action to a consuming action when the consumer declares an input artifact produced by that upstream action.

`DEPENDS_ON` is DAG-validated — cycles are rejected.

### Events

```typescript
p.on('action:started', handler)
p.on('action:completed', handler)
p.on('action:failed', handler)
p.on('run:replayed', handler)
p.on('divergence:detected', handler)
```

### Hashing

```typescript
p.hash(content)           // BLAKE3 of canonical JSON
p.findByHash(hash)        // lookup by content address
```

## Package Exports

```typescript
import { Parallax, hash, InMemoryParallaxStore } from '@invariance/parallax';
import type { ActionObject, RunObject, ... } from '@invariance/parallax/types';
import type { ParallaxStore } from '@invariance/parallax/store';
```

## Architecture

```
src/
  index.ts          — main exports
  parallax.ts       — Parallax class (core runtime)
  types.ts          — all type definitions
  llm.ts            — LLM adapter types
  model.ts          — ModelInferenceExecutor
  tool.ts           — ParallaxTool types & ToolExecutor
  hash.ts           — canonical BLAKE3 hashing
  store.ts          — ParallaxStore interface
  store/memory.ts   — InMemoryParallaxStore
  relations.ts      — DAG validation
  context.ts        — scoped context resolution
  caching.ts        — cache key derivation
  events.ts         — event registry
```

For a cleaner semantics-oriented walkthrough, see [docs/SEMANTICS.md](./docs/SEMANTICS.md).

## Invariants

These are enforced, not best-effort:

- Dependency graph is always a DAG
- Object IDs are deterministic regardless of key insertion order
- Object IDs never include mutable runtime state
- Artifact `contentHash` equals BLAKE3 hash of `content`
- `getScopedContext` exposes only declared inputs
- Key collisions in scoped context throw
- Effectful actions are reused on replay by default
- Reusable artifacts deduplicate by content across runs
- Replayed runs can structurally share unchanged completed actions
- Relations must connect existing objects

## Development

```bash
npm install
npm run typecheck   # strict TypeScript
npm test            # 62 tests across 13 suites
npm run build       # ESM output with declaration files
```

## License

MIT
