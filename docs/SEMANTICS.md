# Parallax Semantics

This file is the short, implementation-aligned explanation of how Parallax behaves in v1.

## Mental Model

Parallax is ontology-first and graph-native.

You work with first-class objects:

- `Agent`
- `Run`
- `Action`
- `Artifact`
- `Goal`
- `DivergenceRecord`

Under the hood, Parallax maintains typed relations between those objects and projects them into dependency, execution, and provenance graphs.

The central idea is simple:

- `declared` = what an action said it needed
- `observed` = what the action actually consumed and produced

Parallax helps you compare the two.

## Content Addressing

Parallax uses deterministic BLAKE3 hashes over canonical JSON.

Rules:

- object keys are sorted recursively
- array order is preserved
- `undefined` fields are omitted
- mutable runtime state is excluded from identity hashing

In practice:

- reusable artifacts deduplicate by content
- non-reusable artifacts stay scoped to their run/producer identity
- actions are content-addressed from their stable planning fields
- runs are unique sessions and are not deduplicated

## Context Resolution

`getScopedContext(actionId)` only resolves objects listed in `action.declared.inputs`.

Materialization rules in v1:

- `Artifact` dependencies expose `artifact.content`
- all other dependencies expose `object.properties`

Modifiers:

- `select` filters fields
- `alias` namespaces a dependency under a local key
- key collisions throw

Parallax never silently merges conflicting fields.

## Relations

Parallax uses typed relations instead of generic edges:

- `DEPENDS_ON`
- `CAUSED`
- `PRODUCED`
- `CONSUMED`
- `PERFORMED_BY`
- `PART_OF`
- `TARGETS`
- `REPLAY_OF`
- `VIOLATES`

The most important projections are:

- dependency graph: `DEPENDS_ON`
- execution graph: `CAUSED`, `CONSUMED`, `PRODUCED`
- provenance graph: `PERFORMED_BY`, `PRODUCED`, `REPLAY_OF`, `PART_OF`

`CAUSED` means:

- action A produced an artifact
- action B declared that artifact as an input
- therefore A causally contributed to B

## Replay

Replay creates a new run.

V1 replay behavior:

- effectful completed actions are reused by default
- unchanged completed actions may be structurally shared into the replayed run
- reusable artifacts may be shared across runs
- pure actions are recomputed only when reuse is unsafe or explicitly disabled

This keeps replay cheap while preserving provenance.

## Divergence

`getDivergence(runId)` analyzes one run.

`diffRuns(runA, runB)` compares two runs.

V1 divergence categories:

- `undeclared_input_consumed`
- `declared_input_never_observed`
- `context_scope_violation`
- `effectful_action_re_executed`
- `agent_attribution_mismatch`
- `run_shape_divergence`
- `goal_drift`
- `unexpected_causal_edge`

Field-level scope violations require lightweight instrumentation. You can attach:

```typescript
properties: {
  accessedFields: {
    [dependencyObjectId]: ['fieldA', 'fieldB']
  }
}
```

Parallax will compare those fields against the dependency's `select`.

## Shared Objects

Parallax prefers references over copies.

- runs store ids
- projections resolve objects from ids
- replay reuses ids when structural sharing is valid
- reusable artifacts can appear in many runs with the same object id

This is what makes caching, replay, and provenance coherent instead of bolted on.
