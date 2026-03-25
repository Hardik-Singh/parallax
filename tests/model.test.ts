import { describe, it, expect, beforeEach } from 'vitest';
import { Parallax } from '../src/parallax.js';
import type { LLMAdapter } from '../src/llm.js';
import type { ArtifactObject } from '../src/types.js';

describe('ModelInference', () => {
  let p: Parallax;
  let agentId: string;
  let runId: string;
  let generateCallCount: number;

  const mockAdapter: LLMAdapter = {
    generate: async (input) => {
      generateCallCount++;
      return {
        output: `Response to: ${input.prompt}`,
        usage: { input: 100, output: 50 },
      };
    },
  };

  beforeEach(async () => {
    generateCallCount = 0;
    p = new Parallax();
    p.registerLLM(mockAdapter);
    const agent = await p.createAgent({ type: 'Agent', properties: {} });
    agentId = agent.id;
    const run = await p.createRun(agentId);
    runId = run.id;
  });

  it('model action produces llm-response artifact', async () => {
    const result = await p.runModelAction(runId, {
      model: 'test-model',
      prompt: 'Hello world',
      agentId,
    });

    expect(result.response).toBe('Response to: Hello world');
    expect(result.action.status).toBe('completed');
    expect(result.action.observed!.producedArtifactIds).toHaveLength(1);

    // Verify the artifact exists in the run
    const artifacts = await p.artifacts.forRun(runId);
    const llmArtifact = artifacts.find((a) => a.type === 'llm-response');
    expect(llmArtifact).toBeDefined();
    expect(llmArtifact!.content.text).toBe('Response to: Hello world');
    expect(llmArtifact!.content.model).toBe('test-model');
  });

  it('token usage captured in observed.metrics', async () => {
    const result = await p.runModelAction(runId, {
      model: 'test-model',
      prompt: 'Count tokens',
      agentId,
    });

    expect(result.usage).toEqual({ input: 100, output: 50 });
    expect(result.action.observed!.metrics).toBeDefined();
    expect(result.action.observed!.metrics!.tokenUsage).toEqual({ input: 100, output: 50 });
    expect(result.action.observed!.metrics!.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.action.observed!.metrics!.startedAt).toBeDefined();
    expect(result.action.observed!.metrics!.completedAt).toBeDefined();
  });

  it('replay reuses effectful model calls by default', async () => {
    await p.runModelAction(runId, {
      model: 'test-model',
      prompt: 'Original call',
      agentId,
    });

    expect(generateCallCount).toBe(1);

    const replayed = await p.replayRun(runId);

    // Adapter should NOT have been called again
    expect(generateCallCount).toBe(1);

    // Replayed run should have the same artifacts
    const originalArtifacts = await p.artifacts.forRun(runId);
    const replayedArtifacts = await p.artifacts.forRun(replayed.id);
    expect(replayedArtifacts).toHaveLength(originalArtifacts.length);
    expect(replayedArtifacts[0].id).toBe(originalArtifacts[0].id);
  });

  it('scoped context only includes declared prompt inputs', async () => {
    // Create two artifacts
    const declaredArtifact = await p.createArtifact({
      type: 'prompt-input',
      producedByActionId: agentId,
      runId,
      content: { text: 'declared context' },
      reusable: true,
      properties: {},
    });

    const undeclaredArtifact = await p.createArtifact({
      type: 'prompt-input',
      producedByActionId: agentId,
      runId,
      content: { text: 'undeclared context' },
      reusable: true,
      properties: {},
    });

    // Create model action that only declares one input
    const action = await p.createModelAction(runId, {
      model: 'test-model',
      prompt: 'Use the context',
      inputs: [{ objectId: declaredArtifact.id }],
      agentId,
    });

    const context = await p.getScopedContext(action.id);

    // Context should contain the declared artifact's content
    expect(context.text).toBe('declared context');

    // Undeclared artifact should not be in context
    // (if undeclared had overlapping keys, they'd be absent)
    expect(Object.values(context)).not.toContain('undeclared context');
  });

  it('tool calls produce tool-request artifacts', async () => {
    const toolAdapter: LLMAdapter = {
      generate: async () => ({
        output: 'I will call a tool',
        toolCalls: [
          { name: 'read_file', arguments: { path: '/src/main.ts' } },
          { name: 'search', arguments: { query: 'hello' } },
        ],
        usage: { input: 80, output: 40 },
      }),
    };

    const tp = new Parallax();
    tp.registerLLM(toolAdapter);
    const agent = await tp.createAgent({ type: 'Agent', properties: {} });
    const run = await tp.createRun(agent.id);

    const result = await tp.runModelAction(run.id, {
      model: 'test-model',
      prompt: 'Use tools',
      agentId: agent.id,
    });

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls![0]).toEqual({ name: 'read_file', arguments: { path: '/src/main.ts' } });
    expect(result.toolCalls![1]).toEqual({ name: 'search', arguments: { query: 'hello' } });

    // Verify artifacts: 1 llm-response + 2 tool-requests
    expect(result.action.observed!.producedArtifactIds).toHaveLength(3);

    const artifacts = await tp.artifacts.forRun(run.id);
    const toolRequests = artifacts.filter((a) => a.type === 'tool-request');
    expect(toolRequests).toHaveLength(2);
    expect(toolRequests[0].content.name).toBe('read_file');
    expect(toolRequests[1].content.name).toBe('search');
  });

  it('runModelAction throws if no adapter registered', async () => {
    const plain = new Parallax();
    const agent = await plain.createAgent({ type: 'Agent', properties: {} });
    const run = await plain.createRun(agent.id);

    await expect(
      plain.runModelAction(run.id, {
        model: 'test-model',
        prompt: 'This should fail',
      }),
    ).rejects.toThrow('No LLM adapter registered');
  });

  it('runModelAction is idempotent for the same completed effectful action', async () => {
    const first = await p.runModelAction(runId, {
      model: 'test-model',
      prompt: 'Repeatable prompt',
      agentId,
    });
    const second = await p.runModelAction(runId, {
      model: 'test-model',
      prompt: 'Repeatable prompt',
      agentId,
    });

    expect(generateCallCount).toBe(1);
    expect(second.action.id).toBe(first.action.id);
    expect(second.response).toBe(first.response);
    expect(second.action.observed?.producedArtifactIds).toEqual(
      first.action.observed?.producedArtifactIds,
    );
  });
});
