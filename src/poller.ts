/**
 * Bridge polling engine.
 *
 * Owns the Atlas snapshot polling loop, per-route analysis, recommendation generation,
 * instruction compliance tracking, SSE broadcasting, and server boot sequence.
 *
 * Exports:
 *   boot()          — call once at startup; loads Atlas artifacts, restores DB state, starts poll loop
 *   initRoutes()    — (re-)initialise in-memory route state from CONFIG
 *   applyDecisions  — overlay dispatcher decisions + instruction outcomes onto a rec list
 */

import {
  analyzeRoute,
  generateRecommendations, generateCrossRouteRecommendations, getDistance,
} from './analysis';
import { fetchAtlasVehicles, fetchAtlasTripPredictions } from './atlas';
import { Vehicle, DispatchRecommendation, VehicleWithAnalysis, PredictionIndex } from './types';
import { loadAtlasStatic } from './atlasStatic';
import { log } from './logger';
import {
  loadRecentDecisions, seedOpenAnomalies, reconcileAnomalies,
  loadOpenInstructions, resolveInstruction, StoredInstruction,
} from './db';
import { CONFIG, ROUTE_META, CONFLICT_ZONES, TURNBACK_LOOPS, TurnbackLoop } from './config';
import { appState, POLL_INTERVAL_MS, DECISION_TTL_MS } from './state';

// ── Route initialisation ───────────────────────────────────────────────────

export function initRoutes(): void {
  appState.systemState = {};
  appState.systemRecommendations = {};
  for (const tag of CONFIG.routes) {
    const meta = ROUTE_META[tag] ?? { title: `Route ${tag}`, color: '#00f2ff' };
    const gtfs = appState.gtfsData.get(tag);
    appState.systemState[tag] = {
      tag,
      title: meta.title,
      color: meta.color,
      stops: gtfs?.stops ?? [],
      paths: gtfs?.paths ?? [],
      vehicles: [],
      metrics: { activeCount: 0, bunchingPairs: 0, closingPairs: 0, dwellAnomalies: 0, largeGaps: 0 },
      lastUpdated: null,
    };
    appState.systemRecommendations[tag] = [];
    appState.vehicleHistory[tag] = new Map();
  }
  log.info('Init', 'routes initialized', { routes: CONFIG.routes });
}

// ── Decision + instruction overlay ─────────────────────────────────────────

/**
 * Overlay dispatcher decisions and instruction outcomes onto a set of recommendations
 * before returning them from any API endpoint or SSE broadcast.
 */
export function applyDecisions(recs: DispatchRecommendation[]): DispatchRecommendation[] {
  return recs.map(rec => {
    const decision = appState.recDecisions.get(rec.id);
    const base = decision
      ? { ...rec, status: decision.status, decidedAt: decision.decidedAt, dismissReason: decision.dismissReason }
      : rec;

    if (base.status === 'approved' && (base.action === 'HOLD' || base.action === 'SHORT_TURN')) {
      const resolved = appState.resolvedOutcomes.get(rec.id);
      if (resolved) return { ...base, instructionStatus: resolved };
      if (appState.openInstructions.has(rec.id)) return { ...base, instructionStatus: 'monitoring' as const };
    }

    return base;
  });
}

// ── Recommendation enrichment ──────────────────────────────────────────────

/**
 * Enriches SHORT_TURN recommendations with the nearest turnback loop name and distance,
 * making the recommendation actionable: "Turn back at Spadina Station Loop (80m away)".
 */
function enrichWithLoopData(
  recommendations: DispatchRecommendation[],
  vehicles: VehicleWithAnalysis[],
  routeTag: string,
): DispatchRecommendation[] {
  const loops = TURNBACK_LOOPS[routeTag] ?? [];
  if (loops.length === 0) return recommendations;

  return recommendations.map(rec => {
    if (rec.action !== 'SHORT_TURN') return rec;

    const vehicle = vehicles.find(v => v.id === rec.vehicleId);
    if (!vehicle) return rec;

    let nearestLoop: TurnbackLoop | null = null;
    let nearestDist = Infinity;
    for (const loop of loops) {
      const dist = getDistance(vehicle.lat, vehicle.lon, loop.lat, loop.lon);
      if (dist < nearestDist) { nearestDist = dist; nearestLoop = loop; }
    }

    if (!nearestLoop) return rec;

    const distStr = nearestDist < 1000
      ? `${Math.round(nearestDist)}m away`
      : `${(nearestDist / 1000).toFixed(1)}km away`;
    const feasible = nearestDist <= nearestLoop.radiusMeters * 4;

    return {
      ...rec,
      reason: feasible
        ? `${rec.reason} Nearest loop: ${nearestLoop.name} (${distStr}).`
        : `${rec.reason} Note: nearest loop is ${nearestLoop.name} (${distStr}) — may not be feasible from current position.`,
    };
  });
}

// ── Instruction compliance ─────────────────────────────────────────────────

/**
 * Check each open instruction against current vehicle positions and resolve completed ones.
 *
 * HOLD compliance rules:
 *   - complied:     hold window elapsed while vehicle stayed at (or naturally left) the stop
 *   - non_complied: vehicle left the stop before the hold window elapsed
 *   - expired:      vehicle stopped reporting before the window could be resolved
 */
function checkInstructionCompliance(nowMs: number): void {
  for (const [recId, instr] of appState.openInstructions) {
    const route   = appState.systemState[instr.routeTag];
    const vehicle = route?.vehicles.find(v => v.id === instr.vehicleId);
    const elapsed = nowMs - instr.issuedAt;
    const held    = elapsed >= (instr.holdSeconds ?? 0) * 1000;

    let outcome: 'complied' | 'non_complied' | 'expired' | null = null;

    if (!vehicle) {
      if (elapsed > (instr.holdSeconds ?? 30) * 1000 + POLL_INTERVAL_MS * 2) outcome = 'expired';
    } else if (vehicle.stopId && instr.stopIdAtIssue && vehicle.stopId !== instr.stopIdAtIssue && !held) {
      outcome = 'non_complied';
    } else if (held) {
      outcome = 'complied';
    }

    if (outcome) {
      resolveInstruction(recId, outcome, nowMs);
      appState.resolvedOutcomes.set(recId, outcome);
      appState.openInstructions.delete(recId);
      log.info('Instruction', 'resolved', { recId, vehicleId: instr.vehicleId, outcome, elapsedMs: elapsed });
    }
  }
}

// ── SSE broadcast ──────────────────────────────────────────────────────────

/**
 * Push the current system state + recommendations to all connected SSE clients.
 * Called at the end of every successful poll.
 */
export function broadcastPoll(): void {
  if (appState.sseClients.size === 0) return;
  const recommendations = applyDecisions(Object.values(appState.systemRecommendations).flat());
  const payload = JSON.stringify({
    type:  'state',
    agency: 'ttc',
    timestamp: Date.now(),
    routes: appState.systemState,
    zones:  CONFLICT_ZONES,
    recommendations,
  });
  const msg = `data: ${payload}\n\n`;
  for (const client of appState.sseClients) {
    (client as unknown as { write: (s: string) => void }).write(msg);
  }
}

// ── Poll loop ──────────────────────────────────────────────────────────────

export async function poll(): Promise<void> {
  try {
    const routeTags = CONFIG.routes;
    const { vehicles: atlasVehicles, status: vehicleStatus, ageSeconds: vehicleAge } = await fetchAtlasVehicles(routeTags);
    let predictions: PredictionIndex = new Map();
    try {
      predictions = await fetchAtlasTripPredictions();
    } catch (err) {
      // Trip-level delay is useful context but is not required to detect vehicle bunching.
      // Keep the vehicle canary usable while exposing the degraded dependency in logs.
      log.warn('Atlas', 'trip snapshot unavailable; continuing without predictions', { err: (err as Error).message });
    }

    log.info('Atlas', 'live snapshots received', { vehicleStatus, vehicleAge, vehicles: atlasVehicles.length });

    const byRoute: Record<string, Vehicle[]> = {};
    for (const tag of CONFIG.routes) byRoute[tag] = [];
    for (const vehicle of atlasVehicles) byRoute[vehicle.routeTag]?.push(vehicle);

    const now = Date.now();
    let totalVehicles = 0;

    for (const tag of CONFIG.routes) {
      if (!appState.systemState[tag]) continue;

      const { vehicles, metrics, updatedHistory } = analyzeRoute(
        byRoute[tag],
        appState.vehicleHistory[tag] ?? new Map(),
        predictions,
        POLL_INTERVAL_MS,
      );

      appState.vehicleHistory[tag]             = updatedHistory;
      appState.systemState[tag].vehicles       = vehicles;
      appState.systemState[tag].metrics        = { activeCount: vehicles.length, ...metrics };
      appState.systemState[tag].lastUpdated    = now;
      totalVehicles += vehicles.length;

      const recs = generateRecommendations(
        tag, vehicles, POLL_INTERVAL_MS,
        appState.activePolicy, appState.routeSpacing.get(tag),
      );
      appState.systemRecommendations[tag] = enrichWithLoopData(recs, vehicles, tag);

      for (const v of vehicles) {
        reconcileAnomalies(tag, v.id, v.analysis.anomalies as string[], now);
      }
    }

    const crossRouteRecs = generateCrossRouteRecommendations(
      appState.systemState, undefined, appState.routeSpacing, appState.activePolicy,
    );
    appState.systemRecommendations['_cross_route'] = crossRouteRecs;

    const totalRecs = Object.values(appState.systemRecommendations).reduce((s, r) => s + r.length, 0);
    const routeMetrics = Object.fromEntries(CONFIG.routes.map(t => {
      const m = appState.systemState[t]?.metrics;
      return [t, { b: m?.bunchingPairs, c: m?.closingPairs, d: m?.dwellAnomalies, g: m?.largeGaps }];
    }));
    log.info('Poll', 'vehicles updated', { vehicles: totalVehicles, recs: totalRecs, routes: routeMetrics });

    checkInstructionCompliance(now);

    appState.healthState.lastPollAt        = Date.now();
    appState.healthState.lastPollSuccess   = true;
    appState.healthState.consecutiveErrors = 0;
    appState.healthState.lastError         = null;
    appState.healthState.sseClients        = appState.sseClients.size;

    broadcastPoll();

    // Evict stale decisions so dismissed recs eventually re-surface
    const now2 = Date.now();
    for (const [id, decision] of appState.recDecisions) {
      if (now2 - decision.decidedAt > DECISION_TTL_MS) appState.recDecisions.delete(id);
    }
  } catch (err) {
    appState.healthState.lastPollSuccess    = false;
    appState.healthState.consecutiveErrors++;
    appState.healthState.lastError          = (err as Error).message;
    log.error('Poll', 'feed error', {
      err: (err as Error).message,
      consecutiveErrors: appState.healthState.consecutiveErrors,
    });
  }
}

// ── Boot sequence ──────────────────────────────────────────────────────────

export async function boot(): Promise<void> {
  try {
    appState.gtfsData = await loadAtlasStatic(Object.keys(ROUTE_META));
    for (const [tag, data] of appState.gtfsData) {
      const stops = data.stops;
      if (stops.length < 2) continue;
      let total = 0;
      for (let i = 0; i < stops.length - 1; i++) {
        total += getDistance(stops[i].lat, stops[i].lon, stops[i + 1].lat, stops[i + 1].lon);
      }
      appState.routeSpacing.set(tag, total / (stops.length - 1));
    }
    log.info('Atlas', 'stop spacing computed', {
      spacingM: Object.fromEntries([...appState.routeSpacing.entries()].map(([k, v]) => [k, Math.round(v)])),
    });
  } catch (err) {
    log.warn('Atlas', 'failed to load static artifacts — routes will have no paths or stops', {
      err: (err as Error).message,
    });
  }

  // Restore dispatcher decisions from DB
  const storedDecisions = loadRecentDecisions(DECISION_TTL_MS);
  for (const d of storedDecisions) {
    appState.recDecisions.set(d.recId, { status: d.status, decidedAt: d.decidedAt, dismissReason: d.dismissReason });
  }
  if (storedDecisions.length > 0) {
    log.info('Boot', 'restored decisions from DB', { count: storedDecisions.length });
  }

  // Restore open instructions so compliance tracking survives a restart
  for (const instr of loadOpenInstructions()) {
    appState.openInstructions.set(instr.recId, instr);
  }
  if (appState.openInstructions.size > 0) {
    log.info('Boot', 'restored open instructions', { count: appState.openInstructions.size });
  }

  seedOpenAnomalies();
  initRoutes();
  void poll();
  setInterval(() => void poll(), POLL_INTERVAL_MS);
}
