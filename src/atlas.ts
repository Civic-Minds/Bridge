import { PredictionIndex, Vehicle } from './types';

const ATLAS_BASE_URL = (process.env.ATLAS_BASE_URL ?? 'https://atlas-gamma-two.vercel.app').replace(/\/$/, '');
const ATLAS_AGENCY = process.env.ATLAS_AGENCY ?? 'ttc';

interface AtlasSnapshot<T> {
  schemaVersion: string;
  status: 'fresh' | 'degraded' | 'stale' | 'unavailable';
  ageSeconds?: number;
  records: T[];
}

interface AtlasVehicleRecord {
  id: string;
  routeId: string;
  tripId: string;
  directionId: number | null;
  lat: number;
  lon: number;
  speedKmh: number | null;
  bearing: number | null;
  stopId: string | null;
  stopSequence: number | null;
  currentStatus: number | null;
  reportedAt: number | null;
}

async function fetchSnapshot<T>(feed: 'vehicles' | 'trips'): Promise<AtlasSnapshot<T>> {
  const url = `${ATLAS_BASE_URL}/api/live-snapshot?agency=${encodeURIComponent(ATLAS_AGENCY)}&feed=${feed}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  let body: AtlasSnapshot<T> & { error?: string };
  try {
    body = await response.json() as AtlasSnapshot<T> & { error?: string };
  } catch {
    throw new Error(`Atlas returned invalid JSON for ${feed}`);
  }
  if (!response.ok || body.status === 'unavailable') {
    throw new Error(`Atlas ${feed} snapshot unavailable: ${body.error ?? response.status}`);
  }
  if (body.schemaVersion !== 'atlas.live.v1') {
    throw new Error(`Unsupported Atlas live snapshot schema: ${body.schemaVersion}`);
  }
  return body;
}

export async function fetchAtlasVehicles(routeTags: string[]): Promise<{
  vehicles: Vehicle[];
  status: AtlasSnapshot<AtlasVehicleRecord>['status'];
  ageSeconds: number | null;
}> {
  const snapshot = await fetchSnapshot<AtlasVehicleRecord>('vehicles');
  const allowed = new Set(routeTags);
  const vehicles = snapshot.records
    .filter(record => allowed.has(record.routeId))
    .map(record => ({
      id: record.id,
      routeTag: record.routeId,
      lat: record.lat,
      lon: record.lon,
      speed: record.speedKmh == null ? 0 : record.speedKmh / 3.6,
      heading: record.bearing ?? 0,
      dirTag: record.directionId == null ? '' : String(record.directionId),
      isStalled: (record.speedKmh ?? 0) === 0,
      stopSequence: record.stopSequence ?? 0,
      stopId: record.stopId ?? '',
      currentStatus: record.currentStatus ?? 0,
      reportedAt: record.reportedAt ?? 0,
      tripId: record.tripId,
    }));
  return { vehicles, status: snapshot.status, ageSeconds: snapshot.ageSeconds ?? null };
}

/** The canary trip snapshot currently exposes trip-level delay, not per-stop predictions. */
export async function fetchAtlasTripPredictions(): Promise<PredictionIndex> {
  await fetchSnapshot('trips');
  return new Map();
}
