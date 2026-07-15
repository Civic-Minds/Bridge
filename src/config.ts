/**
 * Static TTC configuration data.
 *
 * Pure data — no imports from this project, no runtime side effects.
 * Importing this module is always safe; it never executes I/O.
 */

import { ConflictZone } from './types';

/**
 * Active route set — mutable at runtime via POST /api/config/active-routes.
 * Mutate in place (push/splice/assign routes) so all importers see the change.
 */
export const CONFIG = {
  routes: ['510', '504', '501'],
};

export const ROUTE_META: Record<string, { title: string; color: string }> = {
  '501': { title: '501-Queen',        color: '#ff69b4' },
  '504': { title: '504-King',         color: '#ffaa00' },
  '505': { title: '505-Dundas',       color: '#a855f7' },
  '506': { title: '506-Carlton',      color: '#22d3ee' },
  '509': { title: '509-Harbourfront', color: '#34d399' },
  '510': { title: '510-Spadina',      color: '#ff0000' },
  '511': { title: '511-Bathurst',     color: '#60a5fa' },
  '512': { title: '512-St Clair',     color: '#f97316' },
};

export const CONFLICT_ZONES: ConflictZone[] = [
  { id: 'zone_spadina_queen', name: 'Spadina & Queen',    lat: 43.6482, lon: -79.3962, radius: 60 },
  { id: 'zone_king_spadina',  name: 'King & Spadina',     lat: 43.6457, lon: -79.3952, radius: 60 },
  { id: 'zone_union',         name: 'Union Station Loop', lat: 43.6456, lon: -79.3800, radius: 200 },
];

/**
 * Physical turnback loop/terminal locations for each TTC streetcar route.
 *
 * When the recommendation engine generates a SHORT_TURN, it checks which loop
 * is nearest to the vehicle and names it in the recommendation text so the
 * dispatcher and operator know exactly where the turn should happen.
 */
export interface TurnbackLoop {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Vehicle must be within this distance (metres) for the loop to be feasible. */
  radiusMeters: number;
}

export const TURNBACK_LOOPS: Record<string, TurnbackLoop[]> = {
  '501': [
    { id: '501_neville',      name: 'Neville Park Loop',      lat: 43.6677, lon: -79.2937, radiusMeters: 200 },
    { id: '501_long_branch',  name: 'Long Branch Loop',       lat: 43.5956, lon: -79.5487, radiusMeters: 200 },
    { id: '501_humber',       name: 'Humber Loop',            lat: 43.6355, lon: -79.5067, radiusMeters: 200 },
    { id: '501_roncesvalles', name: 'Roncesvalles Loop',      lat: 43.6447, lon: -79.4504, radiusMeters: 250 },
  ],
  '504': [
    { id: '504_broadview',   name: 'Broadview Station Loop', lat: 43.6577, lon: -79.3606, radiusMeters: 200 },
    { id: '504_dundas_west', name: 'Dundas West Station',    lat: 43.6551, lon: -79.4530, radiusMeters: 200 },
    { id: '504_distillery',  name: 'Distillery Loop',        lat: 43.6502, lon: -79.3580, radiusMeters: 200 },
  ],
  '505': [
    { id: '505_broadview',   name: 'Broadview Station Loop', lat: 43.6577, lon: -79.3606, radiusMeters: 200 },
    { id: '505_dundas_west', name: 'Dundas West Station',    lat: 43.6551, lon: -79.4530, radiusMeters: 200 },
  ],
  '506': [
    { id: '506_main',      name: 'Main Street Station', lat: 43.6918, lon: -79.2978, radiusMeters: 200 },
    { id: '506_high_park', name: 'High Park Loop',      lat: 43.6539, lon: -79.4635, radiusMeters: 200 },
  ],
  '509': [
    { id: '509_union',      name: 'Union Station Loop', lat: 43.6456, lon: -79.3800, radiusMeters: 200 },
    { id: '509_exhibition', name: 'Exhibition Loop',    lat: 43.6351, lon: -79.4183, radiusMeters: 200 },
  ],
  '510': [
    { id: '510_spadina_stn', name: 'Spadina Station Loop', lat: 43.6677, lon: -79.4040, radiusMeters: 200 },
    { id: '510_union',       name: 'Union Station Loop',   lat: 43.6456, lon: -79.3800, radiusMeters: 200 },
    { id: '510_queens_quay', name: "Queen's Quay Loop",    lat: 43.6398, lon: -79.3948, radiusMeters: 200 },
  ],
  '511': [
    { id: '511_bathurst_stn', name: 'Bathurst Station Loop', lat: 43.6668, lon: -79.4109, radiusMeters: 200 },
    { id: '511_exhibition',   name: 'Exhibition Loop',       lat: 43.6351, lon: -79.4183, radiusMeters: 200 },
  ],
  '512': [
    { id: '512_st_clair_stn', name: 'St Clair Station Loop', lat: 43.6878, lon: -79.4189, radiusMeters: 200 },
    { id: '512_gunns_loop',   name: "Gunn's Loop",           lat: 43.6771, lon: -79.4655, radiusMeters: 200 },
  ],
};
