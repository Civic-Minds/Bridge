import express, { Request, Response } from 'express';
import cors from 'cors';
import { analyzeRoute, buildPredictionIndex, getDistance } from './analysis';
import { Vehicle, VehicleHistory, RouteState, ConflictZone } from './types';

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

let systemState: Record<string, RouteState> = {};
const vehicleHistory: Record<string, VehicleHistory> = {};

function initRoutes(): void {
  systemState = {};
  for (const tag of CONFIG.routes) {
    const meta = ROUTE_META[tag] ?? { title: `Route ${tag}`, color: '#00f2ff' };
    systemState[tag] = {
      tag,
      title: meta.title,
      color: meta.color,
      stops: [],
      paths: [],
      vehicles: [],
      metrics: { activeCount: 0, bunchingPairs: 0, closingPairs: 0, dwellAnomalies: 0, largeGaps: 0 },
      lastUpdated: null,
    };
    vehicleHistory[tag] = new Map();
  }
  console.log(`[Init] Routes initialized: ${CONFIG.routes.join(', ')}`);
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
      );

      vehicleHistory[tag] = updatedHistory;
      systemState[tag].vehicles = vehicles;
      systemState[tag].metrics = { activeCount: vehicles.length, ...metrics };
      systemState[tag].lastUpdated = now;
      totalVehicles += vehicles.length;
    }

    console.log(
      `[Poll] ${new Date().toLocaleTimeString()} — ${totalVehicles} vehicles | ` +
      CONFIG.routes.map(t => {
        const m = systemState[t]?.metrics;
        return `${t}: ${m?.bunchingPairs}b ${m?.closingPairs}c ${m?.dwellAnomalies}d ${m?.largeGaps}g`;
      }).join('  ')
    );
  } catch (err) {
    console.error('[Poll] Error:', (err as Error).message);
  }
}

initRoutes();
void poll();
setInterval(() => void poll(), POLL_INTERVAL_MS);

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
        dwellPolls: v.analysis.dwellPolls,
        stopId: v.stopId,
        stopSequence: v.stopSequence,
        lat: v.lat,
        lon: v.lon,
      }))
  );
  res.json({ timestamp: Date.now(), count: anomalies.length, anomalies });
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

app.listen(PORT, () => console.log(`Bridge running at http://localhost:${PORT}`));

export { getDistance };
