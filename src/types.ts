export interface Vehicle {
  id: string;
  routeTag: string;
  lat: number;
  lon: number;
  speed: number;
  heading: number;
  dirTag: string;    // raw from GTFS-RT (unreliable for TTC — use inferredDir)
  isStalled: boolean;
  stopSequence: number;
  stopId: string;
  currentStatus: number; // 0=IN_TRANSIT_TO, 1=INCOMING_AT, 2=STOPPED_AT
  reportedAt: number;    // unix seconds
  tripId: string;
}

export type AnomalyType = 'bunching' | 'closing' | 'dwell' | 'gap_ahead';

// Per-vehicle computed fields added by analyzeRoute
export interface VehicleAnalysis {
  inferredDir: string;     // bearing-based direction: '0' or '1'
  gapAhead: number | null; // stop-sequence gap to the vehicle ahead (same direction)
  dwellPolls: number;      // consecutive polls stopped at the same stop
  anomalies: AnomalyType[];
}

export interface VehicleWithAnalysis extends Vehicle {
  analysis: VehicleAnalysis;
}

// Per-vehicle state retained between polls for rate-of-change detection
export interface VehicleRecord {
  stopSequence: number;
  stopId: string;
  status: number;
  dwellPolls: number;
  gapAhead: number | null;
  inferredDir: string;
}

export type VehicleHistory = Map<string, VehicleRecord>;

// Predicted arrival time (unix seconds) at a stop, keyed by stopId
export type TripPredictions = Map<string, number>;
// All predictions across all trips, keyed by tripId
export type PredictionIndex = Map<string, TripPredictions>;

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
  vehicles: VehicleWithAnalysis[];
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
