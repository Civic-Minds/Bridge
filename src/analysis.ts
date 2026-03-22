import {
  Vehicle,
  VehicleWithAnalysis,
  VehicleHistory,
  VehicleRecord,
  RouteMetrics,
  AnomalyType,
  PredictionIndex,
} from './types';

export function getDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dPhi = ((lat2 - lat1) * Math.PI) / 180;
  const dLambda = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Infers travel direction from bearing since TTC's GTFS-RT reports dir:0 for all vehicles.
 *
 * Splits the compass into two halves: [0°, 180°) → '0', [180°, 360°) → '1'.
 * Works correctly for N-S routes (510 Spadina) and E-W routes (504 King, 501 Queen).
 * Note: vehicles turning at terminals may be temporarily misclassified, which is acceptable
 * since terminal vehicles don't participate in meaningful gap comparisons.
 */
export function inferDirection(bearing: number): string {
  const b = ((bearing % 360) + 360) % 360;
  return b >= 180 ? '1' : '0';
}

/**
 * Analyzes a route's vehicle positions using stop-sequence and bearing data.
 *
 * Returns:
 *  - enriched vehicles with per-vehicle analysis (direction, gap, dwell, anomalies)
 *  - route-level metrics
 *  - updated history for the next poll
 *
 * Signals:
 *  bunchingPairs  — consecutive same-direction pairs with gap ≤ 1 stop
 *  closingPairs   — pairs whose gap shrank since the last poll (pre-bunch warning)
 *  dwellAnomalies — vehicles stopped at the same stop for 3+ consecutive polls (~30s)
 *  largeGaps      — gaps more than 2× the average gap (rider wait time risk)
 */
export function analyzeRoute(
  vehicles: Vehicle[],
  history: VehicleHistory,
  _predictions?: PredictionIndex, // reserved for schedule deviation (future use)
): {
  vehicles: VehicleWithAnalysis[];
  metrics: Omit<RouteMetrics, 'activeCount'>;
  updatedHistory: VehicleHistory;
} {
  // Assign inferred direction from bearing and group
  const byDir = new Map<string, Vehicle[]>();
  for (const v of vehicles) {
    const dir = inferDirection(v.heading);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push(v);
  }
  for (const arr of byDir.values()) {
    arr.sort((a, b) => a.stopSequence - b.stopSequence);
  }

  const updatedHistory: VehicleHistory = new Map();
  const analysisMap = new Map<string, VehicleWithAnalysis>();

  let bunchingPairs = 0;
  let closingPairs = 0;
  let dwellAnomalies = 0;
  let largeGaps = 0;

  for (const [dir, sorted] of byDir) {
    const n = sorted.length;

    const gaps: (number | null)[] = sorted.map((_, i) =>
      i < n - 1 ? sorted[i + 1].stopSequence - sorted[i].stopSequence : null
    );

    const validGaps = gaps.filter((g): g is number => g !== null);
    const avgGap =
      validGaps.length > 0
        ? validGaps.reduce((a, b) => a + b, 0) / validGaps.length
        : 0;

    for (let i = 0; i < n; i++) {
      const v = sorted[i];
      const gap = gaps[i];
      const prev = history.get(v.id);
      const anomalies: AnomalyType[] = [];

      // Bunching: ≤ 1 stop gap to the vehicle ahead
      if (gap !== null && gap <= 1) {
        bunchingPairs++;
        anomalies.push('bunching');
      }

      // Closing: gap to vehicle ahead shrank since last poll
      if (gap !== null && prev?.gapAhead != null && prev.gapAhead > 1 && gap < prev.gapAhead) {
        closingPairs++;
        if (!anomalies.includes('bunching')) anomalies.push('closing');
      }

      // Large gap after this vehicle (the vehicle behind will face a wait)
      if (gap !== null && avgGap > 0 && gap > avgGap * 2) {
        largeGaps++;
        anomalies.push('gap_ahead');
      }

      // Dwell: STOPPED_AT the same stop for 3+ consecutive polls (~30s)
      const wasStopped = prev?.status === 2 && prev?.stopId === v.stopId;
      const dwellPolls = v.currentStatus === 2 ? (wasStopped ? prev!.dwellPolls + 1 : 1) : 0;
      if (dwellPolls >= 3) {
        dwellAnomalies++;
        anomalies.push('dwell');
      }

      const record: VehicleRecord = {
        stopSequence: v.stopSequence,
        stopId: v.stopId,
        status: v.currentStatus,
        dwellPolls,
        gapAhead: gap,
        inferredDir: dir,
      };
      updatedHistory.set(v.id, record);

      analysisMap.set(v.id, {
        ...v,
        analysis: { inferredDir: dir, gapAhead: gap, dwellPolls, anomalies },
      });
    }
  }

  const enrichedVehicles = vehicles.map(v =>
    analysisMap.get(v.id) ?? {
      ...v,
      analysis: { inferredDir: inferDirection(v.heading), gapAhead: null, dwellPolls: 0, anomalies: [] },
    }
  );

  return {
    vehicles: enrichedVehicles,
    metrics: { bunchingPairs, closingPairs, dwellAnomalies, largeGaps },
    updatedHistory,
  };
}

/**
 * Builds a PredictionIndex from a parsed GTFS-RT trips feed.
 * Returns a map of tripId → (stopId → predicted arrival unix seconds).
 */
export function buildPredictionIndex(feedEntities: any[]): PredictionIndex {
  const index: PredictionIndex = new Map();
  for (const entity of feedEntities) {
    const tu = entity.tripUpdate;
    if (!tu?.trip?.tripId) continue;
    const preds = new Map<string, number>();
    for (const stu of tu.stopTimeUpdate ?? []) {
      const time = stu.arrival?.time ?? stu.departure?.time;
      if (stu.stopId && time) {
        preds.set(stu.stopId, parseInt(time, 10));
      }
    }
    if (preds.size > 0) index.set(tu.trip.tripId, preds);
  }
  return index;
}
