import { Parallax } from '../../src/index.ts';
import type { ActionExecutor } from '../../src/index.ts';

// ---------------------------------------------------------------------------
// Simple executor that tracks execution count
// ---------------------------------------------------------------------------

let executionCount = 0;

const executor: ActionExecutor = {
  canExecute: () => true,
  execute: async (action, context) => {
    executionCount++;
    const type = action.type;
    console.log(`  [exec] ${type} (execution #${executionCount})`);
    return {
      outputs: { type, result: `${type}-result`, context },
      producedArtifacts: [
        {
          type: `${type}-output`,
          content: { type, result: `${type}-result`, ts: Date.now() },
          reusable: false,
          properties: {},
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// Main scenario
// ---------------------------------------------------------------------------

async function main() {
  const p = new Parallax();
  p.registerExecutor('ToolCall', executor);
  p.registerExecutor('Decision', executor);

  const agent = await p.createAgent({ type: 'Agent', properties: {} });
  const run = await p.createRun(agent.id, {
    goalDescription: 'Demonstrate selective replay from checkpoint',
    tags: ['example', 'selective-replay'],
  });

  console.log('=== Step 1: Build initial run with 4 actions ===\n');

  // Action 1: Fetch data (effectful — won't be re-executed on replay)
  const fetchData = await p.planAction(run.id, {
    type: 'fetch-data',
    actionKind: 'ToolCall',
    runId: run.id,
    effectful: true,
    declared: { inputs: [], intendedEffect: 'Fetch external data' },
    agentId: agent.id,
    properties: { source: 'sensor-api' },
  });
  await p.executeAction(fetchData.id);

  // Action 2: Analyze (pure, recompute)
  const analyze = await p.planAction(run.id, {
    type: 'analyze',
    actionKind: 'Decision',
    runId: run.id,
    effectful: false,
    declared: { inputs: [] },
    agentId: agent.id,
    properties: { algorithm: 'risk-model-v2' },
    cachePolicy: 'recompute',
  });
  await p.executeAction(analyze.id);

  // Action 3: Plan response (pure, recompute)
  const plan = await p.planAction(run.id, {
    type: 'plan-response',
    actionKind: 'Decision',
    runId: run.id,
    effectful: false,
    declared: { inputs: [] },
    agentId: agent.id,
    properties: {},
    cachePolicy: 'recompute',
  });
  await p.executeAction(plan.id);

  // Action 4: Dispatch (effectful)
  const dispatch = await p.planAction(run.id, {
    type: 'dispatch',
    actionKind: 'ToolCall',
    runId: run.id,
    effectful: true,
    declared: { inputs: [] },
    agentId: agent.id,
    properties: { target: 'field-teams' },
  });
  await p.executeAction(dispatch.id);

  console.log(`\nOriginal run executed ${executionCount} actions.\n`);

  // =========================================================================
  // Checkpoint after fetch-data
  // =========================================================================

  console.log('=== Step 2: Create checkpoint after fetch-data ===\n');

  const cp = await p.createCheckpoint(run.id, {
    name: 'data-ready',
    actionId: fetchData.id,
    summary: 'Data ingestion complete, downstream analysis can be replayed',
  });
  console.log(`  Checkpoint "${(cp.content as Record<string, unknown>).name}" created at action ${fetchData.id.slice(0, 12)}...`);

  // =========================================================================
  // Query helpers
  // =========================================================================

  console.log('\n=== Step 3: Query helpers ===\n');

  const latest = await p.actions.latestForRun(run.id);
  console.log(`  Latest action: ${latest?.type}`);

  const latestFetch = await p.actions.latestForRun(run.id, 'fetch-data');
  console.log(`  Latest fetch-data: ${latestFetch?.type}`);

  const decisions = await p.actions.byType(run.id, 'analyze');
  console.log(`  Analyze actions: ${decisions.length}`);

  const checkpoints = await p.listCheckpoints(run.id);
  console.log(`  Checkpoints: ${checkpoints.length}`);

  // =========================================================================
  // Selective replay from checkpoint
  // =========================================================================

  console.log('\n=== Step 4: Replay from checkpoint (only downstream re-executes) ===\n');

  const beforeReplay = executionCount;
  const replayed = await p.replayFromCheckpoint(run.id, 'data-ready');

  const replayedActions = replayed.actionIds.length;
  const newExecutions = executionCount - beforeReplay;

  console.log(`\n  Replayed run has ${replayedActions} actions.`);
  console.log(`  New executions: ${newExecutions} (analyze + plan-response re-executed, fetch-data + dispatch shared)`);
  console.log(`  Status: ${replayed.status}`);
  console.log(`  parentRunId: ${replayed.parentRunId?.slice(0, 12)}...`);
  console.log(`  replayOfRunId: ${replayed.replayOfRunId?.slice(0, 12)}...`);

  // =========================================================================
  // Compare runs
  // =========================================================================

  console.log('\n=== Step 5: Compare original and replayed run ===\n');

  const diff = await p.diffRuns(run.id, replayed.id);
  if (diff.events.length === 0) {
    console.log('  No divergence detected between runs.');
  } else {
    for (const e of diff.events) {
      console.log(`  ${e.type}: ${e.description.slice(0, 80)}`);
    }
  }

  console.log('\nDone.');
}

main().catch(console.error);
