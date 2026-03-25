# Wildfire Coordination Example

A reference scenario that exercises the full Parallax runtime API: ontology objects, dual-graph projections, replay with structural sharing, and divergence detection.

## Scenario

A wildfire incident coordination system processes an incoming fire alert through a chain of data fetches and analytical steps:

1. **Ingest incident alert** — fetch dispatch report
2. **Fetch weather data** — retrieve wind and temperature conditions
3. **Assess spread risk** — compute risk map from alert + weather
4. **Identify threatened regions** — filter regions above risk threshold
5. **Fetch shelter capacity** — query shelter database
6. **Fetch road closure data** — retrieve current road closures
7. **Estimate evacuation demand** — model demand from regions + shelters
8. **Recommend resource allocation** — optimize resource assignments
9. **Draft public bulletin** — generate evacuation advisory

Steps 1, 2, 5, and 6 are **effectful** (external data fetches). Steps 3, 4, 7, 8, and 9 are **pure** computations with `cachePolicy: 'recompute'`.

After the initial run completes, a **replay run** is triggered. The replay structurally shares the effectful actions (reusing their artifacts) and re-executes the pure analysis steps, creating new action objects with replay lineage.

## What it demonstrates

- **Ontology objects**: Goals, Runs, Actions, Artifacts, Agents, DivergenceRecords
- **Declared dependencies**: Each action declares its inputs via `DependencySpec`
- **Dual graphs**: Dependency graph (planning-time) vs execution graph (runtime causality)
- **Replay**: Structural sharing of effectful actions, recomputation of pure actions
- **Divergence**: The bulletin action consumes `road-closure-data` without declaring it, triggering `undeclared_input_consumed` detection
- **Cross-run diff**: `diffRuns()` compares the original and replay runs for shape divergence

## Running

```bash
# Run and print summary to console
npx tsx examples/wildfire-coordination/run.ts

# Run and export JSON
npx tsx examples/wildfire-coordination/run.ts --out examples/wildfire-coordination/output/scenario.json
```

## Export format

The exported JSON contains:

- `meta` — scenario name, timestamp, version
- `summary` — object/relation counts, shared artifact count, divergence event count
- `runs` — run metadata with action and artifact ID lists
- `objects` — all ontology objects (actions, artifacts, goals, agents, runs, divergence records)
- `relations` — all graph edges (DEPENDS_ON, CAUSED, PRODUCED, CONSUMED, PERFORMED_BY, PART_OF, TARGETS, REPLAY_OF, VIOLATES)
- `graphs.dependency` — dependency graph projection for run 1
- `graphs.execution` — execution graph projection for run 1
- `graphs.provenance` — provenance subgraph from the bulletin artifact
- `divergences` — divergence records for run 1, run 2, and cross-run diff

## Using the export for visualization

The exported JSON is designed to be consumed by an external visualization tool. A local-only video project (e.g., using Remotion) can read the JSON and render:

- Nodes colored by object kind
- Edges colored/animated by relation type
- Replay lineage highlighting
- Shared artifact emphasis
- Divergence hotspots
