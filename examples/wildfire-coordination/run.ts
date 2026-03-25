import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Parallax } from '../../src/parallax.js';
import type { ActionObject } from '../../src/types.js';
import { createDataFetchExecutor, createAnalysisExecutor } from './executors.js';
import { exportScenario } from './export.js';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outPath = outIndex !== -1 ? args[outIndex + 1] : undefined;

// ---------------------------------------------------------------------------
// Main scenario
// ---------------------------------------------------------------------------

async function main() {
  const p = new Parallax();

  // Register executors
  p.registerExecutor('DataFetch', createDataFetchExecutor());
  p.registerExecutor('Analysis', createAnalysisExecutor());

  // =========================================================================
  // Setup: Agent
  // =========================================================================

  const agent = await p.createAgent({
    type: 'wildfire-coordinator',
    properties: { name: 'WildfireCoordinator', version: '1.0' },
    capabilities: ['data-ingestion', 'risk-assessment', 'resource-planning'],
  });

  // =========================================================================
  // Run 1: Original wildfire response
  // =========================================================================

  const run1 = await p.createRun(agent.id, {
    goalDescription: 'Coordinate wildfire response for Caldor Fire incident',
    tags: ['wildfire', 'caldor-fire', 'original'],
  });

  console.log('--- Run 1: Original wildfire response ---');

  // Step 1: Ingest incident alert (effectful)
  const ingestAlert = await p.planAction(run1.id, {
    type: 'ingest-alert',
    actionKind: 'DataFetch',
    runId: run1.id,
    effectful: true,
    declared: { inputs: [], intendedEffect: 'Fetch initial incident report from dispatch' },
    agentId: agent.id,
    properties: { source: 'cal-fire-dispatch', incidentId: 'CALDOR-2026-001' },
  });
  const executedIngest = await p.executeAction(ingestAlert.id);
  const alertArtifactId = executedIngest.observed!.producedArtifactIds[0];
  console.log(`  [1] ingest-alert -> ${alertArtifactId.slice(0, 12)}...`);

  // Step 2: Fetch weather data (effectful)
  const fetchWeather = await p.planAction(run1.id, {
    type: 'fetch-weather',
    actionKind: 'DataFetch',
    runId: run1.id,
    effectful: true,
    declared: { inputs: [], intendedEffect: 'Retrieve current weather and wind forecast' },
    agentId: agent.id,
    properties: { station: 'KSMF', radius_km: 50 },
  });
  const executedWeather = await p.executeAction(fetchWeather.id);
  const weatherArtifactId = executedWeather.observed!.producedArtifactIds[0];
  console.log(`  [2] fetch-weather -> ${weatherArtifactId.slice(0, 12)}...`);

  // Step 3: Assess spread risk (pure, recompute on replay)
  const assessRisk = await p.planAction(run1.id, {
    type: 'assess-risk',
    actionKind: 'Analysis',
    runId: run1.id,
    effectful: false,
    cachePolicy: 'recompute',
    declared: {
      inputs: [
        { objectId: alertArtifactId, alias: 'alert' },
        { objectId: weatherArtifactId, alias: 'weather' },
      ],
    },
    agentId: agent.id,
    properties: { model: 'farsite-simplified', resolution: '500m' },
  });
  const executedRisk = await p.executeAction(assessRisk.id);
  const riskMapId = executedRisk.observed!.producedArtifactIds[0];
  console.log(`  [3] assess-risk -> ${riskMapId.slice(0, 12)}...`);

  // Step 4: Identify threatened regions (pure, recompute)
  const identifyRegions = await p.planAction(run1.id, {
    type: 'identify-regions',
    actionKind: 'Analysis',
    runId: run1.id,
    effectful: false,
    cachePolicy: 'recompute',
    declared: {
      inputs: [{ objectId: riskMapId, alias: 'riskMap' }],
    },
    agentId: agent.id,
    properties: { threshold: 0.7, minPopulation: 500 },
  });
  const executedRegions = await p.executeAction(identifyRegions.id);
  const regionListId = executedRegions.observed!.producedArtifactIds[0];
  console.log(`  [4] identify-regions -> ${regionListId.slice(0, 12)}...`);

  // Step 5: Fetch shelter capacity (effectful)
  const fetchShelter = await p.planAction(run1.id, {
    type: 'fetch-shelter',
    actionKind: 'DataFetch',
    runId: run1.id,
    effectful: true,
    declared: { inputs: [], intendedEffect: 'Query shelter database for capacity' },
    agentId: agent.id,
    properties: { region: 'el-dorado-county', includeOverflow: true },
  });
  const executedShelter = await p.executeAction(fetchShelter.id);
  const shelterReportId = executedShelter.observed!.producedArtifactIds[0];
  console.log(`  [5] fetch-shelter -> ${shelterReportId.slice(0, 12)}...`);

  // Step 6: Fetch road closure data (effectful)
  const fetchRoads = await p.planAction(run1.id, {
    type: 'fetch-roads',
    actionKind: 'DataFetch',
    runId: run1.id,
    effectful: true,
    declared: { inputs: [], intendedEffect: 'Retrieve current road closure status' },
    agentId: agent.id,
    properties: { region: 'el-dorado-county', source: 'caltrans' },
  });
  const executedRoads = await p.executeAction(fetchRoads.id);
  const roadClosureId = executedRoads.observed!.producedArtifactIds[0];
  console.log(`  [6] fetch-roads -> ${roadClosureId.slice(0, 12)}...`);

  // Step 7: Estimate evacuation demand (pure, recompute)
  const estimateDemand = await p.planAction(run1.id, {
    type: 'estimate-demand',
    actionKind: 'Analysis',
    runId: run1.id,
    effectful: false,
    cachePolicy: 'recompute',
    declared: {
      inputs: [
        { objectId: regionListId, alias: 'regions' },
        { objectId: shelterReportId, alias: 'shelters' },
      ],
    },
    agentId: agent.id,
    properties: { evacuationModel: 'gravity', timeHorizon: '24h' },
  });
  const executedDemand = await p.executeAction(estimateDemand.id);
  const demandEstimateId = executedDemand.observed!.producedArtifactIds[0];
  console.log(`  [7] estimate-demand -> ${demandEstimateId.slice(0, 12)}...`);

  // Step 8: Recommend resource allocation (pure, recompute)
  const recommendAlloc = await p.planAction(run1.id, {
    type: 'recommend-allocation',
    actionKind: 'Analysis',
    runId: run1.id,
    effectful: false,
    cachePolicy: 'recompute',
    declared: {
      inputs: [
        { objectId: demandEstimateId, alias: 'demand' },
        { objectId: roadClosureId, alias: 'roads' },
      ],
    },
    agentId: agent.id,
    properties: { optimizationTarget: 'minimize-evacuation-time' },
  });
  const executedAlloc = await p.executeAction(recommendAlloc.id);
  const allocPlanId = executedAlloc.observed!.producedArtifactIds[0];
  console.log(`  [8] recommend-allocation -> ${allocPlanId.slice(0, 12)}...`);

  // Step 9: Draft public bulletin (pure, recompute) — divergence target
  const draftBulletin = await p.planAction(run1.id, {
    type: 'draft-bulletin',
    actionKind: 'Analysis',
    runId: run1.id,
    effectful: false,
    cachePolicy: 'recompute',
    declared: {
      inputs: [
        { objectId: allocPlanId, alias: 'plan' },
        { objectId: regionListId, alias: 'regions' },
        // NOTE: road-closure-data is intentionally NOT declared
      ],
    },
    agentId: agent.id,
    properties: { format: 'public-advisory', language: 'en' },
  });
  const executedBulletin = await p.executeAction(draftBulletin.id);
  const bulletinId = executedBulletin.observed!.producedArtifactIds[0];
  console.log(`  [9] draft-bulletin -> ${bulletinId.slice(0, 12)}...`);

  // =========================================================================
  // Inject divergence: bulletin consumed road-closure-data without declaring it
  // =========================================================================

  const bulletinAction = (await p.findByHash(draftBulletin.id)) as ActionObject;
  bulletinAction.observed!.consumedInputIds.push(roadClosureId);
  await (p as any).store.putObject(bulletinAction);
  console.log('\n  Injected undeclared_input_consumed divergence on bulletin action');

  // =========================================================================
  // Divergence analysis for Run 1
  // =========================================================================

  const div1 = await p.getDivergence(run1.id);
  console.log(`\n  Run 1 divergence: ${div1.summary}`);
  for (const e of div1.events) {
    console.log(`    - ${e.type}: ${e.description.slice(0, 80)}`);
  }

  // =========================================================================
  // Run 2: Replay after updated conditions
  // =========================================================================

  console.log('\n--- Run 2: Replay ---');
  const run2 = await p.replayRun(run1.id);
  console.log(`  Replay run created: ${run2.id.slice(0, 12)}...`);
  console.log(`  Status: ${run2.status}`);
  console.log(`  Actions: ${run2.actionIds.length} (${run2.actionIds.filter((id) => run1.actionIds.includes(id)).length} shared)`);
  console.log(`  Artifacts: ${run2.artifactIds.length}`);

  // Inject divergence into replay bulletin action
  const run2Actions = await p.actions.forRun(run2.id);
  const run2Bulletin = run2Actions.find(
    (a) => a.type === 'draft-bulletin' && a.id !== draftBulletin.id,
  );
  if (run2Bulletin?.observed) {
    run2Bulletin.observed.consumedInputIds.push(roadClosureId);
    await (p as any).store.putObject(run2Bulletin);
    console.log('  Injected undeclared_input_consumed divergence on replay bulletin action');
  }

  // =========================================================================
  // Divergence analysis for Run 2 and cross-run diff
  // =========================================================================

  const div2 = await p.getDivergence(run2.id);
  console.log(`\n  Run 2 divergence: ${div2.summary}`);
  for (const e of div2.events) {
    console.log(`    - ${e.type}: ${e.description.slice(0, 80)}`);
  }

  const crossDiv = await p.diffRuns(run1.id, run2.id);
  console.log(`\n  Cross-run diff: ${crossDiv.summary}`);

  // =========================================================================
  // Query highlights
  // =========================================================================

  console.log('\n--- Query Highlights ---');

  const sharedArtifacts = await p.artifacts.sharedAcrossRuns();
  console.log(`  Shared artifacts across runs: ${sharedArtifacts.length}`);
  for (const a of sharedArtifacts) {
    console.log(`    - ${a.type} (${a.id.slice(0, 12)}...)`);
  }

  const replayChain = await p.runs.replayChain(run2.id);
  console.log(`  Replay chain length: ${replayChain.length}`);

  const replayRels = await p.getRelations('REPLAY_OF');
  console.log(`  REPLAY_OF relations: ${replayRels.length}`);

  // =========================================================================
  // Export
  // =========================================================================

  const updatedRun1 = await p.getRun(run1.id);
  const updatedRun2 = await p.getRun(run2.id);

  const exported = await exportScenario(
    p,
    [updatedRun1, updatedRun2],
    [div1, div2, crossDiv],
    bulletinId,
  );

  // =========================================================================
  // Summary
  // =========================================================================

  console.log('\n--- Export Summary ---');
  console.log(`  Runs: ${exported.summary.totalRuns}`);
  console.log(`  Actions: ${exported.summary.totalActions}`);
  console.log(`  Artifacts: ${exported.summary.totalArtifacts}`);
  console.log(`  Relations: ${exported.summary.totalRelations}`);
  console.log(`  Shared artifacts: ${exported.summary.sharedArtifactCount}`);
  console.log(`  Divergence events: ${exported.summary.divergenceEventCount}`);
  console.log(`  Replay chain: ${exported.summary.replayChainLength}`);
  console.log('\n  Object counts:');
  for (const [kind, count] of Object.entries(exported.summary.objectCounts)) {
    console.log(`    ${kind}: ${count}`);
  }
  console.log('\n  Relation counts:');
  for (const [type, count] of Object.entries(exported.summary.relationCounts)) {
    console.log(`    ${type}: ${count}`);
  }

  // =========================================================================
  // Write output
  // =========================================================================

  const json = JSON.stringify(exported, null, 2);

  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, json, 'utf-8');
    console.log(`\n  Wrote export to ${outPath}`);
  } else {
    console.log('\n  (pass --out <path> to write export JSON to a file)');
  }
}

main().catch((err) => {
  console.error('Scenario failed:', err);
  process.exit(1);
});
