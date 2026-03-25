// ---------------------------------------------------------------------------
// Object kinds and enums
// ---------------------------------------------------------------------------

export type ObjectKind =
  | 'Action'
  | 'Agent'
  | 'Artifact'
  | 'Goal'
  | 'Run'
  | 'DivergenceRecord';

export type ActionKind =
  | 'Decision'
  | 'ToolCall'
  | 'ModelInference'
  | 'SubAgentDispatch'
  | 'SubAgentResult'
  | 'MemoryWrite'
  | 'HumanApproval'
  | 'GoalUpdate'
  | 'GuardrailViolation'
  | (string & {});

export type ObjectStatus =
  | 'planned'
  | 'ready'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'replayed';

export type RelationType =
  | 'DEPENDS_ON'
  | 'CAUSED'
  | 'PRODUCED'
  | 'CONSUMED'
  | 'PERFORMED_BY'
  | 'PART_OF'
  | 'TARGETS'
  | 'REPLAY_OF'
  | 'VIOLATES';

export type DivergenceType =
  | 'undeclared_input_consumed'
  | 'declared_input_never_observed'
  | 'context_scope_violation'
  | 'effectful_action_re_executed'
  | 'agent_attribution_mismatch'
  | 'run_shape_divergence'
  | 'goal_drift'
  | 'unexpected_causal_edge';

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

export interface DependencySpec {
  objectId: string;
  select?: string[];
  alias?: string;
}

export interface ExecutionMetrics {
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  tokenUsage?: { input: number; output: number };
  costUsd?: number;
}

// ---------------------------------------------------------------------------
// Base object — every ontology object extends this
// ---------------------------------------------------------------------------

export interface BaseObject {
  id: string;
  kind: ObjectKind;
  type: string;
  agentId?: string;
  createdAt: string;
  updatedAt?: string;
  effectful?: boolean;
  signature?: string;
  labels?: string[];
  properties: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export interface ActionObject extends BaseObject {
  kind: 'Action';
  actionKind: ActionKind;
  runId: string;
  status: ObjectStatus;
  effectful: boolean;

  declared: {
    inputs: DependencySpec[];
    expectedOutputs?: string[];
    intendedEffect?: string;
  };

  observed?: {
    consumedInputIds: string[];
    producedArtifactIds: string[];
    status: 'completed' | 'failed' | 'skipped';
    metrics?: ExecutionMetrics;
    error?: { message: string; code?: string };
    cacheHit?: boolean;
  };

  replayOfActionId?: string;
  replayOfRunId?: string;
  attempt?: number;
  cachePolicy?: 'recompute' | 'reuse' | 'auto';
}

// ---------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------

export interface ArtifactObject extends BaseObject {
  kind: 'Artifact';
  producedByActionId: string;
  runId: string;
  content: Record<string, unknown>;
  contentHash: string;
  reusable: boolean;
}

// ---------------------------------------------------------------------------
// Goal
// ---------------------------------------------------------------------------

export interface GoalObject extends BaseObject {
  kind: 'Goal';
  description: string;
  runId: string;
  status: 'active' | 'achieved' | 'abandoned' | 'drifted';
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export interface AgentObject extends BaseObject {
  kind: 'Agent';
  publicKey?: string;
  capabilities?: string[];
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export interface RunObject extends BaseObject {
  kind: 'Run';
  agentId: string;
  goalId?: string;
  status: 'active' | 'completed' | 'failed' | 'replayed';
  actionIds: string[];
  artifactIds: string[];
  parentRunId?: string;
  replayOfRunId?: string;
  branchFromActionId?: string;
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Divergence
// ---------------------------------------------------------------------------

export interface DivergenceEvent {
  type: DivergenceType;
  actionId?: string;
  objectId?: string;
  description: string;
}

export interface DivergenceRecord extends BaseObject {
  kind: 'DivergenceRecord';
  runId: string;
  comparedRunId?: string;
  events: DivergenceEvent[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Relation
// ---------------------------------------------------------------------------

export interface Relation {
  id: string;
  type: RelationType;
  from: string;
  to: string;
  properties?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Executor interface
// ---------------------------------------------------------------------------

export interface ActionExecutor {
  canExecute(action: ActionObject): boolean;
  execute(
    action: ActionObject,
    context: Record<string, unknown>,
  ): Promise<{
    outputs: Record<string, unknown>;
    producedArtifacts?: Omit<
      ArtifactObject,
      'id' | 'kind' | 'producedByActionId' | 'runId' | 'contentHash' | 'createdAt'
    >[];
  }>;
}

// ---------------------------------------------------------------------------
// Graph projection result
// ---------------------------------------------------------------------------

export interface GraphProjection {
  objects: BaseObject[];
  relations: Relation[];
}

// ---------------------------------------------------------------------------
// Parallax event types
// ---------------------------------------------------------------------------

export type ParallaxEventType =
  | 'action:started'
  | 'action:completed'
  | 'action:failed'
  | 'run:replayed'
  | 'divergence:detected';
