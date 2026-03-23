/**
 * Static GTFS loader for Bridge.
 *
 * Parses stops.txt, trips.txt, shapes.txt, and stop_times.txt from a local GTFS
 * directory and returns per-route path polylines and ordered stop lists.
 *
 * Only loads data for the route IDs passed in — stop_times.txt is large and we
 * skip every row that doesn't belong to a monitored route.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { log } from './logger';

export interface GtfsStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

export interface GtfsRouteData {
  /** Array of polylines (each polyline is an array of [lat, lon] pairs). */
  paths: [number, number][][];
  /** Ordered stops for the representative (longest) trip on this route. */
  stops: GtfsStop[];
}

/** Split a CSV line, respecting double-quoted fields that may contain commas. */
function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let inQuotes = false;
  let current = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

/** Parse a GTFS CSV file line-by-line, calling onRow for each data row. */
async function parseCsv(
  filePath: string,
  onRow: (row: Record<string, string>) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity,
    });
    let headers: string[] = [];
    let first = true;
    rl.on('line', line => {
      if (!line.trim()) return;
      if (first) {
        // Strip UTF-8 BOM if present on the first column header
        headers = splitCsvLine(line).map((h, i) =>
          i === 0 ? h.replace(/^\uFEFF/, '') : h,
        );
        first = false;
        return;
      }
      const values = splitCsvLine(line);
      const row: Record<string, string> = {};
      headers.forEach((h, i) => { row[h] = values[i] ?? ''; });
      onRow(row);
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
}

/**
 * Load static GTFS data for the given route IDs.
 *
 * Returns a Map of routeId → { paths, stops }.
 * Routes with no GTFS data are omitted from the result rather than erroring.
 */
export async function loadGtfs(
  gtfsDir: string,
  routeIds: string[],
): Promise<Map<string, GtfsRouteData>> {
  const routeIdSet = new Set(routeIds);

  // ── 1. stops.txt ────────────────────────────────────────────────────────────
  const stopsById = new Map<string, GtfsStop>();
  await parseCsv(path.join(gtfsDir, 'stops.txt'), row => {
    stopsById.set(row.stop_id, {
      id:   row.stop_id,
      name: row.stop_name,
      lat:  parseFloat(row.stop_lat),
      lon:  parseFloat(row.stop_lon),
    });
  });
  log.info('GTFS', 'stops loaded', { count: stopsById.size });

  // ── 2. trips.txt ─────────────────────────────────────────────────────────────
  // Filter to our routes; record shape_id per trip.
  const tripToShape = new Map<string, string>();  // tripId → shapeId
  const routeToTrips = new Map<string, string[]>(); // routeId → tripIds
  await parseCsv(path.join(gtfsDir, 'trips.txt'), row => {
    if (!routeIdSet.has(row.route_id)) return;
    tripToShape.set(row.trip_id, row.shape_id ?? '');
    if (!routeToTrips.has(row.route_id)) routeToTrips.set(row.route_id, []);
    routeToTrips.get(row.route_id)!.push(row.trip_id);
  });
  log.info('GTFS', 'trips indexed', { routes: [...routeToTrips.keys()].join(', ') });

  // ── 3. shapes.txt ────────────────────────────────────────────────────────────
  // Only load shapes referenced by our trips.
  const neededShapes = new Set([...tripToShape.values()].filter(Boolean));
  const shapePoints = new Map<string, { lat: number; lon: number; seq: number }[]>();
  await parseCsv(path.join(gtfsDir, 'shapes.txt'), row => {
    if (!neededShapes.has(row.shape_id)) return;
    if (!shapePoints.has(row.shape_id)) shapePoints.set(row.shape_id, []);
    shapePoints.get(row.shape_id)!.push({
      lat: parseFloat(row.shape_pt_lat),
      lon: parseFloat(row.shape_pt_lon),
      seq: parseInt(row.shape_pt_sequence, 10),
    });
  });
  log.info('GTFS', 'shapes loaded', { count: shapePoints.size });

  // ── 4. stop_times.txt ────────────────────────────────────────────────────────
  // Large file — skip rows that don't belong to our trips.
  // Track stop counts per trip to find the representative (longest) trip per route.
  const tripIdSet = new Set(tripToShape.keys());
  const tripStopCounts = new Map<string, number>();
  const tripStopList = new Map<string, { stopId: string; seq: number }[]>();

  await parseCsv(path.join(gtfsDir, 'stop_times.txt'), row => {
    if (!tripIdSet.has(row.trip_id)) return;
    if (!tripStopList.has(row.trip_id)) tripStopList.set(row.trip_id, []);
    tripStopList.get(row.trip_id)!.push({
      stopId: row.stop_id,
      seq:    parseInt(row.stop_sequence, 10),
    });
    tripStopCounts.set(row.trip_id, (tripStopCounts.get(row.trip_id) ?? 0) + 1);
  });

  // ── 5. Assemble per-route data ───────────────────────────────────────────────
  const result = new Map<string, GtfsRouteData>();

  for (const [routeId, tripIds] of routeToTrips) {
    // Representative trip = the one with the most stops
    let bestTripId = '';
    let bestCount  = 0;
    for (const tripId of tripIds) {
      const count = tripStopCounts.get(tripId) ?? 0;
      if (count > bestCount) { bestCount = count; bestTripId = tripId; }
    }

    // Ordered stops for representative trip
    const stops: GtfsStop[] = [];
    const rawStops = tripStopList.get(bestTripId);
    if (rawStops) {
      for (const { stopId } of rawStops.sort((a, b) => a.seq - b.seq)) {
        const s = stopsById.get(stopId);
        if (s) stops.push(s);
      }
    }

    // All unique shape polylines for this route
    const seenShapes = new Set<string>();
    const paths: [number, number][][] = [];
    for (const tripId of tripIds) {
      const shapeId = tripToShape.get(tripId);
      if (!shapeId || seenShapes.has(shapeId)) continue;
      seenShapes.add(shapeId);
      const pts = shapePoints.get(shapeId);
      if (!pts) continue;
      paths.push(
        pts.sort((a, b) => a.seq - b.seq).map(p => [p.lat, p.lon]),
      );
    }

    result.set(routeId, { paths, stops });
    log.info('GTFS', 'route assembled', { routeId, shapes: paths.length, stops: stops.length });
  }

  return result;
}
