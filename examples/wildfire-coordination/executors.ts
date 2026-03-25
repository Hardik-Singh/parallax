import type { ActionExecutor } from '../../src/index.ts';

// ---------------------------------------------------------------------------
// DataFetch — effectful executor for external data retrieval
// ---------------------------------------------------------------------------

export function createDataFetchExecutor(): ActionExecutor {
  const handlers: Record<
    string,
    (props: Record<string, unknown>) => {
      artifactType: string;
      content: Record<string, unknown>;
      reusable: boolean;
    }
  > = {
    'ingest-alert': (props) => ({
      artifactType: 'incident-alert-bundle',
      reusable: true,
      content: {
        incidentId: props.incidentId ?? 'CALDOR-2026-001',
        incidentName: 'Caldor Fire',
        reportedAt: '2026-03-25T08:15:00Z',
        location: { lat: 38.7749, lon: -120.5244 },
        initialAcres: 150,
        containment: 0,
        structures_threatened: 420,
        source: props.source ?? 'cal-fire-dispatch',
      },
    }),

    'fetch-weather': (props) => ({
      artifactType: 'weather-snapshot',
      reusable: false,
      content: {
        station: props.station ?? 'KSMF',
        observedAt: '2026-03-25T09:00:00Z',
        temperature_f: 98,
        humidity_pct: 12,
        wind_speed_mph: 25,
        wind_direction: 'SW',
        gusts_mph: 38,
        red_flag_warning: true,
        forecast_next_12h: {
          wind_shift: false,
          temperature_trend: 'rising',
          humidity_trend: 'falling',
        },
      },
    }),

    'fetch-shelter': (props) => ({
      artifactType: 'shelter-capacity-report',
      reusable: false,
      content: {
        region: props.region ?? 'el-dorado-county',
        queriedAt: '2026-03-25T09:10:00Z',
        facilities: [
          { name: 'Placerville Fairgrounds', capacity: 1200, currentOccupancy: 180, petFriendly: true },
          { name: 'Cameron Park Community Center', capacity: 800, currentOccupancy: 45, petFriendly: false },
          { name: 'El Dorado Hills CSD', capacity: 600, currentOccupancy: 0, petFriendly: true },
          { name: 'Diamond Springs Fire Station', capacity: 200, currentOccupancy: 0, petFriendly: false },
        ],
        totalCapacity: 2800,
        totalOccupancy: 225,
        availableCapacity: 2575,
      },
    }),

    'fetch-roads': (props) => ({
      artifactType: 'road-closure-data',
      reusable: false,
      content: {
        region: props.region ?? 'el-dorado-county',
        queriedAt: '2026-03-25T09:12:00Z',
        closures: [
          { route: 'US-50 Eastbound', segment: 'Pollock Pines to Kyburz', reason: 'fire activity', since: '2026-03-25T07:00:00Z' },
          { route: 'Mosquito Rd', segment: 'Full closure', reason: 'evacuation zone', since: '2026-03-25T08:30:00Z' },
          { route: 'Ice House Rd', segment: 'North of Riverton', reason: 'fire line operations', since: '2026-03-25T08:45:00Z' },
        ],
        alternateRoutes: [
          { from: 'Pollock Pines', to: 'Placerville', via: 'Green Valley Rd', status: 'open', estimatedDelay_min: 25 },
          { from: 'Camino', to: 'Diamond Springs', via: 'Carson Rd', status: 'open', estimatedDelay_min: 15 },
        ],
        source: props.source ?? 'caltrans',
      },
    }),
  };

  return {
    canExecute: (action) => action.actionKind === 'DataFetch',
    execute: async (action, _context) => {
      const handler = handlers[action.type];
      if (!handler) {
        throw new Error(`Unknown DataFetch action type: ${action.type}`);
      }
      const result = handler(action.properties);
      return {
        outputs: { status: 'fetched', type: action.type },
        producedArtifacts: [
          {
            type: result.artifactType,
            content: result.content,
            reusable: result.reusable,
            properties: {},
          },
        ],
        metrics: {
          startedAt: '2026-03-25T09:00:00.000Z',
          completedAt: '2026-03-25T09:00:00.150Z',
          durationMs: 150,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Analysis — pure executor for computational steps
// ---------------------------------------------------------------------------

export function createAnalysisExecutor(): ActionExecutor {
  const handlers: Record<
    string,
    (context: Record<string, unknown>, props: Record<string, unknown>) => {
      artifactType: string;
      content: Record<string, unknown>;
      reusable: boolean;
    }
  > = {
    'assess-risk': (_context, props) => ({
      artifactType: 'risk-map',
      reusable: false,
      content: {
        model: props.model ?? 'farsite-simplified',
        assessedAt: '2026-03-25T09:05:00Z',
        overallRisk: 'extreme',
        zones: [
          { zone: 'Pollock Pines', riskScore: 0.95, spreadRate_acres_h: 80, spotting_probability: 0.7 },
          { zone: 'Camino', riskScore: 0.82, spreadRate_acres_h: 45, spotting_probability: 0.4 },
          { zone: 'Grizzly Flats', riskScore: 0.78, spreadRate_acres_h: 60, spotting_probability: 0.55 },
          { zone: 'Pleasant Valley', riskScore: 0.65, spreadRate_acres_h: 30, spotting_probability: 0.25 },
          { zone: 'Diamond Springs', riskScore: 0.35, spreadRate_acres_h: 10, spotting_probability: 0.1 },
        ],
        projected_24h_acres: 2400,
      },
    }),

    'identify-regions': (_context, props) => ({
      artifactType: 'threatened-region-list',
      reusable: true,
      content: {
        threshold: props.threshold ?? 0.7,
        identifiedAt: '2026-03-25T09:06:00Z',
        regions: [
          { name: 'Pollock Pines', population: 7200, riskScore: 0.95, evacuationPriority: 'immediate' },
          { name: 'Camino', population: 4100, riskScore: 0.82, evacuationPriority: 'immediate' },
          { name: 'Grizzly Flats', population: 1200, riskScore: 0.78, evacuationPriority: 'immediate' },
        ],
        totalPopulationAtRisk: 12500,
        immediateEvacuationPopulation: 12500,
      },
    }),

    'estimate-demand': (_context, props) => ({
      artifactType: 'evacuation-demand-estimate',
      reusable: false,
      content: {
        model: props.evacuationModel ?? 'gravity',
        timeHorizon: props.timeHorizon ?? '24h',
        estimatedAt: '2026-03-25T09:08:00Z',
        totalEvacuees: 12500,
        vehiclesEstimated: 4800,
        specialNeedsTransport: 340,
        petTransport: 620,
        shelterBedsNeeded: 3100,
        availableShelterBeds: 2575,
        shelterDeficit: 525,
        peakLoadHour: '2026-03-25T14:00:00Z',
      },
    }),

    'recommend-allocation': (_context, _props) => ({
      artifactType: 'allocation-plan',
      reusable: false,
      content: {
        generatedAt: '2026-03-25T09:09:00Z',
        allocations: [
          { resource: 'school-buses', count: 22, assignedTo: 'Pollock Pines', priority: 1 },
          { resource: 'school-buses', count: 12, assignedTo: 'Camino', priority: 2 },
          { resource: 'ambulances', count: 8, assignedTo: 'Pollock Pines', priority: 1 },
          { resource: 'ambulances', count: 4, assignedTo: 'Grizzly Flats', priority: 2 },
          { resource: 'traffic-control', count: 6, assignedTo: 'Green Valley Rd corridor', priority: 1 },
          { resource: 'animal-transport', count: 5, assignedTo: 'Pollock Pines', priority: 2 },
        ],
        overflowPlan: {
          additionalShelter: 'Sacramento Convention Center',
          additionalCapacity: 2000,
          transportRoute: 'US-50 Westbound to Sacramento',
        },
        estimatedClearanceTime_h: 8,
      },
    }),

    'draft-bulletin': (_context, _props) => ({
      artifactType: 'public-bulletin-draft',
      reusable: false,
      content: {
        draftedAt: '2026-03-25T09:15:00Z',
        severity: 'EXTREME',
        title: 'EVACUATION ORDER — Caldor Fire — El Dorado County',
        body: [
          'An immediate evacuation order is in effect for the following communities: Pollock Pines, Camino, and Grizzly Flats.',
          'The Caldor Fire has burned approximately 150 acres with 0% containment. Extreme fire weather conditions with winds gusting to 38 mph are driving rapid spread.',
          'Evacuation shelters are open at Placerville Fairgrounds (pet-friendly), Cameron Park Community Center, and El Dorado Hills CSD (pet-friendly).',
          'Primary evacuation route: US-50 Westbound. Alternate routes available via Green Valley Rd and Carson Rd. Expect delays of 15-25 minutes on alternate routes.',
          'If you need transportation assistance, call 211. For medical emergencies, call 911.',
        ].join('\n\n'),
        zones: ['Pollock Pines', 'Camino', 'Grizzly Flats'],
        shelters: ['Placerville Fairgrounds', 'Cameron Park Community Center', 'El Dorado Hills CSD'],
        routes: ['US-50 Westbound', 'Green Valley Rd', 'Carson Rd'],
      },
    }),
  };

  return {
    canExecute: (action) => action.actionKind === 'Analysis',
    execute: async (action, context) => {
      const handler = handlers[action.type];
      if (!handler) {
        throw new Error(`Unknown Analysis action type: ${action.type}`);
      }
      const result = handler(context, action.properties);
      return {
        outputs: { status: 'computed', type: action.type },
        producedArtifacts: [
          {
            type: result.artifactType,
            content: result.content,
            reusable: result.reusable,
            properties: {},
          },
        ],
        metrics: {
          startedAt: '2026-03-25T09:05:00.000Z',
          completedAt: '2026-03-25T09:05:00.050Z',
          durationMs: 50,
        },
      };
    },
  };
}
