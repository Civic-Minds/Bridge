import { getDistance, inferDirection, analyzeRoute, generateRecommendations, generateCrossRouteRecommendations } from '../analysis';
import { Vehicle, VehicleHistory, PredictionIndex, VehicleWithAnalysis, RouteState, CorridorPair, DispatchPolicy, DEFAULT_POLICY } from '../types';

function makeVehicle(overrides: Partial<Vehicle>): Vehicle {
  return {
    id: 'v1',
    routeTag: '510',
    lat: 43.6482,
    lon: -79.3962,
    speed: 10,
    heading: 160, // southbound
    dirTag: '0',
    isStalled: false,
    stopSequence: 1,
    stopId: 'stop_1',
    currentStatus: 0,
    reportedAt: Date.now() / 1000,
    tripId: 'trip_1',
    ...overrides,
  };
}

const emptyHistory: VehicleHistory = new Map();

// ---------------------------------------------------------------------------
// getDistance
// ---------------------------------------------------------------------------

describe('getDistance', () => {
  it('returns ~0 for identical coordinates', () => {
    expect(getDistance(43.6482, -79.3962, 43.6482, -79.3962)).toBeCloseTo(0, 1);
  });

  it('returns approximately correct distance for two known coords', () => {
    // Spadina & Queen to King & Spadina — roughly 280m apart
    const d = getDistance(43.6482, -79.3962, 43.6457, -79.3952);
    expect(d).toBeGreaterThan(200);
    expect(d).toBeLessThan(400);
  });

  it('returns approximately 111 km per degree of latitude', () => {
    const d = getDistance(0, 0, 1, 0);
    expect(d).toBeGreaterThan(110000);
    expect(d).toBeLessThan(112000);
  });
});

// ---------------------------------------------------------------------------
// inferDirection
// ---------------------------------------------------------------------------

describe('inferDirection', () => {
  it('assigns bearings < 180 to direction 0', () => {
    expect(inferDirection(0)).toBe('0');
    expect(inferDirection(90)).toBe('0');   // eastbound
    expect(inferDirection(164)).toBe('0');  // southbound on 510
    expect(inferDirection(179)).toBe('0');
  });

  it('assigns bearings >= 180 to direction 1', () => {
    expect(inferDirection(180)).toBe('1');
    expect(inferDirection(270)).toBe('1');  // westbound on 504/501
    expect(inferDirection(343)).toBe('1');  // northbound on 510
    expect(inferDirection(359)).toBe('1');
  });

  it('handles bearings > 360 and negative values gracefully', () => {
    expect(inferDirection(360)).toBe('0');
    expect(inferDirection(720)).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// analyzeRoute — bunching
// ---------------------------------------------------------------------------

describe('analyzeRoute — bunchingPairs', () => {
  it('returns 0 for an empty vehicle list', () => {
    const { metrics } = analyzeRoute([], emptyHistory);
    expect(metrics.bunchingPairs).toBe(0);
  });

  it('flags a pair at gap ≤ 1 stop as bunching', () => {
    const vehicles = [
      makeVehicle({ id: 'v1', heading: 160, stopSequence: 5 }),
      makeVehicle({ id: 'v2', heading: 164, stopSequence: 6 }), // gap = 1
    ];
    const { metrics } = analyzeRoute(vehicles, emptyHistory);
    expect(metrics.bunchingPairs).toBe(1);
  });

  it('does not flag a pair with gap > 1 stop', () => {
    const vehicles = [
      makeVehicle({ id: 'v1', heading: 160, stopSequence: 3 }),
      makeVehicle({ id: 'v2', heading: 164, stopSequence: 7 }), // gap = 4
    ];
    const { metrics } = analyzeRoute(vehicles, emptyHistory);
    expect(metrics.bunchingPairs).toBe(0);
  });

  it('does not flag vehicles in different inferred directions', () => {
    const vehicles = [
      makeVehicle({ id: 'v1', heading: 160, stopSequence: 5 }),  // dir '0'
      makeVehicle({ id: 'v2', heading: 343, stopSequence: 6 }),  // dir '1'
    ];
    const { metrics } = analyzeRoute(vehicles, emptyHistory);
    expect(metrics.bunchingPairs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// analyzeRoute — closing
// ---------------------------------------------------------------------------

describe('analyzeRoute — closingPairs', () => {
  it('flags a pair whose gap shrank since the last poll', () => {
    const vehicles = [
      makeVehicle({ id: 'v1', heading: 160, stopSequence: 4 }),
      makeVehicle({ id: 'v2', heading: 164, stopSequence: 7 }), // gap = 3
    ];
    const history: VehicleHistory = new Map([
      ['v1', { stopSequence: 2, stopId: 'stop_1', status: 0, dwellSince: null, gapAhead: 5, inferredDir: '0' }],
    ]);
    const { metrics } = analyzeRoute(vehicles, history);
    expect(metrics.closingPairs).toBe(1);
  });

  it('does not flag a pair whose gap stayed the same', () => {
    const vehicles = [
      makeVehicle({ id: 'v1', heading: 160, stopSequence: 4 }),
      makeVehicle({ id: 'v2', heading: 164, stopSequence: 7 }), // gap = 3
    ];
    const history: VehicleHistory = new Map([
      ['v1', { stopSequence: 1, stopId: 'stop_1', status: 0, dwellSince: null, gapAhead: 3, inferredDir: '0' }],
    ]);
    const { metrics } = analyzeRoute(vehicles, history);
    expect(metrics.closingPairs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// analyzeRoute — dwell anomalies
// ---------------------------------------------------------------------------

describe('analyzeRoute — dwellAnomalies', () => {
  it('flags a vehicle stopped ≥ 30s at the same stop', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // Vehicle's reportedAt is current time; dwellSince was 45s ago → 45s elapsed → flagged
    const v = makeVehicle({ id: 'v1', heading: 160, stopId: 'stop_X', currentStatus: 2, reportedAt: nowSec });
    const history: VehicleHistory = new Map([
      ['v1', { stopSequence: 1, stopId: 'stop_X', status: 2, dwellSince: nowSec - 45, gapAhead: null, inferredDir: '0' }],
    ]);
    const { metrics } = analyzeRoute([v], history);
    expect(metrics.dwellAnomalies).toBe(1);
  });

  it('does not flag a vehicle that just stopped (< 30s)', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // No history → dwellSince set to v.reportedAt → 0s elapsed
    const v = makeVehicle({ id: 'v1', heading: 160, stopId: 'stop_X', currentStatus: 2, reportedAt: nowSec });
    const { metrics } = analyzeRoute([v], emptyHistory);
    expect(metrics.dwellAnomalies).toBe(0);
  });

  it('resets dwell timer when a vehicle moves to a new stop', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // Vehicle is at stop_Y but history has stop_X → new stop, dwellSince resets → 0s
    const v = makeVehicle({ id: 'v1', heading: 160, stopId: 'stop_Y', currentStatus: 2, reportedAt: nowSec });
    const history: VehicleHistory = new Map([
      ['v1', { stopSequence: 1, stopId: 'stop_X', status: 2, dwellSince: nowSec - 120, gapAhead: null, inferredDir: '0' }],
    ]);
    const { metrics } = analyzeRoute([v], history);
    expect(metrics.dwellAnomalies).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// analyzeRoute — vehicle-level analysis
// ---------------------------------------------------------------------------

describe('analyzeRoute — per-vehicle analysis', () => {
  it('attaches gapAhead to each vehicle', () => {
    const vehicles = [
      makeVehicle({ id: 'v1', heading: 160, stopSequence: 3 }),
      makeVehicle({ id: 'v2', heading: 164, stopSequence: 8 }), // gap = 5
    ];
    const { vehicles: enriched } = analyzeRoute(vehicles, emptyHistory);
    const v1 = enriched.find(v => v.id === 'v1')!;
    const v2 = enriched.find(v => v.id === 'v2')!;
    expect(v1.analysis.gapAhead).toBe(5);
    expect(v2.analysis.gapAhead).toBeNull();
  });

  it('marks a bunched vehicle with the bunching anomaly', () => {
    const vehicles = [
      makeVehicle({ id: 'v1', heading: 160, stopSequence: 5 }),
      makeVehicle({ id: 'v2', heading: 164, stopSequence: 6 }),
    ];
    const { vehicles: enriched } = analyzeRoute(vehicles, emptyHistory);
    expect(enriched.find(v => v.id === 'v1')!.analysis.anomalies).toContain('bunching');
  });

  it('assigns correct inferredDir from bearing', () => {
    const vehicles = [
      makeVehicle({ id: 'v1', heading: 160 }), // dir '0'
      makeVehicle({ id: 'v2', heading: 343 }), // dir '1'
    ];
    const { vehicles: enriched } = analyzeRoute(vehicles, emptyHistory);
    expect(enriched.find(v => v.id === 'v1')!.analysis.inferredDir).toBe('0');
    expect(enriched.find(v => v.id === 'v2')!.analysis.inferredDir).toBe('1');
  });

  it('sets scheduleDeviation to null when no predictions provided', () => {
    const v = makeVehicle({ id: 'v1', heading: 160 });
    const { vehicles: enriched } = analyzeRoute([v], emptyHistory);
    expect(enriched[0].analysis.scheduleDeviation).toBeNull();
  });

  it('calculates positive scheduleDeviation (late) from predictions', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const scheduledTime = nowSeconds - 180; // scheduled 3 minutes ago = 180s late
    const predictions: PredictionIndex = new Map([
      ['trip_1', new Map([['stop_1', scheduledTime]])],
    ]);
    const v = makeVehicle({
      id: 'v1',
      heading: 160,
      tripId: 'trip_1',
      stopId: 'stop_1',
      reportedAt: nowSeconds,
    });
    const { vehicles: enriched } = analyzeRoute([v], emptyHistory, predictions);
    const dev = enriched[0].analysis.scheduleDeviation;
    expect(dev).not.toBeNull();
    expect(dev!).toBeGreaterThan(0);
    expect(enriched[0].analysis.anomalies).toContain('late');
  });

  it('calculates negative scheduleDeviation (early) from predictions', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const scheduledTime = nowSeconds + 120; // scheduled 2 minutes from now = 120s early
    const predictions: PredictionIndex = new Map([
      ['trip_1', new Map([['stop_1', scheduledTime]])],
    ]);
    const v = makeVehicle({
      id: 'v1',
      heading: 160,
      tripId: 'trip_1',
      stopId: 'stop_1',
      reportedAt: nowSeconds,
    });
    const { vehicles: enriched } = analyzeRoute([v], emptyHistory, predictions);
    const dev = enriched[0].analysis.scheduleDeviation;
    expect(dev).not.toBeNull();
    expect(dev!).toBeLessThan(0);
    expect(enriched[0].analysis.anomalies).toContain('early');
  });
});

// ---------------------------------------------------------------------------
// generateRecommendations
// ---------------------------------------------------------------------------

function makeAnalyzedVehicle(
  id: string,
  stopSequence: number,
  heading: number,
  anomalies: string[] = [],
  gapAhead: number | null = null,
  lat = 43.6482,
  lon = -79.3962,
): VehicleWithAnalysis {
  return {
    ...makeVehicle({ id, heading, stopSequence, lat, lon }),
    analysis: {
      inferredDir: heading < 180 ? '0' : '1',
      gapAhead,
      dwellSeconds: 0,
      predictedBunchSeconds: null,
      anomalies: anomalies as any,
      scheduleDeviation: null,
    },
  };
}

describe('generateRecommendations', () => {
  it('returns empty array when no vehicles', () => {
    expect(generateRecommendations('510', [])).toEqual([]);
  });

  it('generates a HOLD recommendation for a bunching pair', () => {
    const vehicles = [
      makeAnalyzedVehicle('v1', 5, 160, ['bunching'], 1),
      makeAnalyzedVehicle('v2', 6, 164, [], null),
    ];
    const recs = generateRecommendations('510', vehicles);
    expect(recs.length).toBeGreaterThan(0);
    const hold = recs.find(r => r.action === 'HOLD');
    expect(hold).toBeDefined();
    expect(hold!.severity).toBe('CRITICAL');
    expect(hold!.vehicleId).toBe('v1');
    expect(hold!.routeTag).toBe('510');
  });

  it('generates a HOLD recommendation for a closing pair', () => {
    const vehicles = [
      makeAnalyzedVehicle('v1', 4, 160, ['closing'], 3),
      makeAnalyzedVehicle('v2', 7, 164, [], null),
    ];
    const recs = generateRecommendations('510', vehicles);
    const hold = recs.find(r => r.action === 'HOLD');
    expect(hold).toBeDefined();
    expect(['HIGH', 'MEDIUM']).toContain(hold!.severity);
  });

  it('generates a RELEASE_EARLY recommendation for a large gap', () => {
    const vehicles = [
      makeAnalyzedVehicle('v1', 3, 160, ['gap_ahead'], 12),
      makeAnalyzedVehicle('v2', 15, 164, [], null),
    ];
    const recs = generateRecommendations('510', vehicles);
    const rel = recs.find(r => r.action === 'RELEASE_EARLY');
    expect(rel).toBeDefined();
  });

  it('sorts CRITICAL before HIGH before MEDIUM', () => {
    const vehicles = [
      makeAnalyzedVehicle('v1', 5, 160, ['bunching'], 1),
      makeAnalyzedVehicle('v2', 6, 164, ['gap_ahead'], 10),
      makeAnalyzedVehicle('v3', 16, 164, [], null),
    ];
    const recs = generateRecommendations('510', vehicles);
    const order: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
    for (let i = 0; i < recs.length - 1; i++) {
      expect(order[recs[i].severity]).toBeLessThanOrEqual(order[recs[i + 1].severity]);
    }
  });

  it('includes reason string that names both vehicles', () => {
    const vehicles = [
      makeAnalyzedVehicle('v1', 5, 160, ['bunching'], 1),
      makeAnalyzedVehicle('v2', 6, 164, [], null),
    ];
    const recs = generateRecommendations('510', vehicles);
    const hold = recs.find(r => r.action === 'HOLD')!;
    expect(hold.reason).toContain('v1');
    expect(hold.reason).toContain('v2');
  });
});

// ---------------------------------------------------------------------------
// generateCrossRouteRecommendations
// ---------------------------------------------------------------------------

function makeRouteState(
  tag: string,
  vehicles: VehicleWithAnalysis[],
): RouteState {
  return {
    tag,
    title: `${tag}-Test`,
    color: '#fff',
    stops: [],
    paths: [],
    vehicles,
    metrics: {
      activeCount: vehicles.length,
      bunchingPairs: vehicles.filter(v => v.analysis.anomalies.includes('bunching')).length,
      closingPairs: 0,
      dwellAnomalies: 0,
      largeGaps: vehicles.filter(v => v.analysis.anomalies.includes('gap_ahead')).length,
    },
    lastUpdated: Date.now(),
  };
}

const TEST_PAIR: CorridorPair = {
  id: 'test_corridor',
  name: 'Test Corridor',
  localRouteTag: '54',
  expressRouteTag: '954',
  expressSkipRatio: 0.60,
};

describe('generateCrossRouteRecommendations', () => {
  it('returns empty when neither route is monitored', () => {
    const recs = generateCrossRouteRecommendations({}, [TEST_PAIR]);
    expect(recs).toEqual([]);
  });

  it('returns empty when only one route of a pair is monitored', () => {
    const localVehicles = [makeAnalyzedVehicle('v1', 5, 160, ['gap_ahead'], 12)];
    const state = { '54': makeRouteState('54', localVehicles) };
    const recs = generateCrossRouteRecommendations(state, [TEST_PAIR]);
    expect(recs).toEqual([]);
  });

  it('returns empty when both routes have no vehicles', () => {
    const state = {
      '54':  makeRouteState('54',  []),
      '954': makeRouteState('954', []),
    };
    const recs = generateCrossRouteRecommendations(state, [TEST_PAIR]);
    expect(recs).toEqual([]);
  });

  it('generates CONVERT_TO_LOCAL when local has large gap and express vehicle is in the gap zone', () => {
    // Both vehicles on the same block — express vehicle is within 1500m of the local gap vehicle
    const gapLat = 43.6482, gapLon = -79.3962;
    const localVehicles = [
      makeAnalyzedVehicle('local1', 5,  160, ['gap_ahead'], 12, gapLat,         gapLon),
      makeAnalyzedVehicle('local2', 17, 160, [],            null, gapLat + 0.01, gapLon),
    ];
    // Express vehicle is ~100m away from the local gap vehicle — clearly in the gap zone
    const expressVehicles = [
      makeAnalyzedVehicle('exp1', 10, 160, [], null, gapLat + 0.0005, gapLon),
    ];
    const state = {
      '54':  makeRouteState('54',  localVehicles),
      '954': makeRouteState('954', expressVehicles),
    };
    const recs = generateCrossRouteRecommendations(state, [TEST_PAIR]);
    const convert = recs.find(r => r.action === 'CONVERT_TO_LOCAL');
    expect(convert).toBeDefined();
    expect(convert!.vehicleId).toBe('exp1');
    expect(convert!.routeTag).toBe('954');
    expect(convert!.partnerRouteTag).toBe('54');
    expect(convert!.reason).toContain('Test Corridor');
    expect(convert!.reason).toContain('exp1');
  });

  it('generates CONVERT_TO_EXPRESS when local is bunched and has a gap ahead', () => {
    const localVehicles = [
      makeAnalyzedVehicle('local1', 3,  160, ['bunching'],  1),
      makeAnalyzedVehicle('local2', 4,  160, ['gap_ahead'], 10),
      makeAnalyzedVehicle('local3', 14, 160, [],            null),
    ];
    const expressVehicles = [makeAnalyzedVehicle('exp1', 8, 160, [], null)];
    const state = {
      '54':  makeRouteState('54',  localVehicles),
      '954': makeRouteState('954', expressVehicles),
    };
    const recs = generateCrossRouteRecommendations(state, [TEST_PAIR]);
    const convert = recs.find(r => r.action === 'CONVERT_TO_EXPRESS');
    expect(convert).toBeDefined();
    expect(convert!.routeTag).toBe('54');
    expect(convert!.partnerRouteTag).toBe('954');
    expect(convert!.reason).toContain('54');
    expect(convert!.reason).toContain('954');
  });

  it('does not generate CONVERT_TO_EXPRESS when bunched but no gap ahead', () => {
    const localVehicles = [
      makeAnalyzedVehicle('local1', 3, 160, ['bunching'], 1),
      makeAnalyzedVehicle('local2', 4, 160, [],           null),
    ];
    const expressVehicles = [makeAnalyzedVehicle('exp1', 8, 160, [], null)];
    const state = {
      '54':  makeRouteState('54',  localVehicles),
      '954': makeRouteState('954', expressVehicles),
    };
    const recs = generateCrossRouteRecommendations(state, [TEST_PAIR]);
    expect(recs.find(r => r.action === 'CONVERT_TO_EXPRESS')).toBeUndefined();
  });

  it('does not generate CONVERT_TO_LOCAL when express vehicle is not in the gap zone', () => {
    // Express vehicle is ~3.3km away from the local gap vehicle (well outside the 1500m radius)
    const gapLat = 43.6482, gapLon = -79.3962;
    const localVehicles = [
      makeAnalyzedVehicle('local1', 5,  160, ['gap_ahead'], 12, gapLat,         gapLon),
      makeAnalyzedVehicle('local2', 17, 160, [],            null, gapLat + 0.01, gapLon),
    ];
    // ~0.03 degrees latitude ≈ 3.3km — well outside 1500m corridor radius
    const expressVehicles = [makeAnalyzedVehicle('exp1', 30, 160, [], null, gapLat + 0.03, gapLon)];
    const state = {
      '54':  makeRouteState('54',  localVehicles),
      '954': makeRouteState('954', expressVehicles),
    };
    const recs = generateCrossRouteRecommendations(state, [TEST_PAIR]);
    expect(recs.find(r => r.action === 'CONVERT_TO_LOCAL')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Policy enforcement
// ---------------------------------------------------------------------------

describe('DispatchPolicy enforcement', () => {
  const bunchingVehicles = [
    makeAnalyzedVehicle('v1', 5, 160, ['bunching'], 1),
    makeAnalyzedVehicle('v2', 6, 164, [], null),
  ];

  it('suppresses HOLD when HOLD is removed from enabledActions', () => {
    const policy: DispatchPolicy = {
      ...DEFAULT_POLICY,
      enabledActions: ['RELEASE_EARLY', 'SHORT_TURN', 'CONVERT_TO_LOCAL', 'CONVERT_TO_EXPRESS'],
    };
    const recs = generateRecommendations('510', bunchingVehicles, 10000, policy);
    expect(recs.find(r => r.action === 'HOLD')).toBeUndefined();
  });

  it('still generates HOLD when HOLD is in enabledActions', () => {
    const recs = generateRecommendations('510', bunchingVehicles, 10000, DEFAULT_POLICY);
    expect(recs.find(r => r.action === 'HOLD')).toBeDefined();
  });

  it('suppresses MEDIUM recommendations when minimumSeverity is HIGH', () => {
    const gapVehicles = [
      makeAnalyzedVehicle('v1', 3, 160, ['gap_ahead'], 10),
      makeAnalyzedVehicle('v2', 13, 164, [], null),
    ];
    const policyHighOnly: DispatchPolicy = { ...DEFAULT_POLICY, minimumSeverity: 'HIGH' };
    const recs = generateRecommendations('510', gapVehicles, 10000, policyHighOnly);
    // RELEASE_EARLY is always MEDIUM — should be suppressed
    expect(recs.find(r => r.action === 'RELEASE_EARLY')).toBeUndefined();
  });

  it('shows MEDIUM recommendations when minimumSeverity is MEDIUM (default)', () => {
    const gapVehicles = [
      makeAnalyzedVehicle('v1', 3, 160, ['gap_ahead'], 10),
      makeAnalyzedVehicle('v2', 13, 164, [], null),
    ];
    const recs = generateRecommendations('510', gapVehicles, 10000, DEFAULT_POLICY);
    expect(recs.find(r => r.action === 'RELEASE_EARLY')).toBeDefined();
  });

  it('suppresses per-route action via routeOverrides', () => {
    const policy: DispatchPolicy = {
      ...DEFAULT_POLICY,
      routeOverrides: {
        '510': { disabledActions: ['HOLD'] },
      },
    };
    const recs = generateRecommendations('510', bunchingVehicles, 10000, policy);
    expect(recs.find(r => r.action === 'HOLD')).toBeUndefined();
  });

  it('allows HOLD on other routes when per-route override only targets one route', () => {
    const policy: DispatchPolicy = {
      ...DEFAULT_POLICY,
      routeOverrides: {
        '510': { disabledActions: ['HOLD'] },
      },
    };
    // Same vehicles but on route 504 — HOLD should still appear
    const recs = generateRecommendations('504', bunchingVehicles, 10000, policy);
    expect(recs.find(r => r.action === 'HOLD')).toBeDefined();
  });

  it('disableCrossRouteRecommendations suppresses all cross-route output', () => {
    const gapLat = 43.6482, gapLon = -79.3962;
    const localVehicles = [
      makeAnalyzedVehicle('local1', 5,  160, ['gap_ahead'], 12, gapLat,          gapLon),
      makeAnalyzedVehicle('local2', 17, 160, [],            null, gapLat + 0.01, gapLon),
    ];
    const expressVehicles = [
      makeAnalyzedVehicle('exp1', 10, 160, [], null, gapLat + 0.0005, gapLon),
    ];
    const state = {
      '54':  makeRouteState('54',  localVehicles),
      '954': makeRouteState('954', expressVehicles),
    };
    const policy: DispatchPolicy = { ...DEFAULT_POLICY, disableCrossRouteRecommendations: true };
    const recs = generateCrossRouteRecommendations(state, [TEST_PAIR], new Map(), policy);
    expect(recs).toEqual([]);
  });
});
