import { hash } from './hash.js';
import { resolveScopedContext } from './context.js';
import { deriveCacheKey } from './caching.js';
import { relationId, validateNoCycle, validateEndpoints } from './relations.js';
import { EventRegistry, type EventHandler } from './events.js';
import { InMemoryParallaxStore } from './store/memory.js';
import { ModelInferenceExecutor } from './model.js';
import { ToolExecutor } from './tool.js';
import type { ParallaxStore } from './store.js';
import type { LLMAdapter, CreateModelActionOpts, ModelActionResult } from './llm.js';
import type { ParallaxTool, CreateToolActionOpts, ToolActionResult } from './tool.js';
import type {
  ActionExecutor,
  ActionObject,
  AgentObject,
  ArtifactObject,
  BaseObject,
  DependencySpec,
  DivergenceEvent,
  DivergenceRecord,
  GoalObject,
  GraphProjection,
  ObjectKind,
  ParallaxEventType,
  Relation,
  RelationType,
  RunObject,
  CheckpointOpts,
} from './types.js';

// ---------------------------------------------------------------------------
// Stable identity extraction — fields that participate in content addressing
// ---------------------------------------------------------------------------

function stableActionIdentity(
  props: Omit<ActionObject, 'id' | 'kind' | 'status' | 'observed' | 'createdAt'>,
): Record<string, unknown> {
  return {
    kind: 'Action',
    type: props.type,
    actionKind: props.actionKind,
    runId: props.runId,
    effectful: props.effectful,
    declared: props.declared,
    agentId: props.agentId,
    properties: props.properties,
    cachePolicy: props.cachePolicy,
  };
}

function stableArtifactIdentity(
  props: Omit<ArtifactObject, 'id' | 'kind' | 'contentHash' | 'createdAt'>,
): Record<string, unknown> {
  if (props.reusable) {
    return {
      kind: 'Artifact',
      type: props.type,
      content: props.content,
      reusable: props.reusable,
      properties: props.properties,
    };
  }

  return {
    kind: 'Artifact',
    type: props.type,
    producedByActionId: props.producedByActionId,
    runId: props.runId,
    content: props.content,
    reusable: props.reusable,
    properties: props.properties,
  };
}

// ---------------------------------------------------------------------------
// Parallax — the main runtime class
// ---------------------------------------------------------------------------

export class Parallax {
  private store: ParallaxStore;
  private executors = new Map<string, ActionExecutor>();
  private events = new EventRegistry();
  private cache = new Map<string, { outputs: Record<string, unknown>; artifactIds: string[] }>();
  private llmAdapter?: LLMAdapter;
  private toolRegistry = new Map<string, ParallaxTool>();
  private toolExecutor?: ToolExecutor;

  constructor(store?: ParallaxStore) {
    this.store = store ?? new InMemoryParallaxStore();
  }

  // =========================================================================
  // Hashing
  // =========================================================================

  hash(content: Record<string, unknown>): string {
    return hash(content);
  }

  async findByHash(h: string): Promise<BaseObject | undefined> {
    return this.store.findByHash(h);
  }

  // =========================================================================
  // Agent
  // =========================================================================

  async createAgent(
    props: Omit<AgentObject, 'id' | 'kind' | 'createdAt'>,
  ): Promise<AgentObject> {
    const stable: Record<string, unknown> = {
      kind: 'Agent',
      type: props.type,
      properties: props.properties,
      publicKey: props.publicKey,
      capabilities: props.capabilities,
    };
    const id = hash(stable);

    const existing = await this.store.getObject(id);
    if (existing) return existing as AgentObject;

    const agent: AgentObject = {
      ...props,
      id,
      kind: 'Agent',
      createdAt: new Date().toISOString(),
    };
    await this.store.putObject(agent);
    return agent;
  }

  // =========================================================================
  // Run
  // =========================================================================

  async createRun(
    agentId: string,
    opts?: { goalDescription?: string; tags?: string[] },
  ): Promise<RunObject> {
    // Runs are inherently unique per creation (not deduplicated),
    // so we include a timestamp-based nonce in the stable identity.
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const stable: Record<string, unknown> = {
      kind: 'Run',
      agentId,
      nonce,
    };
    const id = hash(stable);

    const run: RunObject = {
      id,
      kind: 'Run',
      type: 'Run',
      agentId,
      status: 'active',
      actionIds: [],
      artifactIds: [],
      tags: opts?.tags,
      properties: {},
      createdAt: new Date().toISOString(),
    };

    await this.store.putRun(run);
    await this.store.putObject(run);

    // Create agent -> run relation
    const agentObj = await this.store.getObject(agentId);
    if (agentObj) {
      await this.linkInternal('PERFORMED_BY', id, agentId);
    }

    // Optionally create a goal
    if (opts?.goalDescription) {
      const goal = await this.createGoal(id, opts.goalDescription);
      run.goalId = goal.id;
      await this.store.putRun(run);
    }

    return run;
  }

  async getRun(runId: string): Promise<RunObject> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    return run;
  }

  // =========================================================================
  // Goal
  // =========================================================================

  async createGoal(runId: string, description: string): Promise<GoalObject> {
    const stable: Record<string, unknown> = {
      kind: 'Goal',
      runId,
      description,
    };
    const id = hash(stable);

    const existing = await this.store.getObject(id);
    if (existing) return existing as GoalObject;

    const goal: GoalObject = {
      id,
      kind: 'Goal',
      type: 'Goal',
      description,
      runId,
      status: 'active',
      properties: {},
      createdAt: new Date().toISOString(),
    };
    await this.store.putObject(goal);
    await this.linkInternal('PART_OF', id, runId);
    await this.linkInternal('TARGETS', runId, id);
    return goal;
  }

  async updateGoalStatus(
    goalId: string,
    status: GoalObject['status'],
  ): Promise<void> {
    const obj = await this.store.getObject(goalId);
    if (!obj || obj.kind !== 'Goal') throw new Error(`Goal not found: ${goalId}`);
    const goal = obj as GoalObject;
    goal.status = status;
    goal.updatedAt = new Date().toISOString();
    await this.store.putObject(goal);
  }

  // =========================================================================
  // Plan action
  // =========================================================================

  async planAction(
    runId: string,
    props: Omit<ActionObject, 'id' | 'kind' | 'status' | 'observed' | 'createdAt'>,
  ): Promise<ActionObject> {
    const run = await this.getRun(runId);

    const stable = stableActionIdentity(props);
    const id = hash(stable);

    const existing = await this.store.getObject(id);
    if (existing) {
      // Action with identical stable identity exists — reuse it
      if (!run.actionIds.includes(id)) {
        run.actionIds.push(id);
        await this.store.putRun(run);
      }
      return existing as ActionObject;
    }

    const action: ActionObject = {
      ...props,
      id,
      kind: 'Action',
      status: 'planned',
      createdAt: new Date().toISOString(),
    };

    await this.store.putObject(action);

    // Append to run
    run.actionIds.push(id);
    await this.store.putRun(run);

    // Create structural relations
    await this.linkInternal('PART_OF', id, runId);

    if (action.agentId) {
      await this.linkInternal('PERFORMED_BY', id, action.agentId);
    }

    // Create DEPENDS_ON for each declared input
    for (const dep of action.declared.inputs) {
      await this.linkInternal('DEPENDS_ON', id, dep.objectId);
    }

    return action;
  }

  // =========================================================================
  // Execute action
  // =========================================================================

  registerExecutor(actionKind: string, executor: ActionExecutor): void {
    this.executors.set(actionKind, executor);
  }

  registerLLM(adapter: LLMAdapter): void {
    this.llmAdapter = adapter;
    this.registerExecutor('ModelInference', new ModelInferenceExecutor(adapter));
  }

  async createModelAction(
    runId: string,
    opts: CreateModelActionOpts,
  ): Promise<ActionObject> {
    return this.planAction(runId, {
      type: opts.model,
      actionKind: 'ModelInference',
      runId,
      effectful: true,
      declared: {
        inputs: opts.inputs ?? [],
        intendedEffect: `LLM inference with ${opts.model}`,
      },
      agentId: opts.agentId,
      properties: {
        model: opts.model,
        system: opts.system,
        prompt: opts.prompt,
        tools: opts.tools,
        responseFormat: opts.responseFormat,
        ...(opts.properties ?? {}),
      },
      cachePolicy: opts.cachePolicy,
    });
  }

  async runModelAction(
    runId: string,
    opts: CreateModelActionOpts,
  ): Promise<ModelActionResult> {
    if (!this.llmAdapter) {
      throw new Error('No LLM adapter registered. Call registerLLM() first.');
    }

    const action = await this.createModelAction(runId, opts);
    const executed =
      action.observed?.status === 'completed'
        ? action
        : await this.executeAction(action.id);

    return this.toModelActionResult(executed);
  }

  private async toModelActionResult(action: ActionObject): Promise<ModelActionResult> {
    if (!action.observed || action.observed.status !== 'completed') {
      throw new Error(`Model action ${action.id} has not completed successfully`);
    }

    // Read produced artifacts for this action
    const responseArtifact = await this.findProducedArtifact(action, 'llm-response');
    const toolRequestArtifacts = await this.findProducedArtifacts(action, 'tool-request');

    return {
      action,
      response: (responseArtifact?.content.text as string) ?? '',
      toolCalls:
        toolRequestArtifacts.length > 0
          ? toolRequestArtifacts.map((a) => ({
              name: a.content.name as string,
              arguments: a.content.arguments as Record<string, unknown>,
            }))
          : undefined,
      usage: action.observed.metrics?.tokenUsage,
    };
  }

  // =========================================================================
  // Tool execution
  // =========================================================================

  registerTool(tool: ParallaxTool): void {
    this.toolRegistry.set(tool.name, tool);
    if (!this.toolExecutor) {
      this.toolExecutor = new ToolExecutor(this.toolRegistry);
      this.registerExecutor('ToolCall', this.toolExecutor);
    }
  }

  getTool(name: string): ParallaxTool | undefined {
    return this.toolRegistry.get(name);
  }

  async createToolAction(
    runId: string,
    opts: CreateToolActionOpts,
  ): Promise<ActionObject> {
    const tool = this.toolRegistry.get(opts.toolName);
    const effectful = tool?.effectful ?? true;

    return this.planAction(runId, {
      type: opts.type,
      actionKind: 'ToolCall',
      runId,
      effectful,
      declared: opts.declared,
      agentId: opts.agentId,
      properties: {
        toolName: opts.toolName,
        toolInput: opts.toolInput,
        ...(opts.properties ?? {}),
      },
      cachePolicy: opts.cachePolicy,
    });
  }

  async runToolAction(
    runId: string,
    opts: CreateToolActionOpts,
  ): Promise<ToolActionResult> {
    if (this.toolRegistry.size === 0) {
      throw new Error('No tools registered. Call registerTool() first.');
    }

    const action = await this.createToolAction(runId, opts);
    const executed =
      action.observed?.status === 'completed'
        ? action
        : await this.executeAction(action.id);

    return this.toToolActionResult(executed);
  }

  private async toToolActionResult(action: ActionObject): Promise<ToolActionResult> {
    if (!action.observed || action.observed.status !== 'completed') {
      throw new Error(`Tool action ${action.id} has not completed successfully`);
    }
    const resultArtifact = await this.findProducedArtifact(action, 'tool-result');
    return {
      action,
      output: (resultArtifact?.content.output as Record<string, unknown>) ?? {},
    };
  }

  async executeAction(actionId: string): Promise<ActionObject> {
    const obj = await this.store.getObject(actionId);
    if (!obj || obj.kind !== 'Action') throw new Error(`Action not found: ${actionId}`);
    const action = obj as ActionObject;

    const run = await this.getRun(action.runId);
    const executor = this.executors.get(action.actionKind);
    if (!executor) {
      throw new Error(`No executor registered for actionKind: ${action.actionKind}`);
    }

    // Check cache for pure (non-effectful) actions
    if (!action.effectful && action.cachePolicy !== 'recompute') {
      const depHashes = await this.getDependencyHashes(action);
      const cacheKey = deriveCacheKey(action, depHashes);
      const cached = this.cache.get(cacheKey);
      if (cached) {
        action.status = 'completed';
        action.observed = {
          consumedInputIds: action.declared.inputs.map((d) => d.objectId),
          producedArtifactIds: cached.artifactIds,
          status: 'completed',
          cacheHit: true,
        };
        action.updatedAt = new Date().toISOString();
        await this.store.putObject(action);
        await this.syncRunArtifacts(action.runId, cached.artifactIds);
        await this.linkConsumedAndCaused(action);
        this.events.emit('action:completed', action);
        return action;
      }
    }

    // Resolve scoped context
    const context = await resolveScopedContext(this.store, action);

    // Mark as running
    action.status = 'running';
    action.updatedAt = new Date().toISOString();
    await this.store.putObject(action);
    this.events.emit('action:started', action);

    try {
      const result = await executor.execute(action, context);

      // Create produced artifacts
      const artifactIds: string[] = [];
      if (result.producedArtifacts) {
        for (const artProps of result.producedArtifacts) {
          const artifact = await this.createArtifact({
            ...artProps,
            producedByActionId: actionId,
            runId: action.runId,
          });
          artifactIds.push(artifact.id);

          // PRODUCED relation
          await this.linkInternal('PRODUCED', actionId, artifact.id);
        }
      }

      await this.linkConsumedAndCaused(action);

      // Update action with observed state
      action.status = 'completed';
      action.observed = {
        consumedInputIds: action.declared.inputs.map((d) => d.objectId),
        producedArtifactIds: artifactIds,
        status: 'completed',
        cacheHit: false,
        metrics: result.metrics,
      };
      action.updatedAt = new Date().toISOString();
      await this.store.putObject(action);

      await this.syncRunArtifacts(run.id, artifactIds);

      // Cache result for pure actions
      if (!action.effectful) {
        const depHashes = await this.getDependencyHashes(action);
        const cacheKey = deriveCacheKey(action, depHashes);
        this.cache.set(cacheKey, { outputs: result.outputs, artifactIds });
      }

      this.events.emit('action:completed', action);
      return action;
    } catch (err: unknown) {
      action.status = 'failed';
      action.observed = {
        consumedInputIds: action.declared.inputs.map((d) => d.objectId),
        producedArtifactIds: [],
        status: 'failed',
        error: {
          message: err instanceof Error ? err.message : String(err),
        },
      };
      action.updatedAt = new Date().toISOString();
      await this.store.putObject(action);
      this.events.emit('action:failed', action);
      throw err;
    }
  }

  // =========================================================================
  // Artifact
  // =========================================================================

  async createArtifact(
    props: Omit<ArtifactObject, 'id' | 'kind' | 'contentHash' | 'createdAt'>,
  ): Promise<ArtifactObject> {
    const contentHash = hash(props.content);
    const stable = stableArtifactIdentity(props);
    const id = hash(stable);

    const existing = await this.store.getObject(id);
    if (existing) {
      await this.attachArtifactToRun(id, props.runId);
      return existing as ArtifactObject;
    }

    const artifact: ArtifactObject = {
      ...props,
      id,
      kind: 'Artifact',
      contentHash,
      createdAt: new Date().toISOString(),
    };
    await this.store.putObject(artifact);
    await this.attachArtifactToRun(artifact.id, props.runId);
    return artifact;
  }

  async getArtifact(id: string): Promise<ArtifactObject> {
    const obj = await this.store.getObject(id);
    if (!obj || obj.kind !== 'Artifact') throw new Error(`Artifact not found: ${id}`);
    return obj as ArtifactObject;
  }

  // =========================================================================
  // Relations (public API)
  // =========================================================================

  async link(
    type: RelationType,
    fromId: string,
    toId: string,
    properties?: Record<string, unknown>,
  ): Promise<Relation> {
    await validateEndpoints(this.store, fromId, toId);

    if (type === 'DEPENDS_ON') {
      await validateNoCycle(this.store, fromId, toId);
    }

    const id = relationId(type, fromId, toId);
    const rel: Relation = { id, type, from: fromId, to: toId, properties };
    await this.store.putRelation(rel);
    return rel;
  }

  async getRelations(
    type: RelationType,
    fromId?: string,
    toId?: string,
  ): Promise<Relation[]> {
    return this.store.getRelations(type, fromId, toId);
  }

  // =========================================================================
  // Scoped context
  // =========================================================================

  async getScopedContext(actionId: string): Promise<Record<string, unknown>> {
    const obj = await this.store.getObject(actionId);
    if (!obj || obj.kind !== 'Action') throw new Error(`Action not found: ${actionId}`);
    return resolveScopedContext(this.store, obj as ActionObject);
  }

  // =========================================================================
  // Graph projections
  // =========================================================================

  async getDependencyGraph(runId: string): Promise<GraphProjection> {
    return this.projectGraph(runId, ['DEPENDS_ON']);
  }

  async getExecutionGraph(runId: string): Promise<GraphProjection> {
    return this.projectGraph(runId, ['CAUSED', 'CONSUMED', 'PRODUCED']);
  }

  async getProvenanceGraph(objectId: string): Promise<GraphProjection> {
    const provenanceTypes: RelationType[] = [
      'PERFORMED_BY',
      'PRODUCED',
      'REPLAY_OF',
      'PART_OF',
    ];

    const objectIds = new Set<string>();
    const relations: Relation[] = [];
    const visited = new Set<string>();
    const queue = [objectId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      objectIds.add(current);

      for (const type of provenanceTypes) {
        const fromRels = await this.store.getRelations(type, current);
        const toRels = await this.store.getRelations(type, undefined, current);
        for (const rel of [...fromRels, ...toRels]) {
          relations.push(rel);
          if (!visited.has(rel.from)) queue.push(rel.from);
          if (!visited.has(rel.to)) queue.push(rel.to);
        }
      }
    }

    const objects: BaseObject[] = [];
    for (const oid of objectIds) {
      const obj = await this.store.getObject(oid);
      if (obj) objects.push(obj);
    }

    return { objects, relations };
  }

  // =========================================================================
  // Divergence detection
  // =========================================================================

  async getDivergence(runId: string): Promise<DivergenceRecord> {
    const run = await this.getRun(runId);
    const events: DivergenceEvent[] = [];
    const goal = run.goalId
      ? ((await this.store.getObject(run.goalId)) as GoalObject | undefined)
      : undefined;

    for (const actionId of run.actionIds) {
      const obj = await this.store.getObject(actionId);
      if (!obj || obj.kind !== 'Action') continue;
      const action = obj as ActionObject;

      if (!action.observed) continue;

      // Check undeclared inputs consumed
      const declaredIds = new Set(action.declared.inputs.map((d) => d.objectId));
      for (const consumed of action.observed.consumedInputIds) {
        if (!declaredIds.has(consumed)) {
          events.push({
            type: 'undeclared_input_consumed',
            actionId: action.id,
            objectId: consumed,
            description: `Action ${action.id} consumed undeclared input ${consumed}`,
          });
        }
      }

      // Check declared inputs never observed
      const observedIds = new Set(action.observed.consumedInputIds);
      for (const dep of action.declared.inputs) {
        if (!observedIds.has(dep.objectId)) {
          events.push({
            type: 'declared_input_never_observed',
            actionId: action.id,
            objectId: dep.objectId,
            description: `Action ${action.id} declared dependency on ${dep.objectId} but never consumed it`,
          });
        }
      }

      // Check agent attribution mismatch
      if (
        action.agentId &&
        run.agentId &&
        action.agentId !== run.agentId &&
        action.actionKind !== 'SubAgentDispatch' &&
        action.actionKind !== 'SubAgentResult'
      ) {
        events.push({
          type: 'agent_attribution_mismatch',
          actionId: action.id,
          description: `Action ${action.id} attributed to agent ${action.agentId} but run belongs to agent ${run.agentId}`,
        });
      }

      // Check context scope violations using optional accessedFields instrumentation
      const accessedFields = action.properties.accessedFields;
      if (accessedFields && typeof accessedFields === 'object') {
        const accessedByObject = accessedFields as Record<string, unknown>;
        for (const dep of action.declared.inputs) {
          if (!dep.select || dep.select.length === 0) continue;
          const rawFields = accessedByObject[dep.objectId];
          if (!Array.isArray(rawFields)) continue;
          const allowed = new Set(dep.select);
          const invalid = rawFields.filter(
            (field): field is string => typeof field === 'string' && !allowed.has(field),
          );
          if (invalid.length > 0) {
            events.push({
              type: 'context_scope_violation',
              actionId: action.id,
              objectId: dep.objectId,
              description: `Action ${action.id} accessed undeclared fields [${invalid.join(', ')}] from ${dep.objectId}`,
            });
          }
        }
      }

      if (
        action.effectful &&
        action.replayOfActionId &&
        action.observed?.status === 'completed' &&
        action.observed.cacheHit !== true
      ) {
        events.push({
          type: 'effectful_action_re_executed',
          actionId: action.id,
          description: `Effectful replayed action ${action.id} was executed again instead of reusing prior artifacts`,
        });
      }

      if (
        goal &&
        (goal.status === 'drifted' ||
          (action.actionKind === 'GoalUpdate' &&
            action.properties.goalStatus === 'drifted'))
      ) {
        events.push({
          type: 'goal_drift',
          actionId: action.id,
          objectId: goal.id,
          description: `Action ${action.id} is associated with drifted goal ${goal.id}`,
        });
      }
    }

    // Check for unexpected causal edges — CAUSED relations not backed by DEPENDS_ON
    const causedRels = await this.store.getRelations('CAUSED');
    const runActionIds = new Set(run.actionIds);

    for (const caused of causedRels) {
      if (!runActionIds.has(caused.from) || !runActionIds.has(caused.to)) continue;
      const targetObj = await this.store.getObject(caused.to);
      if (!targetObj || targetObj.kind !== 'Action') continue;
      const targetAction = targetObj as ActionObject;
      const declaredSources = await this.getDeclaredProducerActionIds(targetAction);
      if (!declaredSources.has(caused.from)) {
        events.push({
          type: 'unexpected_causal_edge',
          actionId: caused.to,
          objectId: caused.from,
          description: `Causal edge ${caused.from} -> ${caused.to} has no corresponding declared dependency path`,
        });
      }
    }

    const summary =
      events.length === 0
        ? 'No divergence detected'
        : `${events.length} divergence event(s) detected`;

    const record = await this.createDivergenceRecord(runId, undefined, events, summary);

    if (events.length > 0) {
      this.events.emit('divergence:detected', record);
    }

    return record;
  }

  async diffRuns(runAId: string, runBId: string): Promise<DivergenceRecord> {
    return this.explainDivergence(runAId, runBId);
  }

  async explainDivergence(
    runAId: string,
    runBId: string,
  ): Promise<DivergenceRecord> {
    const runA = await this.getRun(runAId);
    const runB = await this.getRun(runBId);
    const events: DivergenceEvent[] = [];

    // Run-level divergence from each individual run
    const divA = await this.getDivergence(runAId);
    const divB = await this.getDivergence(runBId);
    events.push(...divA.events, ...divB.events);

    // Run shape divergence: compare action sequences
    if (runA.actionIds.length !== runB.actionIds.length) {
      events.push({
        type: 'run_shape_divergence',
        description: `Run ${runAId} has ${runA.actionIds.length} actions, run ${runBId} has ${runB.actionIds.length} actions`,
      });
    } else {
      // Compare action types at each position
      for (let i = 0; i < runA.actionIds.length; i++) {
        const actA = (await this.store.getObject(runA.actionIds[i])) as ActionObject | undefined;
        const actB = (await this.store.getObject(runB.actionIds[i])) as ActionObject | undefined;
        if (actA && actB && actA.actionKind !== actB.actionKind) {
          events.push({
            type: 'run_shape_divergence',
            actionId: actA.id,
            description: `Position ${i}: run A has ${actA.actionKind}, run B has ${actB.actionKind}`,
          });
        }
      }
    }

    // Compare dependency structures
    const depsA = await this.store.getRelations('DEPENDS_ON');
    const depsB = await this.store.getRelations('DEPENDS_ON');
    const depsASet = new Set(
      depsA
        .filter((r) => runA.actionIds.includes(r.from))
        .map((r) => `${r.from}:${r.to}`),
    );
    const depsBSet = new Set(
      depsB
        .filter((r) => runB.actionIds.includes(r.from))
        .map((r) => `${r.from}:${r.to}`),
    );

    for (const dep of depsASet) {
      if (!depsBSet.has(dep)) {
        events.push({
          type: 'run_shape_divergence',
          description: `Dependency ${dep} exists in run A but not run B`,
        });
      }
    }
    for (const dep of depsBSet) {
      if (!depsASet.has(dep)) {
        events.push({
          type: 'run_shape_divergence',
          description: `Dependency ${dep} exists in run B but not run A`,
        });
      }
    }

    // Deduplicate events
    const seen = new Set<string>();
    const uniqueEvents = events.filter((e) => {
      const key = `${e.type}:${e.actionId ?? ''}:${e.objectId ?? ''}:${e.description}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const summary =
      uniqueEvents.length === 0
        ? 'No divergence detected between runs'
        : `${uniqueEvents.length} divergence event(s) detected between runs`;

    const record = await this.createDivergenceRecord(
      runAId,
      runBId,
      uniqueEvents,
      summary,
    );

    if (uniqueEvents.length > 0) {
      this.events.emit('divergence:detected', record);
    }

    return record;
  }

  // =========================================================================
  // Replay and forking
  // =========================================================================

  async replayRun(
    runId: string,
    opts?: { skipEffectful?: boolean },
  ): Promise<RunObject> {
    const originalRun = await this.getRun(runId);
    const skipEffectful = opts?.skipEffectful ?? true;

    // Create a new run linked to the original
    const nonce = `replay-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const id = hash({ kind: 'Run', agentId: originalRun.agentId, nonce } as Record<string, unknown>);

    const newRun: RunObject = {
      id,
      kind: 'Run',
      type: 'Run',
      agentId: originalRun.agentId,
      status: 'active',
      actionIds: [],
      artifactIds: [],
      replayOfRunId: runId,
      goalId: originalRun.goalId,
      tags: originalRun.tags,
      properties: {},
      createdAt: new Date().toISOString(),
    };
    await this.store.putRun(newRun);
    await this.store.putObject(newRun);
    await this.linkInternal('REPLAY_OF', newRun.id, originalRun.id);

    // Replay each action
    for (const actionId of originalRun.actionIds) {
      const originalAction = (await this.store.getObject(actionId)) as ActionObject;
      if (!originalAction) continue;

      if (this.canStructurallyShare(originalAction, skipEffectful)) {
        await this.attachActionToRun(originalAction.id, newRun.id);
        if (originalAction.observed) {
          await this.syncRunArtifacts(newRun.id, originalAction.observed.producedArtifactIds);
        }
      } else {
        const replayAction = await this.planAction(newRun.id, {
          type: originalAction.type,
          actionKind: originalAction.actionKind,
          runId: newRun.id,
          effectful: originalAction.effectful,
          declared: originalAction.declared,
          agentId: originalAction.agentId,
          properties: originalAction.properties,
          cachePolicy: originalAction.cachePolicy,
          replayOfActionId: originalAction.id,
          replayOfRunId: runId,
        });

        // Execute if executor is registered
        const executor = this.executors.get(replayAction.actionKind);
        if (executor) {
          await this.executeAction(replayAction.id);
        }

        await this.linkInternal('REPLAY_OF', replayAction.id, originalAction.id);
      }
    }

    // Refresh run state
    const updatedRun = await this.getRun(newRun.id);
    updatedRun.status = 'replayed';
    updatedRun.updatedAt = new Date().toISOString();
    await this.store.putRun(updatedRun);

    this.events.emit('run:replayed', updatedRun);
    return updatedRun;
  }

  async forkRun(runId: string, fromActionId: string): Promise<RunObject> {
    const originalRun = await this.getRun(runId);

    // Find the index of the branch point
    const branchIndex = originalRun.actionIds.indexOf(fromActionId);
    if (branchIndex === -1) {
      throw new Error(
        `Action ${fromActionId} not found in run ${runId}`,
      );
    }

    const nonce = `fork-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const id = hash({ kind: 'Run', agentId: originalRun.agentId, nonce } as Record<string, unknown>);

    const newRun: RunObject = {
      id,
      kind: 'Run',
      type: 'Run',
      agentId: originalRun.agentId,
      status: 'active',
      actionIds: [],
      artifactIds: [],
      parentRunId: runId,
      branchFromActionId: fromActionId,
      goalId: originalRun.goalId,
      tags: originalRun.tags,
      properties: {},
      createdAt: new Date().toISOString(),
    };
    await this.store.putRun(newRun);
    await this.store.putObject(newRun);

    // Copy actions up to and including the branch point (structural sharing)
    const actionsToCopy = originalRun.actionIds.slice(0, branchIndex + 1);
    for (const actionId of actionsToCopy) {
      await this.attachActionToRun(actionId, newRun.id);
      const actionObj = (await this.store.getObject(actionId)) as ActionObject;
      if (actionObj?.observed?.producedArtifactIds) {
        await this.syncRunArtifacts(newRun.id, actionObj.observed.producedArtifactIds);
      }
    }
    await this.shareRunArtifactsForActionIds(originalRun, newRun.id, actionsToCopy);

    return this.getRun(newRun.id);
  }

  // =========================================================================
  // Checkpoints
  // =========================================================================

  async createCheckpoint(runId: string, opts: CheckpointOpts): Promise<ArtifactObject> {
    const run = await this.getRun(runId);

    let actionId = opts.actionId;
    if (!actionId) {
      const latest = await this.actions.latestForRun(runId);
      if (!latest) throw new Error(`Run ${runId} has no actions to checkpoint`);
      actionId = latest.id;
    }

    if (!run.actionIds.includes(actionId)) {
      throw new Error(`Action ${actionId} not found in run ${runId}`);
    }

    // Snapshot artifact IDs produced by actions up to and including the checkpoint action
    const branchIndex = run.actionIds.indexOf(actionId);
    const prefixActionIds = run.actionIds.slice(0, branchIndex + 1);
    const snapshotArtifactIds: string[] = [];
    for (const aid of prefixActionIds) {
      const action = (await this.store.getObject(aid)) as ActionObject;
      if (action?.observed?.producedArtifactIds) {
        for (const artId of action.observed.producedArtifactIds) {
          if (!snapshotArtifactIds.includes(artId)) {
            snapshotArtifactIds.push(artId);
          }
        }
      }
    }

    return this.createArtifact({
      type: 'checkpoint',
      producedByActionId: actionId,
      runId,
      content: {
        name: opts.name,
        actionId,
        artifactIds: snapshotArtifactIds,
        ...(opts.summary ? { summary: opts.summary } : {}),
      },
      reusable: false,
      properties: {},
    });
  }

  async getCheckpoint(runId: string, name: string): Promise<ArtifactObject | undefined> {
    const checkpoints = await this.artifacts.byType(runId, 'checkpoint');
    return checkpoints.find((c) => (c.content as Record<string, unknown>).name === name);
  }

  async listCheckpoints(runId: string): Promise<ArtifactObject[]> {
    return this.artifacts.byType(runId, 'checkpoint');
  }

  // =========================================================================
  // Branch and replay from checkpoint
  // =========================================================================

  async branchFromCheckpoint(runId: string, checkpointName: string): Promise<RunObject> {
    const checkpoint = await this.getCheckpoint(runId, checkpointName);
    if (!checkpoint) {
      throw new Error(`Checkpoint "${checkpointName}" not found in run ${runId}`);
    }
    const actionId = (checkpoint.content as Record<string, unknown>).actionId as string;
    return this.forkRun(runId, actionId);
  }

  async branchFromAction(runId: string, actionId: string): Promise<RunObject> {
    return this.forkRun(runId, actionId);
  }

  async replayFromCheckpoint(
    runId: string,
    checkpointName: string,
    opts?: { skipEffectful?: boolean },
  ): Promise<RunObject> {
    const checkpoint = await this.getCheckpoint(runId, checkpointName);
    if (!checkpoint) {
      throw new Error(`Checkpoint "${checkpointName}" not found in run ${runId}`);
    }
    const actionId = (checkpoint.content as Record<string, unknown>).actionId as string;
    return this.replayFromAction(runId, actionId, opts);
  }

  async replayFromAction(
    runId: string,
    fromActionId: string,
    opts?: { skipEffectful?: boolean },
  ): Promise<RunObject> {
    const originalRun = await this.getRun(runId);
    const skipEffectful = opts?.skipEffectful ?? true;

    const branchIndex = originalRun.actionIds.indexOf(fromActionId);
    if (branchIndex === -1) {
      throw new Error(`Action ${fromActionId} not found in run ${runId}`);
    }

    const nonce = `replay-from-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const id = hash({ kind: 'Run', agentId: originalRun.agentId, nonce } as Record<string, unknown>);

    const newRun: RunObject = {
      id,
      kind: 'Run',
      type: 'Run',
      agentId: originalRun.agentId,
      status: 'active',
      actionIds: [],
      artifactIds: [],
      parentRunId: runId,
      branchFromActionId: fromActionId,
      replayOfRunId: runId,
      goalId: originalRun.goalId,
      tags: originalRun.tags,
      properties: {},
      createdAt: new Date().toISOString(),
    };
    await this.store.putRun(newRun);
    await this.store.putObject(newRun);
    await this.linkInternal('REPLAY_OF', newRun.id, originalRun.id);

    // Prefix: structurally share actions up to and including the branch point
    const prefixActionIds = originalRun.actionIds.slice(0, branchIndex + 1);
    for (const actionId of prefixActionIds) {
      await this.attachActionToRun(actionId, newRun.id);
      const actionObj = (await this.store.getObject(actionId)) as ActionObject;
      if (actionObj?.observed?.producedArtifactIds) {
        await this.syncRunArtifacts(newRun.id, actionObj.observed.producedArtifactIds);
      }
    }
    await this.shareRunArtifactsForActionIds(originalRun, newRun.id, prefixActionIds);

    // Tail: replay actions after the branch point
    const tailActionIds = originalRun.actionIds.slice(branchIndex + 1);
    for (const actionId of tailActionIds) {
      const originalAction = (await this.store.getObject(actionId)) as ActionObject;
      if (!originalAction) continue;

      const canShare = this.canStructurallyShare(originalAction, skipEffectful);

      if (canShare) {
        await this.attachActionToRun(originalAction.id, newRun.id);
        if (originalAction.observed) {
          await this.syncRunArtifacts(newRun.id, originalAction.observed.producedArtifactIds);
        }
        await this.shareRunArtifactsForActionIds(originalRun, newRun.id, [originalAction.id]);
      } else {
        const replayAction = await this.planAction(newRun.id, {
          type: originalAction.type,
          actionKind: originalAction.actionKind,
          runId: newRun.id,
          effectful: originalAction.effectful,
          declared: originalAction.declared,
          agentId: originalAction.agentId,
          properties: originalAction.properties,
          cachePolicy: originalAction.cachePolicy,
          replayOfActionId: originalAction.id,
          replayOfRunId: runId,
        });

        const executor = this.executors.get(replayAction.actionKind);
        if (executor) {
          await this.executeAction(replayAction.id);
        }

        await this.linkInternal('REPLAY_OF', replayAction.id, originalAction.id);
      }
    }

    const updatedRun = await this.getRun(newRun.id);
    updatedRun.status = 'replayed';
    updatedRun.updatedAt = new Date().toISOString();
    await this.store.putRun(updatedRun);

    this.events.emit('run:replayed', updatedRun);
    return updatedRun;
  }

  // =========================================================================
  // Events
  // =========================================================================

  on(event: ParallaxEventType, handler: EventHandler): void {
    this.events.on(event, handler);
  }

  // =========================================================================
  // Operational query APIs
  // =========================================================================

  actions = {
    forRun: async (runId: string): Promise<ActionObject[]> => {
      const run = await this.getRun(runId);
      const results: ActionObject[] = [];
      for (const id of run.actionIds) {
        const obj = await this.store.getObject(id);
        if (obj?.kind === 'Action') results.push(obj as ActionObject);
      }
      return results;
    },

    forAgent: async (agentId: string): Promise<ActionObject[]> => {
      const all = await this.store.query('Action', { agentId });
      return all as ActionObject[];
    },

    thatConsumed: async (artifactId: string): Promise<ActionObject[]> => {
      const rels = await this.store.getRelations('CONSUMED', undefined, artifactId);
      const results: ActionObject[] = [];
      for (const rel of rels) {
        const obj = await this.store.getObject(rel.from);
        if (obj?.kind === 'Action') results.push(obj as ActionObject);
      }
      return results;
    },

    thatProduced: async (artifactId: string): Promise<ActionObject[]> => {
      const rels = await this.store.getRelations('PRODUCED', undefined, artifactId);
      const results: ActionObject[] = [];
      for (const rel of rels) {
        const obj = await this.store.getObject(rel.from);
        if (obj?.kind === 'Action') results.push(obj as ActionObject);
      }
      return results;
    },

    latestForRun: async (runId: string, type?: string): Promise<ActionObject | undefined> => {
      const all = await this.actions.forRun(runId);
      const filtered = type ? all.filter((a) => a.type === type) : all;
      return filtered.length > 0 ? filtered[filtered.length - 1] : undefined;
    },

    byType: async (runId: string, type: string): Promise<ActionObject[]> => {
      const all = await this.actions.forRun(runId);
      return all.filter((a) => a.type === type);
    },

    thatViolatedScope: async (runId: string): Promise<ActionObject[]> => {
      const div = await this.getDivergence(runId);
      const violationActionIds = new Set(
        div.events
          .filter(
            (e) =>
              e.type === 'context_scope_violation' ||
              e.type === 'undeclared_input_consumed',
          )
          .map((e) => e.actionId)
          .filter(Boolean),
      );
      const results: ActionObject[] = [];
      for (const id of violationActionIds) {
        const obj = await this.store.getObject(id!);
        if (obj?.kind === 'Action') results.push(obj as ActionObject);
      }
      return results;
    },
  };

  artifacts = {
    forRun: async (runId: string): Promise<ArtifactObject[]> => {
      const run = await this.getRun(runId);
      const results: ArtifactObject[] = [];
      for (const id of run.artifactIds) {
        const obj = await this.store.getObject(id);
        if (obj?.kind === 'Artifact') results.push(obj as ArtifactObject);
      }
      return results;
    },

    latestForRun: async (runId: string, type?: string): Promise<ArtifactObject | undefined> => {
      const all = await this.artifacts.forRun(runId);
      const filtered = type ? all.filter((a) => a.type === type) : all;
      return filtered.length > 0 ? filtered[filtered.length - 1] : undefined;
    },

    byType: async (runId: string, type: string): Promise<ArtifactObject[]> => {
      const all = await this.artifacts.forRun(runId);
      return all.filter((a) => a.type === type);
    },

    forGoal: async (goalId: string): Promise<ArtifactObject[]> => {
      // Find runs that target this goal, collect their artifacts
      const targetRels = await this.store.getRelations('TARGETS', undefined, goalId);
      const results: ArtifactObject[] = [];
      const seen = new Set<string>();
      for (const rel of targetRels) {
        const run = await this.store.getRun(rel.from);
        if (!run) continue;
        for (const artId of run.artifactIds) {
          if (seen.has(artId)) continue;
          seen.add(artId);
          const obj = await this.store.getObject(artId);
          if (obj?.kind === 'Artifact') results.push(obj as ArtifactObject);
        }
      }
      return results;
    },

    sharedAcrossRuns: async (): Promise<ArtifactObject[]> => {
      const allArtifacts = (await this.store.query('Artifact')) as ArtifactObject[];
      const reusable = allArtifacts.filter((a) => a.reusable);

      // Find artifacts referenced by multiple runs
      const allRuns = (await this.store.query('Run')) as RunObject[];
      const artifactRunCount = new Map<string, number>();
      for (const run of allRuns) {
        for (const artId of run.artifactIds) {
          artifactRunCount.set(artId, (artifactRunCount.get(artId) ?? 0) + 1);
        }
      }

      return reusable.filter((a) => (artifactRunCount.get(a.id) ?? 0) > 1);
    },
  };

  runs = {
    forAgent: async (agentId: string): Promise<RunObject[]> => {
      const all = await this.store.query('Run', { agentId });
      return all as RunObject[];
    },

    replayChain: async (runId: string): Promise<RunObject[]> => {
      const chain: RunObject[] = [];
      let currentId: string | undefined = runId;
      const visited = new Set<string>();

      while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        const run = await this.store.getRun(currentId);
        if (!run) break;
        chain.unshift(run);
        currentId = run.replayOfRunId;
      }

      return chain;
    },
  };

  // =========================================================================
  // Internal helpers
  // =========================================================================

  private canStructurallyShare(action: ActionObject, skipEffectful: boolean): boolean {
    return (
      !!action.observed &&
      (action.effectful
        ? skipEffectful
        : action.cachePolicy !== 'recompute')
    );
  }

  private async findProducedArtifact(
    action: ActionObject,
    artifactType: string,
  ): Promise<ArtifactObject | undefined> {
    const ids = action.observed?.producedArtifactIds ?? [];
    for (const id of ids) {
      const obj = await this.store.getObject(id);
      if (obj?.kind === 'Artifact' && (obj as ArtifactObject).type === artifactType) {
        return obj as ArtifactObject;
      }
    }
    return undefined;
  }

  private async findProducedArtifacts(
    action: ActionObject,
    artifactType: string,
  ): Promise<ArtifactObject[]> {
    const ids = action.observed?.producedArtifactIds ?? [];
    const results: ArtifactObject[] = [];
    for (const id of ids) {
      const obj = await this.store.getObject(id);
      if (obj?.kind === 'Artifact' && (obj as ArtifactObject).type === artifactType) {
        results.push(obj as ArtifactObject);
      }
    }
    return results;
  }

  /**
   * Internal link — skips endpoint validation for objects we just created.
   */
  private async linkInternal(
    type: RelationType,
    fromId: string,
    toId: string,
    properties?: Record<string, unknown>,
  ): Promise<Relation> {
    if (type === 'DEPENDS_ON') {
      await validateNoCycle(this.store, fromId, toId);
    }

    const id = relationId(type, fromId, toId);
    const rel: Relation = { id, type, from: fromId, to: toId, properties };
    await this.store.putRelation(rel);
    return rel;
  }

  private async projectGraph(
    runId: string,
    relationTypes: RelationType[],
  ): Promise<GraphProjection> {
    const run = await this.getRun(runId);
    const objectIds = new Set<string>([
      ...run.actionIds,
      ...run.artifactIds,
    ]);

    const relations: Relation[] = [];
    for (const type of relationTypes) {
      const rels = await this.store.getRelations(type);
      for (const rel of rels) {
        // Include relation if at least one endpoint is in the run
        if (objectIds.has(rel.from) || objectIds.has(rel.to)) {
          relations.push(rel);
          objectIds.add(rel.from);
          objectIds.add(rel.to);
        }
      }
    }

    const objects: BaseObject[] = [];
    for (const oid of objectIds) {
      const obj = await this.store.getObject(oid);
      if (obj) objects.push(obj);
    }

    return { objects, relations };
  }

  private async getDependencyHashes(action: ActionObject): Promise<string[]> {
    const hashes: string[] = [];
    for (const dep of action.declared.inputs) {
      const obj = await this.store.getObject(dep.objectId);
      if (obj) {
        hashes.push(obj.id);
      }
    }
    return hashes;
  }

  private async getDeclaredProducerActionIds(action: ActionObject): Promise<Set<string>> {
    const producerIds = new Set<string>();
    for (const dep of action.declared.inputs) {
      const obj = await this.store.getObject(dep.objectId);
      if (obj?.kind === 'Artifact') {
        const artifact = obj as ArtifactObject;
        if (artifact.producedByActionId) {
          producerIds.add(artifact.producedByActionId);
        }
      }
    }
    return producerIds;
  }

  private async linkConsumedAndCaused(action: ActionObject): Promise<void> {
    for (const dep of action.declared.inputs) {
      await this.linkInternal('CONSUMED', action.id, dep.objectId);
      const obj = await this.store.getObject(dep.objectId);
      if (obj?.kind === 'Artifact') {
        const artifact = obj as ArtifactObject;
        if (artifact.producedByActionId && artifact.producedByActionId !== action.id) {
          await this.linkInternal('CAUSED', artifact.producedByActionId, action.id);
        }
      }
    }
  }

  private async attachActionToRun(actionId: string, runId: string): Promise<void> {
    const run = await this.getRun(runId);
    if (!run.actionIds.includes(actionId)) {
      run.actionIds.push(actionId);
      await this.store.putRun(run);
    }
    await this.linkInternal('PART_OF', actionId, runId);
  }

  private async attachArtifactToRun(artifactId: string, runId: string): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run) return;
    if (!run.artifactIds.includes(artifactId)) {
      run.artifactIds.push(artifactId);
      await this.store.putRun(run);
    }
    await this.linkInternal('PART_OF', artifactId, runId);
  }

  private async syncRunArtifacts(runId: string, artifactIds: string[]): Promise<void> {
    for (const artifactId of artifactIds) {
      await this.attachArtifactToRun(artifactId, runId);
    }
  }

  private async shareRunArtifactsForActionIds(
    originalRun: RunObject,
    runId: string,
    actionIds: string[],
  ): Promise<void> {
    const actionIdSet = new Set(actionIds);
    for (const artifactId of originalRun.artifactIds) {
      const obj = await this.store.getObject(artifactId);
      if (!obj || obj.kind !== 'Artifact') continue;
      const artifact = obj as ArtifactObject;
      if (artifact.producedByActionId && actionIdSet.has(artifact.producedByActionId)) {
        await this.attachArtifactToRun(artifact.id, runId);
      }
    }
  }

  private async createDivergenceRecord(
    runId: string,
    comparedRunId: string | undefined,
    events: DivergenceEvent[],
    summary: string,
  ): Promise<DivergenceRecord> {
    const stable: Record<string, unknown> = {
      kind: 'DivergenceRecord',
      runId,
      comparedRunId,
      events,
      summary,
    };
    const id = hash(stable);

    const record: DivergenceRecord = {
      id,
      kind: 'DivergenceRecord',
      type: 'DivergenceRecord',
      runId,
      comparedRunId,
      events,
      summary,
      properties: {},
      createdAt: new Date().toISOString(),
    };
    await this.store.putObject(record);

    // Create VIOLATES relations for each event that references an action
    for (const event of events) {
      if (event.actionId) {
        await this.linkInternal('VIOLATES', record.id, event.actionId);
      }
    }

    return record;
  }
}
