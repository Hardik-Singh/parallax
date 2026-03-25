import type { Parallax } from '../../src/index.ts';
import type {
  BaseObject,
  Relation,
  RelationType,
  RunObject,
  DivergenceRecord,
  GraphProjection,
} from '../../src/index.ts';

// ---------------------------------------------------------------------------
// Export types
// ---------------------------------------------------------------------------

export interface ScenarioExport {
  meta: {
    scenario: string;
    generatedAt: string;
    version: string;
  };
  summary: {
    objectCounts: Record<string, number>;
    relationCounts: Record<string, number>;
    totalRuns: number;
    totalActions: number;
    totalArtifacts: number;
    totalRelations: number;
    sharedArtifactCount: number;
    divergenceEventCount: number;
    replayChainLength: number;
  };
  runs: Array<{
    id: string;
    status: string;
    replayOfRunId?: string;
    parentRunId?: string;
    goalId?: string;
    actionIds: string[];
    artifactIds: string[];
  }>;
  objects: BaseObject[];
  relations: Relation[];
  graphs: {
    dependency: GraphProjection;
    execution: GraphProjection;
    provenance: GraphProjection;
  };
  divergences: DivergenceRecord[];
}

// ---------------------------------------------------------------------------
// Collect all relations from the store across known types
// ---------------------------------------------------------------------------

const ALL_RELATION_TYPES: RelationType[] = [
  'DEPENDS_ON',
  'CAUSED',
  'PRODUCED',
  'CONSUMED',
  'PERFORMED_BY',
  'PART_OF',
  'TARGETS',
  'REPLAY_OF',
  'VIOLATES',
];

async function collectAllRelations(p: Parallax): Promise<Relation[]> {
  const seen = new Set<string>();
  const relations: Relation[] = [];
  for (const type of ALL_RELATION_TYPES) {
    for (const rel of await p.getRelations(type)) {
      if (!seen.has(rel.id)) {
        seen.add(rel.id);
        relations.push(rel);
      }
    }
  }
  return relations;
}

// ---------------------------------------------------------------------------
// Build the export
// ---------------------------------------------------------------------------

export async function exportScenario(
  p: Parallax,
  runs: RunObject[],
  divergences: DivergenceRecord[],
  provenanceObjectId: string,
): Promise<ScenarioExport> {
  // Collect objects from all runs
  const objectMap = new Map<string, BaseObject>();

  for (const run of runs) {
    objectMap.set(run.id, run);

    for (const action of await p.actions.forRun(run.id)) {
      objectMap.set(action.id, action);
    }
    for (const artifact of await p.artifacts.forRun(run.id)) {
      objectMap.set(artifact.id, artifact);
    }
  }

  // Add divergence records
  for (const div of divergences) {
    objectMap.set(div.id, div);
  }

  // Add goals
  for (const run of runs) {
    if (run.goalId) {
      const goal = await p.findByHash(run.goalId);
      if (goal) objectMap.set(goal.id, goal);
    }
  }

  // Add agents
  for (const run of runs) {
    const agent = await p.findByHash(run.agentId);
    if (agent) objectMap.set(agent.id, agent);
  }

  const objects = [...objectMap.values()];
  const relations = await collectAllRelations(p);

  // Object counts by kind
  const objectCounts: Record<string, number> = {};
  for (const obj of objects) {
    objectCounts[obj.kind] = (objectCounts[obj.kind] ?? 0) + 1;
  }

  // Relation counts by type
  const relationCounts: Record<string, number> = {};
  for (const rel of relations) {
    relationCounts[rel.type] = (relationCounts[rel.type] ?? 0) + 1;
  }

  // Shared artifacts
  const sharedArtifacts = await p.artifacts.sharedAcrossRuns();

  // Replay chain from last run
  const lastRun = runs[runs.length - 1];
  const replayChain = await p.runs.replayChain(lastRun.id);

  // Graph projections (use first run for dependency/execution)
  const firstRun = runs[0];
  const dependency = await p.getDependencyGraph(firstRun.id);
  const execution = await p.getExecutionGraph(firstRun.id);
  const provenance = await p.getProvenanceGraph(provenanceObjectId);

  // Total divergence events
  let divergenceEventCount = 0;
  for (const div of divergences) {
    divergenceEventCount += div.events.length;
  }

  // Count actions and artifacts (deduplicated across runs)
  const actionIds = new Set<string>();
  const artifactIds = new Set<string>();
  for (const run of runs) {
    for (const id of run.actionIds) actionIds.add(id);
    for (const id of run.artifactIds) artifactIds.add(id);
  }

  return {
    meta: {
      scenario: 'Wildfire Evacuation Coordination',
      generatedAt: new Date().toISOString(),
      version: '0.1.0',
    },
    summary: {
      objectCounts,
      relationCounts,
      totalRuns: runs.length,
      totalActions: actionIds.size,
      totalArtifacts: artifactIds.size,
      totalRelations: relations.length,
      sharedArtifactCount: sharedArtifacts.length,
      divergenceEventCount,
      replayChainLength: replayChain.length,
    },
    runs: runs.map((run) => ({
      id: run.id,
      status: run.status,
      replayOfRunId: run.replayOfRunId,
      parentRunId: run.parentRunId,
      goalId: run.goalId,
      actionIds: run.actionIds,
      artifactIds: run.artifactIds,
    })),
    objects,
    relations,
    graphs: { dependency, execution, provenance },
    divergences,
  };
}
