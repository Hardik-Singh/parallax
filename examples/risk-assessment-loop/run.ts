import { Parallax, runAgentLoop } from '../../src/index.ts';
import type { AgentLoopDriver, ParallaxTool } from '../../src/index.ts';

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
      tempC: 36,
      humidity: 0.10,
      windKph: 55,
      conditions: 'hot, dry, windy',
    };
  },
};

const fetchSatellite: ParallaxTool = {
  name: 'fetch_satellite',
  description: 'Fetch satellite imagery data',
  effectful: true,
  async execute(input) {
    const location = (input.location as string) ?? 'Unknown';
    console.log(`  [fetch_satellite] Fetching satellite data for ${location}...`);
    return {
      location,
      hotspots: 3,
      smokeDetected: true,
      coveragePercent: 92,
    };
  },
};

// ---------------------------------------------------------------------------
// Mock LLM adapter
// ---------------------------------------------------------------------------

const mockLLM = {
  async generate(input: { model: string; prompt: string }) {
    console.log(`  [LLM] Generating response...`);
    return {
      output: 'Risk assessment: HIGH. Multiple hotspots detected with extreme fire weather conditions. Recommend immediate resource deployment and public advisory.',
      usage: { input: 200, output: 80 },
    };
  },
};

// ---------------------------------------------------------------------------
// Main scenario
// ---------------------------------------------------------------------------

async function main() {
  const p = new Parallax();
  p.registerLLM(mockLLM);
  p.registerTool(fetchWeather);
  p.registerTool(fetchSatellite);

  const agent = await p.createAgent({ type: 'risk-assessment-agent', properties: {} });
  const run = await p.createRun(agent.id, {
    goalDescription: 'Assess fire risk for Riverside County',
  });

  // ---------------------------------------------------------------------------
  // Define the loop driver
  // ---------------------------------------------------------------------------

  const driver: AgentLoopDriver = async ({ artifacts, iteration }) => {
    console.log(`\n--- Iteration ${iteration} ---`);

    // Step 0: Fetch weather
    if (iteration === 0) {
      return {
        type: 'tool',
        reason: 'gather current weather conditions',
        tool: {
          type: 'fetch-weather',
          toolName: 'fetch_weather',
          toolInput: { location: 'Riverside County, CA' },
          declared: { inputs: [], intendedEffect: 'Fetch weather snapshot' },
          agentId: agent.id,
        },
      };
    }

    // Step 1: Check weather result — if conditions are bad, fetch satellite data
    if (iteration === 1) {
      const weatherResult = artifacts.find(a => a.type === 'tool-result');
      const tempC = weatherResult?.content?.output?.tempC as number;
      if (tempC > 30) {
        return {
          type: 'tool',
          reason: 'high temperature detected — gather satellite data',
          tool: {
            type: 'fetch-satellite',
            toolName: 'fetch_satellite',
            toolInput: { location: 'Riverside County, CA' },
            declared: { inputs: [], intendedEffect: 'Fetch satellite imagery' },
            agentId: agent.id,
          },
        };
      }
      return { type: 'stop', reason: 'temperature is normal — no further analysis needed' };
    }

    // Step 2: Synthesize all data with LLM
    if (iteration === 2) {
      return {
        type: 'model',
        reason: 'synthesize weather and satellite data into risk assessment',
        model: {
          model: 'claude-sonnet-4-20250514',
          prompt: 'Based on the gathered weather and satellite data, provide a fire risk assessment.',
          agentId: agent.id,
        },
      };
    }

    // Done
    return { type: 'stop', reason: 'risk assessment complete' };
  };

  // ---------------------------------------------------------------------------
  // Run the loop
  // ---------------------------------------------------------------------------

  console.log('Starting risk assessment loop...');
  const result = await runAgentLoop(p, run.id, {
    driver,
    maxIterations: 10,
  });

  // ---------------------------------------------------------------------------
  // Inspect results
  // ---------------------------------------------------------------------------

  console.log('\n--- Results ---');
  console.log(`Iterations: ${result.iterations}`);
  console.log(`Stopped by: ${result.stoppedBy}`);
  console.log(`Steps: ${result.steps.map(s => s.type).join(' -> ')}`);

  const finalRun = result.run;
  console.log(`Actions: ${finalRun.actionIds.length}`);
  console.log(`Artifacts: ${finalRun.artifactIds.length}`);

  // Check loop metadata on actions
  const actions = await p.actions.forRun(run.id);
  for (const action of actions) {
    if (action.properties.loopIteration !== undefined) {
      console.log(
        `  Action ${action.type}: iteration=${action.properties.loopIteration}, reason="${action.properties.loopReason}"`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Replay — tools are NOT called again
  // ---------------------------------------------------------------------------

  console.log('\n--- Replay ---');
  const replayed = await p.replayRun(run.id);
  console.log(`Replayed run: ${replayed.id}`);
  console.log(`Status: ${replayed.status}`);

  console.log('\nDone.');
}

main().catch(console.error);
