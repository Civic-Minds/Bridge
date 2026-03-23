import express, { Request, Response } from 'express';
import cors from 'cors';
import * as path from 'path';
import { analyzeRoute, buildPredictionIndex, generateRecommendations, generateCrossRouteRecommendations, getDistance } from './analysis';
import { Vehicle, VehicleHistory, RouteState, ConflictZone, DispatchRecommendation, DispatchPolicy, DEFAULT_POLICY, GtfsStop } from './types';
import { loadGtfs, GtfsRouteData } from './gtfs';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');

const app = express();
const PORT = parseInt(process.env.PORT ?? '3000', 10);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '10000', 10);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const TTC_VEHICLE_POSITIONS_URL = 'https://bustime.ttc.ca/gtfsrt/vehicles';
const TTC_TRIP_UPDATES_URL      = 'https://bustime.ttc.ca/gtfsrt/trips';

const CONFIG = {
  routes: ['510', '504', '501'],
};

const ROUTE_META: Record<string, { title: string; color: string }> = {
  '501': { title: '501-Queen',         color: '#ff69b4' },
  '504': { title: '504-King',          color: '#ffaa00' },
  '505': { title: '505-Dundas',        color: '#a855f7' },
  '506': { title: '506-Carlton',       color: '#22d3ee' },
  '509': { title: '509-Harbourfront',  color: '#34d399' },
  '510': { title: '510-Spadina',       color: '#ff0000' },
  '511': { title: '511-Bathurst',      color: '#60a5fa' },
  '512': { title: '512-St Clair',      color: '#f97316' },
};

const CONFLICT_ZONES: ConflictZone[] = [
  { id: 'zone_spadina_queen', name: 'Spadina & Queen',    lat: 43.6482, lon: -79.3962, radius: 60 },
  { id: 'zone_king_spadina',  name: 'King & Spadina',     lat: 43.6457, lon: -79.3952, radius: 60 },
  { id: 'zone_union',         name: 'Union Station Loop', lat: 43.6456, lon: -79.3800, radius: 200 },
];

/**
 * Turnback loops: physical locations where a streetcar can reverse direction.
 * Keyed by route tag. Each loop has a name, coordinates, and a rough stop radius
 * (how close a vehicle must be, in stops, to make the loop action feasible).
 *
 * These are the actual TTC loop/terminal locations. When the recommendation engine
 * generates a SHORT_TURN, it checks if the vehicle is near one of these and names it.
 */
interface TurnbackLoop {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radiusMeters: number; // vehicle must be within this distance to use the loop
}

const TURNBACK_LOOPS: Record<string, TurnbackLoop[]> = {
  '501': [
    { id: '501_neville',      name: 'Neville Park Loop',      lat: 43.6677, lon: -79.2937, radiusMeters: 200 },
    { id: '501_long_branch',  name: 'Long Branch Loop',       lat: 43.5956, lon: -79.5487, radiusMeters: 200 },
    { id: '501_humber',       name: 'Humber Loop',            lat: 43.6355, lon: -79.5067, radiusMeters: 200 },
    { id: '501_roncesvalles', name: 'Roncesvalles Loop',      lat: 43.6447, lon: -79.4504, radiusMeters: 250 },
  ],
  '504': [
    { id: '504_broadview',    name: 'Broadview Station Loop', lat: 43.6577, lon: -79.3606, radiusMeters: 200 },
    { id: '504_dundas_west',  name: 'Dundas West Station',    lat: 43.6551, lon: -79.4530, radiusMeters: 200 },
    { id: '504_distillery',   name: 'Distillery Loop',        lat: 43.6502, lon: -79.3580, radiusMeters: 200 },
  ],
  '505': [
    { id: '505_broadview',    name: 'Broadview Station Loop', lat: 43.6577, lon: -79.3606, radiusMeters: 200 },
    { id: '505_dundas_west',  name: 'Dundas West Station',    lat: 43.6551, lon: -79.4530, radiusMeters: 200 },
  ],
  '506': [
    { id: '506_main',         name: 'Main Street Station',    lat: 43.6918, lon: -79.2978, radiusMeters: 200 },
    { id: '506_high_park',    name: 'High Park Loop',         lat: 43.6539, lon: -79.4635, radiusMeters: 200 },
  ],
  '509': [
    { id: '509_union',        name: 'Union Station Loop',     lat: 43.6456, lon: -79.3800, radiusMeters: 200 },
    { id: '509_exhibition',   name: 'Exhibition Loop',        lat: 43.6351, lon: -79.4183, radiusMeters: 200 },
  ],
  '510': [
    { id: '510_spadina_stn',  name: 'Spadina Station Loop',   lat: 43.6677, lon: -79.4040, radiusMeters: 200 },
    { id: '510_union',        name: 'Union Station Loop',     lat: 43.6456, lon: -79.3800, radiusMeters: 200 },
    { id: '510_queens_quay',  name: "Queen's Quay Loop",      lat: 43.6398, lon: -79.3948, radiusMeters: 200 },
  ],
  '511': [
    { id: '511_bathurst_stn', name: 'Bathurst Station Loop',  lat: 43.6668, lon: -79.4109, radiusMeters: 200 },
    { id: '511_exhibition',   name: 'Exhibition Loop',        lat: 43.6351, lon: -79.4183, radiusMeters: 200 },
  ],
  '512': [
    { id: '512_st_clair_stn', name: 'St Clair Station Loop',  lat: 43.6878, lon: -79.4189, radiusMeters: 200 },
    { id: '512_gunns_loop',   name: "Gunn's Loop",            lat: 43.6771, lon: -79.4655, radiusMeters: 200 },
  ],
};

let systemState: Record<string, RouteState> = {};
let systemRecommendations: Record<string, DispatchRecommendation[]> = {};
const vehicleHistory: Record<string, VehicleHistory> = {};

// Active dispatch policy — mutable at runtime via POST /api/policy
let activePolicy: DispatchPolicy = { ...DEFAULT_POLICY };

// Static GTFS data loaded once at startup
let gtfsData: Map<string, GtfsRouteData> = new Map();
// Average stop spacing (metres) per route, derived from GTFS geometry at startup
let routeSpacing: Map<string, number> = new Map();

// Dispatcher decisions: keyed by recommendation ID, persisted across polls.
// After DECISION_TTL_MS a dismissed/approved rec becomes surfaceable again if the condition persists.
const DECISION_TTL_MS = 5 * 60 * 1000; // 5 minutes
const recDecisions = new Map<string, { status: 'approved' | 'dismissed'; decidedAt: number; dismissReason: string | null }>();

// Health tracking
const healthState = {
  startedAt: Date.now(),
  lastPollAt: 0,
  lastPollSuccess: true,
  consecutiveErrors: 0,
  lastError: null as string | null,
};

function initRoutes(): void {
  systemState = {};
  systemRecommendations = {};
  for (const tag of CONFIG.routes) {
    const meta = ROUTE_META[tag] ?? { title: `Route ${tag}`, color: '#00f2ff' };
    const gtfs = gtfsData.get(tag);
    systemState[tag] = {
      tag,
      title: meta.title,
      color: meta.color,
      stops: gtfs?.stops ?? [],
      paths: gtfs?.paths ?? [],
      vehicles: [],
      metrics: { activeCount: 0, bunchingPairs: 0, closingPairs: 0, dwellAnomalies: 0, largeGaps: 0 },
      lastUpdated: null,
    };
    systemRecommendations[tag] = [];
    vehicleHistory[tag] = new Map();
  }
  console.log(`[Init] Routes initialized: ${CONFIG.routes.join(', ')}`);
}

/**
 * Enriches SHORT_TURN recommendations with the nearest turnback loop name and distance,
 * making the recommendation actionable: "Turn back at Spadina Station Loop (80m away)".
 */
function enrichWithLoopData(
  recommendations: DispatchRecommendation[],
  vehicles: import('./types').VehicleWithAnalysis[],
  routeTag: string,
): DispatchRecommendation[] {
  const loops = TURNBACK_LOOPS[routeTag] ?? [];
  if (loops.length === 0) return recommendations;

  return recommendations.map(rec => {
    if (rec.action !== 'SHORT_TURN') return rec;

    const vehicle = vehicles.find(v => v.id === rec.vehicleId);
    if (!vehicle) return rec;

    // Find the nearest loop to this vehicle
    let nearestLoop: TurnbackLoop | null = null;
    let nearestDist = Infinity;
    for (const loop of loops) {
      const dist = getDistance(vehicle.lat, vehicle.lon, loop.lat, loop.lon);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestLoop = loop;
      }
    }

    if (!nearestLoop) return rec;

    const distStr = nearestDist < 1000
      ? `${Math.round(nearestDist)}m away`
      : `${(nearestDist / 1000).toFixed(1)}km away`;

    const feasible = nearestDist <= nearestLoop.radiusMeters * 4; // 4× radius = still worth mentioning

    return {
      ...rec,
      reason: feasible
        ? `${rec.reason} Nearest loop: ${nearestLoop.name} (${distStr}).`
        : `${rec.reason} Note: nearest loop is ${nearestLoop.name} (${distStr}) — may not be feasible from current position.`,
    };
  });
}

async function poll(): Promise<void> {
  try {
    // Fetch both feeds in parallel
    const [vehicleRes, tripRes] = await Promise.all([
      fetch(TTC_VEHICLE_POSITIONS_URL),
      fetch(TTC_TRIP_UPDATES_URL),
    ]);

    if (!vehicleRes.ok) throw new Error(`Vehicle feed failed: ${vehicleRes.status}`);
    if (!tripRes.ok)    throw new Error(`Trip feed failed: ${tripRes.status}`);

    const [vehicleBuf, tripBuf] = await Promise.all([
      vehicleRes.arrayBuffer(),
      tripRes.arrayBuffer(),
    ]);

    const RT = (GtfsRealtimeBindings as any).transit_realtime;
    const vehicleFeed = RT.FeedMessage.decode(new Uint8Array(vehicleBuf));
    const tripFeed    = RT.FeedMessage.decode(new Uint8Array(tripBuf));

    const predictions = buildPredictionIndex(tripFeed.entity);

    // Bucket vehicles by route
    const byRoute: Record<string, Vehicle[]> = {};
    for (const tag of CONFIG.routes) byRoute[tag] = [];

    for (const entity of vehicleFeed.entity) {
      const v = entity.vehicle;
      if (!v?.position) continue;

      const routeId: string = v.trip?.routeId;
      if (!routeId || !byRoute[routeId]) continue;

      byRoute[routeId].push({
        id: v.vehicle?.id || entity.id,
        routeTag: routeId,
        lat: v.position.latitude,
        lon: v.position.longitude,
        speed: v.position.speed ?? 0,
        heading: v.position.bearing ?? 0,
        dirTag: v.trip?.directionId?.toString() ?? '',
        isStalled: (v.position.speed ?? 0) === 0,
        stopSequence: v.currentStopSequence ?? 0,
        stopId: v.stopId ?? '',
        currentStatus: v.currentStatus ?? 0,
        reportedAt: v.timestamp?.low ?? 0,
        tripId: v.trip?.tripId ?? '',
      });
    }

    const now = Date.now();
    let totalVehicles = 0;

    for (const tag of CONFIG.routes) {
      if (!systemState[tag]) continue;
      const rawVehicles = byRoute[tag];

      const { vehicles, metrics, updatedHistory } = analyzeRoute(
        rawVehicles,
        vehicleHistory[tag] ?? new Map(),
        predictions,
        POLL_INTERVAL_MS,
      );

      vehicleHistory[tag] = updatedHistory;
      systemState[tag].vehicles = vehicles;
      systemState[tag].metrics = { activeCount: vehicles.length, ...metrics };
      systemState[tag].lastUpdated = now;
      totalVehicles += vehicles.length;

      // Generate single-route dispatch recommendations, filtered by active policy.
      // Pass real GTFS stop spacing so secondsPerStop reflects actual street geometry.
      const recs = generateRecommendations(tag, vehicles, POLL_INTERVAL_MS, activePolicy, routeSpacing.get(tag));
      systemRecommendations[tag] = enrichWithLoopData(recs, vehicles, tag);
    }

    // Cross-route recommendations: local/express corridor substitutions.
    // Runs once after all per-route analysis is complete, using the full system state.
    const crossRouteRecs = generateCrossRouteRecommendations(systemState, undefined, routeSpacing, activePolicy);
    // Store cross-route recs under a dedicated key so they don't collide with per-route recs
    systemRecommendations['_cross_route'] = crossRouteRecs;

    const totalRecs = Object.values(systemRecommendations).reduce((s, r) => s + r.length, 0);
    console.log(
      `[Poll] ${new Date().toLocaleTimeString()} — ${totalVehicles} vehicles | ` +
      CONFIG.routes.map(t => {
        const m = systemState[t]?.metrics;
        return `${t}: ${m?.bunchingPairs}b ${m?.closingPairs}c ${m?.dwellAnomalies}d ${m?.largeGaps}g`;
      }).join('  ') +
      (totalRecs > 0 ? ` | ${totalRecs} recommendation${totalRecs > 1 ? 's' : ''}` : '')
    );

    healthState.lastPollAt = Date.now();
    healthState.lastPollSuccess = true;
    healthState.consecutiveErrors = 0;
    healthState.lastError = null;

    // Evict stale decisions so a dismissed rec eventually re-surfaces if the condition persists
    const now2 = Date.now();
    for (const [id, decision] of recDecisions) {
      if (now2 - decision.decidedAt > DECISION_TTL_MS) recDecisions.delete(id);
    }
  } catch (err) {
    healthState.lastPollSuccess = false;
    healthState.consecutiveErrors++;
    healthState.lastError = (err as Error).message;
    console.error('[Poll] Error:', (err as Error).message);
  }
}

async function boot(): Promise<void> {
  const gtfsDir = path.join(__dirname, '..', 'data', 'gtfs');
  try {
    gtfsData = await loadGtfs(gtfsDir, Object.keys(ROUTE_META));
    // Compute average stop spacing per route from consecutive stop distances
    for (const [tag, data] of gtfsData) {
      const stops = data.stops;
      if (stops.length < 2) continue;
      let total = 0;
      for (let i = 0; i < stops.length - 1; i++) {
        total += getDistance(stops[i].lat, stops[i].lon, stops[i + 1].lat, stops[i + 1].lon);
      }
      routeSpacing.set(tag, total / (stops.length - 1));
    }
    console.log('[GTFS] Stop spacing (m):', Object.fromEntries(
      [...routeSpacing.entries()].map(([k, v]) => [k, Math.round(v)])
    ));
  } catch (err) {
    console.warn('[GTFS] Failed to load static data — routes will have no paths or stops:', (err as Error).message);
  }
  initRoutes();
  void poll();
  setInterval(() => void poll(), POLL_INTERVAL_MS);
}

void boot();

// --- API ---

app.get('/api/state', (_req: Request, res: Response) => {
  res.json({ agency: 'ttc', timestamp: Date.now(), routes: systemState, zones: CONFLICT_ZONES });
});

// Anomalies endpoint — flat list of vehicles with active anomalies, across all monitored routes
app.get('/api/anomalies', (_req: Request, res: Response) => {
  const anomalies = Object.values(systemState).flatMap(route =>
    route.vehicles
      .filter(v => v.analysis.anomalies.length > 0)
      .map(v => ({
        routeTag: route.tag,
        routeTitle: route.title,
        vehicleId: v.id,
        anomalies: v.analysis.anomalies,
        inferredDir: v.analysis.inferredDir,
        gapAhead: v.analysis.gapAhead,
        dwellSeconds: v.analysis.dwellSeconds,
        scheduleDeviation: v.analysis.scheduleDeviation,
        stopId: v.stopId,
        stopSequence: v.stopSequence,
        lat: v.lat,
        lon: v.lon,
      }))
  );
  res.json({ timestamp: Date.now(), count: anomalies.length, anomalies });
});

// Overlay dispatcher decisions onto a set of recommendations before returning them.
function applyDecisions(recs: DispatchRecommendation[]): DispatchRecommendation[] {
  return recs.map(rec => {
    const decision = recDecisions.get(rec.id);
    if (!decision) return rec;
    return { ...rec, status: decision.status, decidedAt: decision.decidedAt, dismissReason: decision.dismissReason };
  });
}

// Recommendations endpoint — actionable dispatch instructions, sorted by severity.
// Includes both single-route recommendations and cross-route corridor substitutions.
// Decisions (approved/dismissed) are overlaid from the dispatcher decision store.
app.get('/api/recommendations', (_req: Request, res: Response) => {
  const all = applyDecisions(Object.values(systemRecommendations).flat());
  const order: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
  all.sort((a, b) => order[a.severity] - order[b.severity]);
  const crossRouteCount = (systemRecommendations['_cross_route'] ?? []).length;
  res.json({
    timestamp: Date.now(),
    count: all.length,
    crossRouteCount,
    recommendations: all,
  });
});

// Per-route recommendations
app.get('/api/recommendations/:routeTag', (req: Request, res: Response) => {
  const routeTag = Array.isArray(req.params.routeTag) ? req.params.routeTag[0] : req.params.routeTag;
  const recs = systemRecommendations[routeTag];
  if (!recs) {
    res.status(404).json({ error: `Route ${routeTag} not monitored` });
    return;
  }
  res.json({ timestamp: Date.now(), routeTag, count: recs.length, recommendations: applyDecisions(recs) });
});

// Approve a recommendation — dispatcher has accepted and will action it
app.post('/api/recommendations/:id/approve', (req: Request, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  recDecisions.set(id, { status: 'approved', decidedAt: Date.now(), dismissReason: null });
  console.log(`[Decision] APPROVED: ${id}`);
  res.json({ success: true, id, status: 'approved' });
});

// Dismiss a recommendation — dispatcher has reviewed and chosen not to act
app.post('/api/recommendations/:id/dismiss', (req: Request, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const reason = (req.body as { reason?: unknown }).reason;
  const dismissReason = typeof reason === 'string' ? reason : null;
  recDecisions.set(id, { status: 'dismissed', decidedAt: Date.now(), dismissReason });
  console.log(`[Decision] DISMISSED: ${id}${dismissReason ? ` — "${dismissReason}"` : ''}`);
  res.json({ success: true, id, status: 'dismissed', dismissReason });
});

// Policy endpoints — read and update the active dispatch policy at runtime.
// GET  /api/policy         — returns the current policy + available actions + notes
// POST /api/policy         — replaces the active policy (full object required)
// POST /api/policy/reset   — restores the default policy

app.get('/api/policy', (_req: Request, res: Response) => {
  res.json({
    policy: activePolicy,
    availableActions: ['HOLD', 'RELEASE_EARLY', 'SHORT_TURN', 'CONVERT_TO_LOCAL', 'CONVERT_TO_EXPRESS'],
    severityLevels: ['MEDIUM', 'HIGH', 'CRITICAL'],
    defaults: DEFAULT_POLICY,
  });
});

app.post('/api/policy', (req: Request, res: Response) => {
  const body = req.body as Partial<DispatchPolicy>;

  // Validate required fields
  if (body.enabledActions && !Array.isArray(body.enabledActions)) {
    res.status(400).json({ error: 'enabledActions must be an array' });
    return;
  }
  if (body.minimumSeverity && !['MEDIUM', 'HIGH', 'CRITICAL'].includes(body.minimumSeverity)) {
    res.status(400).json({ error: 'minimumSeverity must be MEDIUM, HIGH, or CRITICAL' });
    return;
  }

  // Merge with current policy (partial update)
  activePolicy = {
    ...activePolicy,
    ...body,
    // Always merge routeOverrides rather than replace, so a partial POST doesn't wipe all overrides
    routeOverrides: { ...activePolicy.routeOverrides, ...(body.routeOverrides ?? {}) },
    // Merge policyNotes: append new notes rather than replace
    policyNotes: body.policyNotes ?? activePolicy.policyNotes,
  };

  console.log('[Policy] Updated:', JSON.stringify(activePolicy));
  res.json({ success: true, policy: activePolicy });
});

app.post('/api/policy/reset', (_req: Request, res: Response) => {
  activePolicy = { ...DEFAULT_POLICY };
  console.log('[Policy] Reset to defaults');
  res.json({ success: true, policy: activePolicy });
});

app.post('/api/config/active-routes', (req: Request, res: Response) => {
  const { routes } = req.body as { routes?: unknown };
  if (!routes || !Array.isArray(routes)) {
    res.status(400).json({ error: 'Invalid routes array' });
    return;
  }
  CONFIG.routes = routes as string[];
  initRoutes();
  res.json({ success: true, activeRoutes: CONFIG.routes });
});

// Health endpoint — for uptime monitoring and feed staleness checking.
// Returns 200 when the last poll succeeded, 503 when consecutive errors are accumulating.
app.get('/health', (_req: Request, res: Response) => {
  const now = Date.now();
  const lastPollAgeSeconds = healthState.lastPollAt > 0
    ? Math.round((now - healthState.lastPollAt) / 1000)
    : null;
  const totalVehicles = Object.values(systemState).reduce((s, r) => s + r.metrics.activeCount, 0);
  const status = healthState.consecutiveErrors >= 3 ? 'error'
    : healthState.consecutiveErrors >= 1 ? 'degraded'
    : 'ok';
  const code = status === 'error' ? 503 : 200;
  res.status(code).json({
    status,
    uptime: Math.round((now - healthState.startedAt) / 1000),
    lastPollAt: healthState.lastPollAt || null,
    lastPollAgeSeconds,
    consecutiveErrors: healthState.consecutiveErrors,
    lastError: healthState.lastError,
    routeCount: CONFIG.routes.length,
    vehicleCount: totalVehicles,
  });
});

app.listen(PORT, () => console.log(`Bridge running at http://localhost:${PORT}`));

export { getDistance };
