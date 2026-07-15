import { log } from './logger';

export interface GtfsStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

export interface GtfsRouteData {
  paths: [number, number][][];
  stops: GtfsStop[];
}

interface AtlasFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    geometry?: { type?: string; coordinates?: number[][] };
    properties?: { routeShortName?: string; stopOrder?: string[]; isCorridor?: boolean };
  }>;
}

type AtlasStops = Record<string, { name: string; lat: number; lon: number }>;

const ATLAS_DATA_URL = (process.env.ATLAS_DATA_URL ?? 'https://pub-85dc05d357954b6399c9a44018a3221e.r2.dev').replace(/\/$/, '');
const ATLAS_AGENCY = process.env.ATLAS_AGENCY ?? 'ttc';

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Atlas static artifact failed (${response.status}): ${url}`);
  return response.json() as Promise<T>;
}

/** Load public Atlas artifacts; Bridge never downloads GTFS itself. */
export async function loadAtlasStatic(routeIds: string[]): Promise<Map<string, GtfsRouteData>> {
  const [routes, stops] = await Promise.all([
    fetchJson<AtlasFeatureCollection>(`${ATLAS_DATA_URL}/atlas/${ATLAS_AGENCY}.json`),
    fetchJson<AtlasStops>(`${ATLAS_DATA_URL}/atlas/${ATLAS_AGENCY}-stops.json`),
  ]);
  const result = new Map<string, GtfsRouteData>();

  for (const routeId of routeIds) {
    const features = routes.features.filter(feature => {
      const properties = feature.properties;
      return properties?.routeShortName === routeId
        && properties.isCorridor !== true
        && feature.geometry?.type === 'LineString'
        && (feature.geometry.coordinates?.length ?? 0) >= 2;
    });
    const paths: [number, number][][] = [];
    const seenPaths = new Set<string>();
    let representativeStopOrder: string[] = [];
    for (const feature of features) {
      const coordinates = feature.geometry!.coordinates!;
      const path: [number, number][] = coordinates.map(([lon, lat]) => [lat, lon]);
      const pathKey = JSON.stringify(path);
      if (!seenPaths.has(pathKey)) {
        seenPaths.add(pathKey);
        paths.push(path);
      }
      const stopOrder = feature.properties?.stopOrder ?? [];
      if (stopOrder.length > representativeStopOrder.length) representativeStopOrder = stopOrder;
    }
    const orderedStops = representativeStopOrder
      .map(id => ({ id, ...stops[id] }))
      .filter(stop => stop.name && Number.isFinite(stop.lat) && Number.isFinite(stop.lon));
    result.set(routeId, { paths, stops: orderedStops });
  }

  log.info('Atlas', 'static artifacts loaded', { agency: ATLAS_AGENCY, routes: routeIds.join(',') });
  return result;
}
