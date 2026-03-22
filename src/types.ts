export interface Vehicle {
  id: string;
  routeTag: string;
  lat: number;
  lon: number;
  speed: number;
  heading: number;
  dirTag: string;
  isStalled: boolean;
  stopSequence: number;
  stopId: string;
  currentStatus: number; // 0=IN_TRANSIT_TO, 1=INCOMING_AT, 2=STOPPED_AT
  reportedAt: number;    // unix seconds from GTFS-RT timestamp
}

// Per-vehicle state retained between polls for rate-of-change detection
export interface VehicleRecord {
  stopSequence: number;
  stopId: string;
  status: number;
  dwellPolls: number;      // consecutive polls stopped at the same stopId
  gapAhead: number | null; // stop-sequence gap to the vehicle ahead (same direction)
}

export type VehicleHistory = Map<string, VehicleRecord>;

export interface RouteMetrics {
  activeCount: number;
  bunchingPairs: number;  // consecutive same-direction pairs with gap ≤ 1 stop
  closingPairs: number;   // pairs whose gap shrank since the last poll
  dwellAnomalies: number; // vehicles stopped at the same stop for 3+ polls (~30s)
  largeGaps: number;      // gaps more than 2× the route's average gap
}

export interface RouteState {
  tag: string;
  title: string;
  color: string;
  stops: unknown[];
  paths: unknown[];
  vehicles: Vehicle[];
  metrics: RouteMetrics;
  lastUpdated: number | null;
}

export interface ConflictZone {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radius: number;
}
