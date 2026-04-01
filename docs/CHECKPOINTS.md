# Checkpoints & Selective Replay

Checkpoints let you mark stable points in a run, branch from them, and replay only downstream actions when conditions change.

## Why

Whole-run replay reruns everything. When upstream sensing and analysis are expensive or effectful, you want to preserve that work and only rerun the reasoning and dispatch steps that depend on changed inputs.

## Checkpoint Convention

Checkpoints are artifacts with `type: 'checkpoint'`. No new object kind — they live in the existing ontology graph. A checkpoint's `content` contains:

```typescript
{
  name: string           // user-facing label, e.g. "risk-assessment-ready"
  actionId: string       // the action this checkpoint marks
  artifactIds: string[]  // snapshot of artifact IDs at this point in the run
  summary?: string       // optional description
}
```

## API

### Create and Query Checkpoints

```typescript
// Create a checkpoint at the latest action (or a specific one)
const cp = await p.createCheckpoint(runId, {
  name: 'analysis-complete',
  summary: 'All sensing and analysis actions finished',
});

// Checkpoint at a specific action
const cp2 = await p.createCheckpoint(runId, {
  name: 'after-fetch',
  actionId: fetchAction.id,
});

// Retrieve by name
const found = await p.getCheckpoint(runId, 'analysis-complete');

// List all checkpoints in a run
const all = await p.listCheckpoints(runId);
```

### Branch from a Checkpoint

Creates a new run sharing all actions up to the checkpoint. The branched run is ready for new actions to be appended.
Checkpoint artifacts anchored to the shared prefix are carried into the branch as well.

```typescript
const branch = await p.branchFromCheckpoint(runId, 'analysis-complete');
// branch.parentRunId === runId
// branch.branchFromActionId === checkpoint's actionId
// branch.actionIds contains only the prefix actions
```

Equivalent action-level API:

```typescript
const branch = await p.branchFromAction(runId, actionId);
```

### Replay from a Checkpoint

Creates a new run that shares the prefix and replays (re-executes) all actions after the checkpoint. Effectful actions in the tail are structurally shared by default (`skipEffectful: true`).
Checkpoint artifacts anchored to the shared prefix remain attached in the replayed run.

```typescript
const replayed = await p.replayFromCheckpoint(runId, 'analysis-complete');
// replayed.status === 'replayed'
// replayed.parentRunId === runId
// replayed.replayOfRunId === runId
```

Equivalent action-level API:

```typescript
const replayed = await p.replayFromAction(runId, actionId, {
  skipEffectful: true,  // default
});
```

### Compare Branches

Use `diffRuns` to see what changed between the original and the branch:

```typescript
const diff = await p.diffRuns(originalRunId, branchRunId);
for (const event of diff.events) {
  console.log(`${event.type}: ${event.description}`);
}
```

## Run-State Query Helpers

These helpers make it easy to inspect the latest meaningful outputs in a run:

```typescript
// Latest action (optionally filtered by type)
const latest = await p.actions.latestForRun(runId);
const latestFetch = await p.actions.latestForRun(runId, 'fetch');

// All actions of a given type
const fetches = await p.actions.byType(runId, 'fetch');

// Latest artifact (optionally filtered by type)
const latestArt = await p.artifacts.latestForRun(runId);

// All artifacts of a given type
const outputs = await p.artifacts.byType(runId, 'output');
```

## Example: Selective Replay with Changed Input

```typescript
import { Parallax } from '@invariance/parallax';

const p = new Parallax();
p.registerExecutor('ToolCall', myExecutor);

const agent = await p.createAgent({ type: 'Agent', properties: {} });
const run = await p.createRun(agent.id);

// Step 1: Fetch data (effectful)
const fetch = await p.planAction(run.id, {
  type: 'fetch-data', actionKind: 'ToolCall', runId: run.id,
  effectful: true, declared: { inputs: [] }, agentId: agent.id, properties: {},
});
await p.executeAction(fetch.id);

// Step 2: Analyze (pure, recompute)
const analyze = await p.planAction(run.id, {
  type: 'analyze', actionKind: 'ToolCall', runId: run.id,
  effectful: false, declared: { inputs: [] }, agentId: agent.id,
  properties: {}, cachePolicy: 'recompute',
});
await p.executeAction(analyze.id);

// Checkpoint after fetch
await p.createCheckpoint(run.id, { name: 'data-ready', actionId: fetch.id });

// New data arrives — replay only downstream
const replayed = await p.replayFromCheckpoint(run.id, 'data-ready');
// fetch is shared (effectful, not re-executed)
// analyze is re-executed (pure, recompute)

// Compare
const diff = await p.diffRuns(run.id, replayed.id);
```

See `examples/selective-replay/run.ts` for a runnable version.
