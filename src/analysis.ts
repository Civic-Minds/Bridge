import { Vehicle, VehicleHistory, VehicleRecord, RouteMetrics } from './types';

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
 * Analyzes a route's vehicle positions using stop-sequence data.
 *
 * Returns route-level metrics and an updated history map for the next poll.
 *
 * Signals computed:
 *  - bunchingPairs:  consecutive same-direction pairs with gap ≤ 1 stop
 *  - closingPairs:   pairs whose gap shrank since the last poll (pre-bunch warning)
 *  - dwellAnomalies: vehicles stopped at the same stop for 3+ consecutive polls (~30s)
 *  - largeGaps:      gaps more than 2× the average gap on that direction
 */
export function analyzeRoute(
  vehicles: Vehicle[],
  history: VehicleHistory
): { metrics: Omit<RouteMetrics, 'activeCount'>; updatedHistory: VehicleHistory } {
  // Group by direction, then sort ascending by stop sequence
  const byDir = new Map<string, Vehicle[]>();
  for (const v of vehicles) {
    if (!v.dirTag) continue;
    if (!byDir.has(v.dirTag)) byDir.set(v.dirTag, []);
    byDir.get(v.dirTag)!.push(v);
  }
  for (const arr of byDir.values()) {
    arr.sort((a, b) => a.stopSequence - b.stopSequence);
  }

  const updatedHistory: VehicleHistory = new Map();
  let bunchingPairs = 0;
  let closingPairs = 0;
  let dwellAnomalies = 0;
  let largeGaps = 0;

  for (const sorted of byDir.values()) {
    const n = sorted.length;

    // Compute gap from each vehicle to the one ahead of it
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

      // Bunching: at most 1 stop between this vehicle and the one ahead
      if (gap !== null && gap <= 1) bunchingPairs++;

      // Closing: gap to the vehicle ahead shrank since the last poll
      if (
        gap !== null &&
        prev?.gapAhead != null &&
        prev.gapAhead > 1 &&
        gap < prev.gapAhead
      ) {
        closingPairs++;
      }

      // Large gap: more than 2× average (a gap that's likely to cause a bunch behind it)
      if (gap !== null && avgGap > 0 && gap > avgGap * 2) largeGaps++;

      // Dwell: STOPPED_AT the same stop for consecutive polls
      const wasStopped = prev?.status === 2 && prev?.stopId === v.stopId;
      const dwellPolls = v.currentStatus === 2 ? (wasStopped ? (prev!.dwellPolls + 1) : 1) : 0;
      if (dwellPolls >= 3) dwellAnomalies++;

      const record: VehicleRecord = {
        stopSequence: v.stopSequence,
        stopId: v.stopId,
        status: v.currentStatus,
        dwellPolls,
        gapAhead: gap,
      };
      updatedHistory.set(v.id, record);
    }
  }

  return {
    metrics: { bunchingPairs, closingPairs, dwellAnomalies, largeGaps },
    updatedHistory,
  };
}
