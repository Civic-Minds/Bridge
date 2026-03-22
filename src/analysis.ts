import {
  Vehicle,
  VehicleWithAnalysis,
  VehicleHistory,
  VehicleRecord,
  RouteMetrics,
  AnomalyType,
  PredictionIndex,
  DispatchRecommendation,
  RecommendationSeverity,
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
 *  - enriched vehicles with per-vehicle analysis (direction, gap, dwell, anomalies, scheduleDeviation)
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
  predictions?: PredictionIndex,
): {
  vehicles: VehicleWithAnalysis[];
  metrics: Omit<RouteMetrics, 'activeCount'>;
  updatedHistory: VehicleHistory;
} {
  const nowSeconds = Math.floor(Date.now() / 1000);

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

      // Schedule deviation: compare reported timestamp to predicted arrival at current stop.
      // Positive = late (behind schedule), negative = early (ahead of schedule).
      let scheduleDeviation: number | null = null;
      if (predictions && v.tripId && v.stopId) {
        const tripPreds = predictions.get(v.tripId);
        if (tripPreds) {
          const scheduledArrival = tripPreds.get(v.stopId);
          if (scheduledArrival) {
            scheduleDeviation = (v.reportedAt || nowSeconds) - scheduledArrival;
            if (scheduleDeviation < -60) {
              anomalies.push('early'); // more than 1 minute early
            } else if (scheduleDeviation > 120) {
              anomalies.push('late'); // more than 2 minutes late
            }
          }
        }
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
        analysis: { inferredDir: dir, gapAhead: gap, dwellPolls, anomalies, scheduleDeviation },
      });
    }
  }

  const enrichedVehicles = vehicles.map(v =>
    analysisMap.get(v.id) ?? {
      ...v,
      analysis: {
        inferredDir: inferDirection(v.heading),
        gapAhead: null,
        dwellPolls: 0,
        anomalies: [],
        scheduleDeviation: null,
      },
    }
  );

  return {
    vehicles: enrichedVehicles,
    metrics: { bunchingPairs, closingPairs, dwellAnomalies, largeGaps },
    updatedHistory,
  };
}

/**
 * Generates concrete dispatch recommendations from analyzed vehicles.
 *
 * Rather than just showing colors, this engine produces specific, actionable instructions:
 * - HOLD: hold a closing/bunching vehicle at its current stop for N seconds
 * - RELEASE_EARLY: release a terminal-held vehicle immediately to fill a gap
 * - SHORT_TURN: instruct a late vehicle to turn back rather than continue to end terminal
 *
 * Severity tiers:
 *  CRITICAL — bunching has already occurred (gap ≤ 1 stop)
 *  HIGH     — closing pair will bunch within ~2 polls if no action
 *  MEDIUM   — large gap or late vehicle creating service hole
 */
export function generateRecommendations(
  routeTag: string,
  vehicles: VehicleWithAnalysis[],
  pollIntervalMs: number = 10000,
): DispatchRecommendation[] {
  const recommendations: DispatchRecommendation[] = [];
  const now = Date.now();

  // Estimate seconds per stop from vehicle speeds (fallback: 45s/stop)
  const movingVehicles = vehicles.filter(v => v.speed > 0);
  const avgSpeedMs = movingVehicles.length > 0
    ? movingVehicles.reduce((s, v) => s + v.speed, 0) / movingVehicles.length
    : 4.5; // ~16 km/h default streetcar speed
  // Rough stop spacing ~150m on TTC streetcar routes
  const secondsPerStop = Math.round(150 / avgSpeedMs);

  // Group by direction for gap context
  const byDir = new Map<string, VehicleWithAnalysis[]>();
  for (const v of vehicles) {
    const dir = v.analysis.inferredDir;
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push(v);
  }
  for (const arr of byDir.values()) {
    arr.sort((a, b) => a.stopSequence - b.stopSequence);
  }

  for (const [, sorted] of byDir) {
    const n = sorted.length;
    if (n < 2) continue;

    const validGaps = sorted
      .slice(0, n - 1)
      .map((v, i) => sorted[i + 1].stopSequence - v.stopSequence);
    const avgGap = validGaps.reduce((a, b) => a + b, 0) / validGaps.length;

    for (let i = 0; i < n - 1; i++) {
      const behind = sorted[i];       // vehicle behind (lower stopSequence)
      const ahead  = sorted[i + 1];  // vehicle ahead  (higher stopSequence)
      const gap = ahead.stopSequence - behind.stopSequence;
      const isBunching = behind.analysis.anomalies.includes('bunching');
      const isClosing  = behind.analysis.anomalies.includes('closing');
      const isLargeGap = behind.analysis.anomalies.includes('gap_ahead');

      if (isBunching || isClosing) {
        // How many stops until they meet?
        const stopsUntilBunch = isBunching ? 0 : gap;
        const secondsToBunch = stopsUntilBunch * secondsPerStop;

        // Hold time = half the gap deficit relative to average headway
        const gapDeficit = Math.max(0, avgGap - gap);
        const holdSeconds = Math.round((gapDeficit * secondsPerStop) / 2);

        const severity: RecommendationSeverity = isBunching ? 'CRITICAL' : (secondsToBunch < pollIntervalMs / 1000 * 3 ? 'HIGH' : 'MEDIUM');

        const deviationStr = behind.analysis.scheduleDeviation !== null
          ? ` (${behind.analysis.scheduleDeviation > 0 ? '+' : ''}${Math.round(behind.analysis.scheduleDeviation)}s vs schedule)`
          : '';

        recommendations.push({
          id: `${routeTag}-${behind.id}-HOLD`,
          routeTag,
          vehicleId: behind.id,
          action: 'HOLD',
          severity,
          holdSeconds: holdSeconds > 0 ? holdSeconds : null,
          atStop: behind.stopId,
          reason: isBunching
            ? `Vehicle ${behind.id} is bunched with ${ahead.id} (${gap} stop gap)${deviationStr}. Hold to restore ${Math.round(avgGap)}-stop headway.`
            : `Vehicle ${behind.id} closing on ${ahead.id}: gap ${gap} stops and shrinking${deviationStr}. Hold ${holdSeconds}s to prevent bunch.`,
          estimatedSecondsToBunch: isBunching ? 0 : secondsToBunch,
          headwayAfterAction: Math.round(avgGap),
          generatedAt: now,
        });
      }

      // Large gap: vehicle ahead of this gap should be released early from terminal,
      // or the vehicle behind should short-turn to come back and fill it.
      if (isLargeGap) {
        const gapStops = gap;
        const gapSeconds = gapStops * secondsPerStop;

        // If the vehicle behind is late, recommend short-turn
        const isLate = behind.analysis.anomalies.includes('late');
        if (isLate && behind.analysis.scheduleDeviation !== null && behind.analysis.scheduleDeviation > 180) {
          recommendations.push({
            id: `${routeTag}-${behind.id}-SHORT_TURN`,
            routeTag,
            vehicleId: behind.id,
            action: 'SHORT_TURN',
            severity: 'HIGH',
            holdSeconds: null,
            atStop: behind.stopId,
            reason: `Vehicle ${behind.id} is ${Math.round(behind.analysis.scheduleDeviation)}s late AND a ${gapStops}-stop gap exists ahead. Short-turn here to fill the gap behind rather than compounding delay at end terminal.`,
            estimatedSecondsToBunch: null,
            headwayAfterAction: Math.round(gapStops / 2),
            generatedAt: now,
          });
        } else {
          recommendations.push({
            id: `${routeTag}-${behind.id}-RELEASE_EARLY`,
            routeTag,
            vehicleId: behind.id,
            action: 'RELEASE_EARLY',
            severity: 'MEDIUM',
            holdSeconds: null,
            atStop: behind.stopId,
            reason: `${gapStops}-stop gap (≈${Math.round(gapSeconds / 60)} min wait for riders) ahead of vehicle ${behind.id}. If a spare is available at terminal, release early to fill gap.`,
            estimatedSecondsToBunch: null,
            headwayAfterAction: Math.round(gapStops / 2),
            generatedAt: now,
          });
        }
      }
    }
  }

  // Sort: CRITICAL first, then HIGH, then MEDIUM
  const order: Record<RecommendationSeverity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
  recommendations.sort((a, b) => order[a.severity] - order[b.severity]);

  return recommendations;
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
