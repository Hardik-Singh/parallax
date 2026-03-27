import type { ActionExecutor, ActionObject, DependencySpec, ExecutionMetrics } from './types.js';

// ---------------------------------------------------------------------------
// Tool types
// ---------------------------------------------------------------------------

export interface ParallaxTool {
  name: string;
  description?: string;
  effectful?: boolean;
  execute(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface CreateToolActionOpts {
  type: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
  declared: {
    inputs: DependencySpec[];
    expectedOutputs?: string[];
    intendedEffect?: string;
  };
  agentId?: string;
  cachePolicy?: 'recompute' | 'reuse' | 'auto';
  properties?: Record<string, unknown>;
}

export interface ToolActionResult {
  action: ActionObject;
  output: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// ToolExecutor — registered for the 'ToolCall' actionKind
// ---------------------------------------------------------------------------

export class ToolExecutor implements ActionExecutor {
  constructor(private tools: Map<string, ParallaxTool>) {}

  canExecute(action: ActionObject): boolean {
    return action.actionKind === 'ToolCall';
  }

  async execute(action: ActionObject, context: Record<string, unknown>) {
    const toolName = action.properties.toolName as string;
    const tool = this.tools.get(toolName);
    if (!tool) throw new Error(`Tool not found: ${toolName}`);

    const startedAt = new Date();
    const toolInput = (action.properties.toolInput as Record<string, unknown>) ?? {};
    const output = await tool.execute({ ...toolInput, ...context });
    const completedAt = new Date();
    const durationMs = completedAt.getTime() - startedAt.getTime();

    const producedArtifacts: Array<{
      type: string;
      content: Record<string, unknown>;
      reusable: boolean;
      properties: Record<string, unknown>;
    }> = [
      {
        type: 'tool-request',
        content: { toolName, input: toolInput },
        reusable: false,
        properties: {},
      },
      {
        type: 'tool-result',
        content: { toolName, output },
        reusable: false,
        properties: {},
      },
    ];

    const metrics: ExecutionMetrics = {
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs,
    };

    return { outputs: { output }, producedArtifacts, metrics };
  }
}
