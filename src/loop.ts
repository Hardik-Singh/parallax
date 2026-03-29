import type { Parallax } from './parallax.js';
import type { CreateModelActionOpts, ModelActionResult } from './llm.js';
import type { CreateToolActionOpts, ToolActionResult } from './tool.js';
import type { RunObject, ActionObject, ArtifactObject } from './types.js';

// ---------------------------------------------------------------------------
// Agent loop decision types
// ---------------------------------------------------------------------------

export interface AgentLoopDecision {
  type: 'model' | 'tool' | 'stop';
  reason?: string;
  model?: CreateModelActionOpts;
  tool?: CreateToolActionOpts;
}

// ---------------------------------------------------------------------------
// Loop driver — user-provided decision function
// ---------------------------------------------------------------------------

export type AgentLoopDriver = (state: {
  run: RunObject;
  actions: ActionObject[];
  artifacts: ArtifactObject[];
  iteration: number;
}) => Promise<AgentLoopDecision>;

// ---------------------------------------------------------------------------
// Loop step result — what each iteration produced
// ---------------------------------------------------------------------------

export type AgentLoopStepResult =
  | { type: 'model'; result: ModelActionResult }
  | { type: 'tool'; result: ToolActionResult }
  | { type: 'stop'; reason?: string };

// ---------------------------------------------------------------------------
// Loop result
// ---------------------------------------------------------------------------

export interface AgentLoopResult {
  run: RunObject;
  iterations: number;
  steps: AgentLoopStepResult[];
  stoppedBy: 'driver' | 'maxIterations';
}

// ---------------------------------------------------------------------------
// Loop options
// ---------------------------------------------------------------------------

export interface AgentLoopOpts {
  driver: AgentLoopDriver;
  maxIterations?: number;
}

// ---------------------------------------------------------------------------
// runAgentLoop — the core orchestration helper
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ITERATIONS = 100;

export async function runAgentLoop(
  parallax: Parallax,
  runId: string,
  opts: AgentLoopOpts,
): Promise<AgentLoopResult> {
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const steps: AgentLoopStepResult[] = [];

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Gather current run state
    const run = await parallax.getRun(runId);
    const actions = await parallax.actions.forRun(runId);
    const artifacts = await parallax.artifacts.forRun(runId);

    // Ask the driver what to do next
    const decision = await opts.driver({ run, actions, artifacts, iteration });

    if (decision.type === 'stop') {
      steps.push({ type: 'stop', reason: decision.reason });
      const finalRun = await parallax.getRun(runId);
      return { run: finalRun, iterations: iteration + 1, steps, stoppedBy: 'driver' };
    }

    // Inject loop metadata into the action properties
    const loopMeta: Record<string, unknown> = {
      loopIteration: iteration,
    };
    if (decision.reason) {
      loopMeta.loopReason = decision.reason;
    }

    if (decision.type === 'model') {
      if (!decision.model) {
        throw new Error(`Loop iteration ${iteration}: decision type is 'model' but no model opts provided`);
      }
      const modelOpts: CreateModelActionOpts = {
        ...decision.model,
        properties: { ...decision.model.properties, ...loopMeta },
      };
      const result = await parallax.runModelAction(runId, modelOpts);
      steps.push({ type: 'model', result });
    } else if (decision.type === 'tool') {
      if (!decision.tool) {
        throw new Error(`Loop iteration ${iteration}: decision type is 'tool' but no tool opts provided`);
      }
      const toolOpts: CreateToolActionOpts = {
        ...decision.tool,
        properties: { ...decision.tool.properties, ...loopMeta },
      };
      const result = await parallax.runToolAction(runId, toolOpts);
      steps.push({ type: 'tool', result });
    } else {
      throw new Error(`Loop iteration ${iteration}: unknown decision type '${(decision as any).type}'`);
    }
  }

  // Hit max iterations
  const finalRun = await parallax.getRun(runId);
  return { run: finalRun, iterations: maxIterations, steps, stoppedBy: 'maxIterations' };
}
