# @invariance/parallax

Ontology-backed dual-graph runtime for AI agents.

Parallax models actions, artifacts, goals, agents, and runs as first-class content-addressed objects. It maintains both **declared dependency structure** and **observed execution structure** — the difference between the two is where bugs, drift, and unexpected behavior live.

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

All objects are identified by a BLAKE3 hash of their stable identity fields. Mutable runtime state (timestamps, observed metrics, errors) is excluded from the hash. Same stable content always resolves to the same object — deduplication is automatic.

## Quick Start

```typescript
import { Parallax } from '@invariance/parallax';

const p = new Parallax();

// Create an agent and a run
const agent = await p.createAgent({ type: 'Agent', properties: { name: 'my-agent' } });
const run = await p.createRun(agent.id, { goalDescription: 'Summarize document' });

// Plan an action with declared dependencies
const action = await p.planAction(run.id, {
  type: 'summarize',
  actionKind: 'ModelInference',
  runId: run.id,
  effectful: false,
  declared: {
    inputs: [{ objectId: someArtifact.id, select: ['text'] }],
  },
  agentId: agent.id,
  properties: { model: 'claude-sonnet-4-6' },
});

// Register an executor and run the action
p.registerExecutor('ModelInference', myExecutor);
const executed = await p.executeAction(action.id);

// Check for divergence
const report = await p.getDivergence(run.id);

// Replay the run (effectful actions reuse cached outputs)
const replayed = await p.replayRun(run.id);

// Fork from a specific action
const forked = await p.forkRun(run.id, action.id);
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
  }>;
}
```

### Scoped Context

```typescript
getScopedContext(actionId): Promise<Record<string, unknown>>
```

Resolves exactly the objects listed in `declared.inputs`. Supports `select` (field filtering), `alias` (namespacing), and throws on key collisions. Never exposes undeclared upstream objects.

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

Replay creates a new run linked via `replayOfRunId`. Effectful actions are reused by default (their artifacts are structurally shared). Pure actions are re-executed or served from cache.

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
  hash.ts           — canonical BLAKE3 hashing
  store.ts          — ParallaxStore interface
  store/memory.ts   — InMemoryParallaxStore
  relations.ts      — DAG validation
  context.ts        — scoped context resolution
  caching.ts        — cache key derivation
  events.ts         — event registry
```

## Invariants

These are enforced, not best-effort:

- Dependency graph is always a DAG
- Object IDs are deterministic regardless of key insertion order
- Object IDs never include mutable runtime state
- Artifact `contentHash` equals BLAKE3 hash of `content`
- `getScopedContext` exposes only declared inputs
- Key collisions in scoped context throw
- Effectful actions are reused on replay by default
- Relations must connect existing objects

## Development

```bash
npm install
npm run typecheck   # strict TypeScript
npm test            # 40 tests across 11 suites
npm run build       # ESM output with declaration files
```

## License

MIT
