import type { LLMAdapter, LLMToolDefinition } from './llm.js';
import type { ActionExecutor, ActionObject, ExecutionMetrics } from './types.js';

export class ModelInferenceExecutor implements ActionExecutor {
  constructor(private adapter: LLMAdapter) {}

  canExecute(action: ActionObject): boolean {
    return action.actionKind === 'ModelInference';
  }

  async execute(action: ActionObject, _context: Record<string, unknown>) {
    const startedAt = new Date();

    const result = await this.adapter.generate({
      model: action.properties.model as string,
      system: action.properties.system as string | undefined,
      prompt: action.properties.prompt as string,
      tools: action.properties.tools as LLMToolDefinition[] | undefined,
      responseFormat: action.properties.responseFormat as 'text' | 'json' | undefined,
    });

    const completedAt = new Date();
    const durationMs = completedAt.getTime() - startedAt.getTime();

    const producedArtifacts: Array<{
      type: string;
      content: Record<string, unknown>;
      reusable: boolean;
      properties: Record<string, unknown>;
    }> = [
      {
        type: 'llm-response',
        content: { text: result.output, model: action.properties.model as string },
        reusable: false,
        properties: {},
      },
    ];

    if (result.toolCalls) {
      for (const tc of result.toolCalls) {
        producedArtifacts.push({
          type: 'tool-request',
          content: { name: tc.name, arguments: tc.arguments },
          reusable: false,
          properties: {},
        });
      }
    }

    const metrics: ExecutionMetrics = {
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs,
      tokenUsage: result.usage,
    };

    return {
      outputs: {
        response: result.output,
        toolCalls: result.toolCalls,
        usage: result.usage,
        raw: result.raw,
      },
      producedArtifacts,
      metrics,
    };
  }
}
