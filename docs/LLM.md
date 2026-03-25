# LLM Integration

Parallax treats LLM calls as `ModelInference` actions — the same ontology, replay, and divergence semantics apply. This guide covers the adapter interface, convenience helpers, and end-to-end examples.

## Quick Start

### 1. Create an adapter

An `LLMAdapter` wraps your provider SDK:

```typescript
import { Parallax } from '@invariance/parallax';
import type { LLMAdapter } from '@invariance/parallax';

const adapter: LLMAdapter = {
  async generate({ model, system, prompt, tools, responseFormat }) {
    // Call your provider (Anthropic, OpenAI, etc.)
    const response = await yourProvider.complete({ model, system, prompt, tools });
    return {
      output: response.text,
      toolCalls: response.toolCalls,
      usage: { input: response.inputTokens, output: response.outputTokens },
      raw: response,  // optional: store the raw provider response
    };
  },
};
```

### 2. Register it

```typescript
const p = new Parallax();
p.registerLLM(adapter);
```

This internally registers a `ModelInferenceExecutor` for the `ModelInference` action kind.

### 3. Run a model action

```typescript
const agent = await p.createAgent({ type: 'coding-agent', properties: {} });
const run = await p.createRun(agent.id, { goalDescription: 'Fix login bug' });

const result = await p.runModelAction(run.id, {
  model: 'claude-sonnet-4-20250514',
  system: 'You are a senior engineer.',
  prompt: 'Fix the null pointer in auth.ts line 42',
  agentId: agent.id,
});

console.log(result.response);   // LLM output text
console.log(result.usage);      // { input: 150, output: 300 }
console.log(result.toolCalls);  // undefined or [{ name, arguments }]
```

`runModelAction` is a convenience wrapper that:
1. Plans a `ModelInference` action via `createModelAction`
2. Executes it
3. Returns the action, response text, tool calls, and usage in a flat result

If the same completed effectful model action is requested again in the same run with identical stable inputs, `runModelAction` returns the existing completed action instead of calling the adapter a second time.

## Artifact Conventions

The `ModelInferenceExecutor` automatically produces these artifacts:

| Type | Content | When |
|------|---------|------|
| `llm-response` | `{ text, model }` | Always |
| `tool-request` | `{ name, arguments }` | Per tool call returned by the adapter |

Artifacts are non-reusable (scoped to their run/action). During replay, effectful actions and their artifacts are structurally shared.

## Metrics

Token usage and timing are captured in `action.observed.metrics`:

```typescript
const { action } = result;
console.log(action.observed?.metrics?.tokenUsage);  // { input: 150, output: 300 }
console.log(action.observed?.metrics?.durationMs);   // 1234
console.log(action.observed?.metrics?.startedAt);    // ISO timestamp
console.log(action.observed?.metrics?.completedAt);  // ISO timestamp
```

Metrics propagation is not LLM-specific — any executor can return `metrics` in its result.

## Replay Behavior

`ModelInference` actions are `effectful: true` by default. During `replayRun`, effectful completed actions are structurally shared (not re-executed). The adapter is not called again.

```typescript
const result = await p.runModelAction(run.id, { model: 'claude-sonnet-4-20250514', prompt: '...' });
const replayed = await p.replayRun(run.id);
// The LLM was NOT called again. The replayed run shares the same action and artifacts.
```

To force re-execution during replay, pass `skipEffectful: false`:

```typescript
const replayed = await p.replayRun(run.id, { skipEffectful: false });
```

## Declaring Dependencies

Use `inputs` to declare what context a model action depends on. This connects the action to the dependency graph and makes divergence detection work.

```typescript
const codeArtifact = await p.createArtifact({
  type: 'prompt-input',
  producedByActionId: agent.id,
  runId: run.id,
  content: { code: 'function login() { ... }', file: 'auth.ts' },
  reusable: true,
  properties: {},
});

const result = await p.runModelAction(run.id, {
  model: 'claude-sonnet-4-20250514',
  prompt: `Review this code:\n${codeArtifact.content.code}`,
  inputs: [{ objectId: codeArtifact.id }],
  agentId: agent.id,
});
```

The prompt string is your responsibility. Parallax does not auto-inject context — it tracks *what was declared* so divergence detection can verify what was actually used.

## Deduplication

Two `createModelAction` calls with identical model, prompt, inputs, and properties hash to the same action ID. This is consistent with Parallax's content-addressing semantics. If you want distinct samples of the same prompt:

```typescript
const sample1 = await p.runModelAction(run.id, {
  model: 'claude-sonnet-4-20250514',
  prompt: 'Generate a name',
  properties: { sample: 1 },
});

const sample2 = await p.runModelAction(run.id, {
  model: 'claude-sonnet-4-20250514',
  prompt: 'Generate a name',
  properties: { sample: 2 },
});
```

## Step-by-Step Control

If you need more control, use `createModelAction` and `executeAction` separately:

```typescript
const action = await p.createModelAction(run.id, {
  model: 'claude-sonnet-4-20250514',
  prompt: 'Analyze this code',
  inputs: [{ objectId: codeArtifact.id }],
  agentId: agent.id,
});

// Inspect the planned action before executing
console.log(action.declared.inputs);

const executed = await p.executeAction(action.id);
console.log(executed.observed?.producedArtifactIds);
```

## Example: Coding Agent

A multi-step coding agent that reads code, analyzes it, and generates a fix:

```typescript
import { Parallax } from '@invariance/parallax';
import type { LLMAdapter } from '@invariance/parallax';

// 1. Set up
const adapter: LLMAdapter = { generate: async (input) => { /* your provider */ } };
const p = new Parallax();
p.registerLLM(adapter);

const agent = await p.createAgent({ type: 'coding-agent', properties: {} });
const run = await p.createRun(agent.id, { goalDescription: 'Fix auth bug' });

// 2. Create a code artifact as input
const code = await p.createArtifact({
  type: 'prompt-input',
  producedByActionId: agent.id,
  runId: run.id,
  content: { code: 'function login(user) { return db.find(user.id); }', file: 'auth.ts' },
  reusable: true,
  properties: {},
});

// 3. Step 1 — analyze the code
const analysis = await p.runModelAction(run.id, {
  model: 'claude-sonnet-4-20250514',
  system: 'You are a code reviewer. Identify bugs.',
  prompt: `Review this code for bugs:\n\n${code.content.code}`,
  inputs: [{ objectId: code.id }],
  agentId: agent.id,
});

// 4. Step 2 — generate a fix (depends on analysis)
const analysisArtifactId = analysis.action.observed!.producedArtifactIds[0];
const fix = await p.runModelAction(run.id, {
  model: 'claude-sonnet-4-20250514',
  system: 'You are a senior engineer. Generate a minimal fix.',
  prompt: `Based on this analysis:\n${analysis.response}\n\nGenerate a fix.`,
  inputs: [
    { objectId: code.id },
    { objectId: analysisArtifactId },
  ],
  agentId: agent.id,
});

console.log(fix.response);

// 5. Replay the entire run later — no LLM calls made
const replayed = await p.replayRun(run.id);

// 6. Check for divergence
const divergence = await p.getDivergence(run.id);
console.log(divergence.summary);
```

## Example: Summarization

A simple one-shot summarization:

```typescript
const p = new Parallax();
p.registerLLM(adapter);

const agent = await p.createAgent({ type: 'summarizer', properties: {} });
const run = await p.createRun(agent.id);

const doc = await p.createArtifact({
  type: 'prompt-input',
  producedByActionId: agent.id,
  runId: run.id,
  content: { text: 'A very long document...' },
  reusable: true,
  properties: {},
});

const result = await p.runModelAction(run.id, {
  model: 'claude-haiku-4-5-20251001',
  prompt: `Summarize this document:\n\n${doc.content.text}`,
  inputs: [{ objectId: doc.id }],
  agentId: agent.id,
});

console.log(result.response);
console.log(result.usage);  // { input: 2000, output: 200 }
```
