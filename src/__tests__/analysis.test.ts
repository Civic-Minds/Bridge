import { getDistance, inferDirection, analyzeRoute } from '../analysis';
import { Vehicle, VehicleHistory } from '../types';

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
      ['v1', { stopSequence: 2, stopId: 'stop_1', status: 0, dwellPolls: 0, gapAhead: 5, inferredDir: '0' }],
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
      ['v1', { stopSequence: 1, stopId: 'stop_1', status: 0, dwellPolls: 0, gapAhead: 3, inferredDir: '0' }],
    ]);
    const { metrics } = analyzeRoute(vehicles, history);
    expect(metrics.closingPairs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// analyzeRoute — dwell anomalies
// ---------------------------------------------------------------------------

describe('analyzeRoute — dwellAnomalies', () => {
  it('flags a vehicle stopped at the same stop for 3+ polls', () => {
    const v = makeVehicle({ id: 'v1', heading: 160, stopId: 'stop_X', currentStatus: 2 });
    const history: VehicleHistory = new Map([
      ['v1', { stopSequence: 1, stopId: 'stop_X', status: 2, dwellPolls: 2, gapAhead: null, inferredDir: '0' }],
    ]);
    const { metrics } = analyzeRoute([v], history);
    expect(metrics.dwellAnomalies).toBe(1);
  });

  it('does not flag a vehicle that just stopped this poll', () => {
    const v = makeVehicle({ id: 'v1', heading: 160, stopId: 'stop_X', currentStatus: 2 });
    const { metrics } = analyzeRoute([v], emptyHistory);
    expect(metrics.dwellAnomalies).toBe(0);
  });

  it('resets dwell count when a vehicle moves to a new stop', () => {
    const v = makeVehicle({ id: 'v1', heading: 160, stopId: 'stop_Y', currentStatus: 2 });
    const history: VehicleHistory = new Map([
      ['v1', { stopSequence: 1, stopId: 'stop_X', status: 2, dwellPolls: 5, gapAhead: null, inferredDir: '0' }],
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
});
