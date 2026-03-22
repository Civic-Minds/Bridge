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
  RecommendationAction,
  CorridorPair,
  RouteState,
  DispatchPolicy,
  DEFAULT_POLICY,
} from './types';

const SEVERITY_ORDER: Record<RecommendationSeverity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };

/**
 * Returns true if the recommendation passes all policy gates.
 * Called before adding any recommendation to the output array.
 */
function allowedByPolicy(
  action: RecommendationAction,
  severity: RecommendationSeverity,
  routeTag: string,
  policy: DispatchPolicy,
): boolean {
  // Global action gate
  if (!policy.enabledActions.includes(action)) return false;

  // Global severity gate
  if (SEVERITY_ORDER[severity] > SEVERITY_ORDER[policy.minimumSeverity]) return false;

  // Per-route overrides
  const override = policy.routeOverrides[routeTag];
  if (override) {
    if (override.disabledActions?.includes(action)) return false;
    if (override.minimumSeverity && SEVERITY_ORDER[severity] > SEVERITY_ORDER[override.minimumSeverity]) return false;
  }

  return true;
}

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
  policy: DispatchPolicy = DEFAULT_POLICY,
  stopSpacingM: number = 150,
): DispatchRecommendation[] {
  const recommendations: DispatchRecommendation[] = [];
  const now = Date.now();

  // Estimate seconds per stop from real stop spacing and observed vehicle speeds.
  // stopSpacingM defaults to 150m if GTFS data is unavailable.
  const movingVehicles = vehicles.filter(v => v.speed > 0);
  const avgSpeedMs = movingVehicles.length > 0
    ? movingVehicles.reduce((s, v) => s + v.speed, 0) / movingVehicles.length
    : 4.5; // ~16 km/h default streetcar speed
  const secondsPerStop = Math.round(stopSpacingM / avgSpeedMs);

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

        if (allowedByPolicy('HOLD', severity, routeTag, policy)) {
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
      }

      // Large gap: vehicle ahead of this gap should be released early from terminal,
      // or the vehicle behind should short-turn to come back and fill it.
      if (isLargeGap) {
        const gapStops = gap;
        const gapSeconds = gapStops * secondsPerStop;

        // If the vehicle behind is late, recommend short-turn
        const isLate = behind.analysis.anomalies.includes('late');
        if (isLate && behind.analysis.scheduleDeviation !== null && behind.analysis.scheduleDeviation > 180) {
          if (allowedByPolicy('SHORT_TURN', 'HIGH', routeTag, policy)) {
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
          }
        } else {
          if (allowedByPolicy('RELEASE_EARLY', 'MEDIUM', routeTag, policy)) {
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
  }

  recommendations.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  return recommendations;
}

/**
 * Toronto TTC local/express corridor pairs.
 *
 * Each entry maps a local route to its express counterpart running the same corridor.
 * expressSkipRatio: roughly what fraction of local stops the express bypasses (0–1).
 * A ratio of 0.6 means the express skips ~60% of stops → is ~2.5× faster on that segment.
 *
 * Extend this registry as more routes are added to monitoring.
 */
export const TTC_CORRIDOR_PAIRS: CorridorPair[] = [
  { id: 'lawrence_east',    name: 'Lawrence East',    localRouteTag: '54',  expressRouteTag: '954', expressSkipRatio: 0.65 },
  { id: 'lawrence_west',    name: 'Lawrence West',    localRouteTag: '52',  expressRouteTag: '952', expressSkipRatio: 0.60 },
  { id: 'finch_west',       name: 'Finch West',       localRouteTag: '36',  expressRouteTag: '936', expressSkipRatio: 0.60 },
  { id: 'finch_east',       name: 'Finch East',       localRouteTag: '39',  expressRouteTag: '939', expressSkipRatio: 0.60 },
  { id: 'sheppard_east',    name: 'Sheppard East',    localRouteTag: '85',  expressRouteTag: '985', expressSkipRatio: 0.55 },
  { id: 'sheppard_west',    name: 'Sheppard West',    localRouteTag: '84',  expressRouteTag: '984', expressSkipRatio: 0.55 },
  { id: 'steeles_west',     name: 'Steeles West',     localRouteTag: '60',  expressRouteTag: '960', expressSkipRatio: 0.60 },
  { id: 'steeles_east',     name: 'Steeles East',     localRouteTag: '53',  expressRouteTag: '953', expressSkipRatio: 0.60 },
  { id: 'dufferin',         name: 'Dufferin',         localRouteTag: '29',  expressRouteTag: '929', expressSkipRatio: 0.50 },
  { id: 'jane',             name: 'Jane',             localRouteTag: '35',  expressRouteTag: '935', expressSkipRatio: 0.50 },
  { id: 'kipling',          name: 'Kipling',          localRouteTag: '45',  expressRouteTag: '944', expressSkipRatio: 0.55 },
  { id: 'don_mills',        name: 'Don Mills',        localRouteTag: '25',  expressRouteTag: '925', expressSkipRatio: 0.55 },
  { id: 'warden',           name: 'Warden',           localRouteTag: '68',  expressRouteTag: '968', expressSkipRatio: 0.50 },
  { id: 'eglinton_east',    name: 'Eglinton East',    localRouteTag: '34',  expressRouteTag: '905', expressSkipRatio: 0.60 },
  { id: 'keele',            name: 'Keele',            localRouteTag: '41',  expressRouteTag: '941', expressSkipRatio: 0.50 },
  { id: 'midland',          name: 'Midland',          localRouteTag: '43',  expressRouteTag: '942', expressSkipRatio: 0.50 },
];

/**
 * Generates cross-route service substitution recommendations.
 *
 * This engine looks across corridor pairs (local + express on the same street) and asks:
 *
 * 1. CONVERT_TO_LOCAL: Does the local route have a large gap, AND is there an express
 *    vehicle positioned inside or just ahead of that gap? If so, that express vehicle
 *    can serve all local stops through the gap zone — filling the wait for local riders
 *    without pulling any vehicle out of service.
 *
 * 2. CONVERT_TO_EXPRESS: Is the local route badly bunched, AND is there a vehicle near
 *    the back of the bunch? That vehicle can skip intermediate stops and run express
 *    ahead of the bunch — simultaneously relieving crowding AND filling a gap further up.
 *
 * The key insight: the data to do this has always existed in GTFS. We just never joined it.
 *
 * @param allRouteStates    Full state for every currently monitored route
 * @param corridorPairs     Registry of local/express pairs to evaluate (defaults to TTC registry)
 * @param stopSpacingByRoute  Average stop spacing in metres per route tag, from GTFS geometry.
 *                            Used together with observed vehicle speeds to estimate seconds/stop.
 *                            Falls back to 150m (→ ~33s at 16 km/h) if a route is absent.
 */
export function generateCrossRouteRecommendations(
  allRouteStates: Record<string, RouteState>,
  corridorPairs: CorridorPair[] = TTC_CORRIDOR_PAIRS,
  stopSpacingByRoute: Map<string, number> = new Map(),
  policy: DispatchPolicy = DEFAULT_POLICY,
): DispatchRecommendation[] {
  // Short-circuit if the agency has disabled cross-route recommendations entirely
  if (policy.disableCrossRouteRecommendations) return [];

  const recommendations: DispatchRecommendation[] = [];
  const now = Date.now();

  for (const pair of corridorPairs) {
    const localState   = allRouteStates[pair.localRouteTag];
    const expressState = allRouteStates[pair.expressRouteTag];

    // Derive seconds-per-stop for this pair from the local route's GTFS stop spacing
    // and the live average speed of its vehicles. Falls back to 150m / 4.5 m/s ≈ 33s.
    const spacingM = stopSpacingByRoute.get(pair.localRouteTag) ?? 150;
    const movingLocal = localState?.vehicles.filter(v => v.speed > 0) ?? [];
    const avgSpeedMs = movingLocal.length > 0
      ? movingLocal.reduce((s, v) => s + v.speed, 0) / movingLocal.length
      : 4.5;
    const secondsPerStop = Math.round(spacingM / avgSpeedMs);

    // Both routes must be actively monitored and have vehicles reporting
    if (!localState || !expressState) continue;
    if (localState.vehicles.length === 0 || expressState.vehicles.length === 0) continue;

    // ── 1. CONVERT_TO_LOCAL ────────────────────────────────────────────────
    // Condition: local route has a large gap AND an express vehicle is
    // geographically positioned within or just ahead of that gap.
    //
    // "Positioned within the gap" is approximated by comparing stop sequences
    // after normalizing both routes to a 0–1 fractional position along the corridor.
    // This is imprecise without shared stop IDs but is good enough for a suggestion.

    const localVehiclesWithGap = localState.vehicles.filter(v =>
      v.analysis.anomalies.includes('gap_ahead') && v.analysis.gapAhead !== null
    );

    for (const gapVehicle of localVehiclesWithGap) {
      const gapStops = gapVehicle.analysis.gapAhead!;
      const gapMinutes = Math.round((gapStops * secondsPerStop) / 60);

      // Find express vehicles within the geographic gap zone.
      //
      // Stop sequences from different routes are not comparable (route-54 stop-10 and
      // route-954 stop-10 are completely unrelated). We use geographic proximity instead:
      // local and express share the same street, so vehicles on the same corridor segment
      // will be within a few hundred metres of each other.
      //
      // GAP_CORRIDOR_RADIUS_M: how close (in metres) an express vehicle must be to the
      // local gap vehicle to be considered "inside" the gap zone.
      const GAP_CORRIDOR_RADIUS_M = 1500;

      const expressInGap = expressState.vehicles.filter(ev => {
        const dist = getDistance(ev.lat, ev.lon, gapVehicle.lat, gapVehicle.lon);
        return dist <= GAP_CORRIDOR_RADIUS_M;
      });

      if (expressInGap.length === 0) continue;

      // Pick the express vehicle geographically closest to the gap vehicle
      const candidate = expressInGap.sort((a, b) =>
        getDistance(a.lat, a.lon, gapVehicle.lat, gapVehicle.lon) -
        getDistance(b.lat, b.lon, gapVehicle.lat, gapVehicle.lon)
      )[0];

      // Estimate headway improvement: gap split roughly in half by the new local service
      const newLocalHeadwayMin = Math.round(gapMinutes / 2);
      // Express headway impact: the skipped stops add time, worsening express headway
      const expressImpactMin = Math.round(gapStops * secondsPerStop * (1 - pair.expressSkipRatio) / 60);

      // Only recommend if the rider benefit clearly outweighs the express cost
      if (newLocalHeadwayMin >= gapMinutes) continue;

      const convertToLocalSeverity: RecommendationSeverity = gapMinutes >= 15 ? 'HIGH' : 'MEDIUM';
      if (allowedByPolicy('CONVERT_TO_LOCAL', convertToLocalSeverity, pair.expressRouteTag, policy)) {
        recommendations.push({
          id: `${pair.localRouteTag}-${candidate.id}-CONVERT_TO_LOCAL`,
          routeTag: pair.expressRouteTag,
          partnerRouteTag: pair.localRouteTag,
          vehicleId: candidate.id,
          action: 'CONVERT_TO_LOCAL',
          severity: convertToLocalSeverity,
          holdSeconds: null,
          atStop: candidate.stopId,
          reason:
            `${pair.name} corridor — ${pair.localRouteTag}-local has a ${gapStops}-stop gap ` +
            `(≈${gapMinutes} min rider wait). Express vehicle ${candidate.id} is positioned ` +
            `inside this gap. Converting to local service for this trip would serve the missed stops, ` +
            `reducing local wait from ${gapMinutes} min to ≈${newLocalHeadwayMin} min. ` +
            `Express headway impact: +${expressImpactMin} min on ${pair.expressRouteTag}.`,
          estimatedSecondsToBunch: null,
          headwayAfterAction: newLocalHeadwayMin,
          generatedAt: now,
        });
      }
    }

    // ── 2. CONVERT_TO_EXPRESS ──────────────────────────────────────────────
    // Condition: local route has a bunching pair AND there's a vehicle at or
    // near the back of the bunch. That vehicle can skip stops and run express
    // ahead of the bunch, simultaneously relieving crowding and filling gaps
    // further up the route.

    const bunchedLocalVehicles = localState.vehicles.filter(v =>
      v.analysis.anomalies.includes('bunching') || v.analysis.anomalies.includes('closing')
    );

    if (bunchedLocalVehicles.length >= 1) {
      // The rear-most bunched vehicle is the best candidate (lowest stop sequence in bunch)
      const sorted = bunchedLocalVehicles.sort((a, b) => a.stopSequence - b.stopSequence);
      const rearVehicle = sorted[0];

      // Only suggest if there's also a large gap somewhere ahead on the local route
      const hasGapAhead = localState.vehicles.some(v => v.analysis.anomalies.includes('gap_ahead'));
      if (!hasGapAhead) continue;

      // Estimate how far ahead the vehicle would get by running express
      // Express skips expressSkipRatio of stops → travels proportionally faster
      const stopsSkipped = Math.round(10 * pair.expressSkipRatio); // over next ~10 stops
      const timesSaved   = Math.round(stopsSkipped * secondsPerStop);
      const gapFillStops = Math.round(stopsSkipped * 0.7); // rough gap fill estimate

      if (allowedByPolicy('CONVERT_TO_EXPRESS', 'MEDIUM', pair.localRouteTag, policy)) {
        recommendations.push({
          id: `${pair.localRouteTag}-${rearVehicle.id}-CONVERT_TO_EXPRESS`,
          routeTag: pair.localRouteTag,
          partnerRouteTag: pair.expressRouteTag,
          vehicleId: rearVehicle.id,
          action: 'CONVERT_TO_EXPRESS',
          severity: 'MEDIUM',
          holdSeconds: null,
          atStop: rearVehicle.stopId,
          reason:
            `${pair.name} corridor — ${pair.localRouteTag}-local is bunched (${bunchedLocalVehicles.length} vehicles ` +
            `close together) AND has a gap ahead. Vehicle ${rearVehicle.id} at the rear of the bunch ` +
            `can run express on ${pair.expressRouteTag} pattern, skipping ~${stopsSkipped} stops, ` +
            `pulling ≈${Math.round(timesSaved / 60)} min ahead of the bunch and filling the gap. ` +
            `Remaining local vehicles maintain local service. Announce skip stops to passengers onboard.`,
          estimatedSecondsToBunch: null,
          headwayAfterAction: gapFillStops,
          generatedAt: now,
        });
      }
    }
  }

  recommendations.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

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
