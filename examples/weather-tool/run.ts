import { Parallax } from '../../src/index.ts';
import type { ParallaxTool } from '../../src/index.ts';

// ---------------------------------------------------------------------------
// Define tools
// ---------------------------------------------------------------------------

const fetchWeather: ParallaxTool = {
  name: 'fetch_weather',
  description: 'Fetch current weather snapshot for a location',
  effectful: true,
  async execute(input) {
    const location = (input.location as string) ?? 'Unknown';
    console.log(`  [fetch_weather] Fetching weather for ${location}...`);
    return {
      location,
      tempC: 34,
      humidity: 0.12,
      windKph: 50,
      conditions: 'hot and dry',
    };
  },
};

const analyzeConditions: ParallaxTool = {
  name: 'analyze_conditions',
  description: 'Analyze weather conditions and assess risk level',
  effectful: false,
  async execute(input) {
    const tempC = input.tempC as number;
    const humidity = input.humidity as number;
    const windKph = input.windKph as number;
    const risk = tempC > 30 && humidity < 0.2 && windKph > 40 ? 'high' : 'low';
    console.log(`  [analyze_conditions] Risk: ${risk}`);
    return {
      risk,
      factors: [
        tempC > 30 ? 'high temperature' : null,
        humidity < 0.2 ? 'low humidity' : null,
        windKph > 40 ? 'high wind' : null,
      ].filter(Boolean),
      recommendation: risk === 'high'
        ? 'Issue fire weather warning'
        : 'Continue monitoring',
    };
  },
};

// ---------------------------------------------------------------------------
// Main scenario
// ---------------------------------------------------------------------------

async function main() {
  const p = new Parallax();
  p.registerTool(fetchWeather);
  p.registerTool(analyzeConditions);

  const agent = await p.createAgent({ type: 'weather-agent', properties: {} });
  const run = await p.createRun(agent.id, {
    goalDescription: 'Assess fire weather risk for Riverside County',
  });

  // =========================================================================
  // Step 1: Fetch weather (effectful)
  // =========================================================================

  console.log('\n--- Step 1: Fetch weather ---');
  const weather = await p.runToolAction(run.id, {
    type: 'fetch-weather',
    toolName: 'fetch_weather',
    toolInput: { location: 'Riverside County, CA' },
    declared: {
      inputs: [],
      intendedEffect: 'Fetch current weather conditions',
    },
    agentId: agent.id,
  });

  console.log('  Output:', weather.output);
  console.log('  Artifacts:', weather.action.observed!.producedArtifactIds.length);
  console.log('  Duration:', weather.action.observed!.metrics!.durationMs, 'ms');

  // =========================================================================
  // Step 2: Analyze conditions (pure, depends on weather)
  // =========================================================================

  console.log('\n--- Step 2: Analyze conditions ---');
  const weatherResultId = weather.action.observed!.producedArtifactIds[1]; // tool-result

  const analysis = await p.runToolAction(run.id, {
    type: 'analyze-risk',
    toolName: 'analyze_conditions',
    declared: {
      inputs: [{ objectId: weatherResultId }],
      intendedEffect: 'Assess fire weather risk',
    },
    agentId: agent.id,
  });

  console.log('  Output:', analysis.output);

  // =========================================================================
  // Inspect the run
  // =========================================================================

  console.log('\n--- Run summary ---');
  const finalRun = await p.getRun(run.id);
  console.log('  Actions:', finalRun.actionIds.length);
  console.log('  Artifacts:', finalRun.artifactIds.length);

  const depGraph = await p.getDependencyGraph(run.id);
  console.log('  Dependency graph edges:', depGraph.relations.length);

  const execGraph = await p.getExecutionGraph(run.id);
  console.log('  Execution graph edges:', execGraph.relations.length);

  // =========================================================================
  // Replay — effectful tool NOT called again
  // =========================================================================

  console.log('\n--- Replay ---');
  const replayed = await p.replayRun(run.id);
  console.log('  Replayed run:', replayed.id);
  console.log('  Status:', replayed.status);

  const replayedArtifacts = await p.artifacts.forRun(replayed.id);
  const originalArtifacts = await p.artifacts.forRun(run.id);
  console.log('  Artifacts shared:', replayedArtifacts.length === originalArtifacts.length);

  // =========================================================================
  // Divergence check
  // =========================================================================

  console.log('\n--- Divergence ---');
  const divergence = await p.getDivergence(run.id);
  console.log('  Events:', divergence.events.length);
  console.log('  Summary:', divergence.summary);

  console.log('\nDone.');
}

main().catch(console.error);
