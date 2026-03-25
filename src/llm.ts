import type { ActionObject, DependencySpec } from './types.js';

// ---------------------------------------------------------------------------
// LLM adapter types
// ---------------------------------------------------------------------------

export interface LLMToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface LLMToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMGenerateInput {
  model: string;
  system?: string;
  prompt: string;
  tools?: LLMToolDefinition[];
  responseFormat?: 'text' | 'json';
}

export interface LLMGenerateOutput {
  output: string;
  toolCalls?: LLMToolCall[];
  usage?: { input: number; output: number };
  raw?: unknown;
}

export interface LLMAdapter {
  generate(input: LLMGenerateInput): Promise<LLMGenerateOutput>;
}

// ---------------------------------------------------------------------------
// Helper option / result types
// ---------------------------------------------------------------------------

export interface CreateModelActionOpts {
  model: string;
  prompt: string;
  system?: string;
  tools?: LLMToolDefinition[];
  responseFormat?: 'text' | 'json';
  inputs?: DependencySpec[];
  agentId?: string;
  properties?: Record<string, unknown>;
  cachePolicy?: 'recompute' | 'reuse' | 'auto';
}

export interface ModelActionResult {
  action: ActionObject;
  response: string;
  toolCalls?: LLMToolCall[];
  usage?: { input: number; output: number };
}
