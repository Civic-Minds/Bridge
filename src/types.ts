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

export type AnomalyType = 'bunching' | 'closing' | 'dwell' | 'gap_ahead' | 'early' | 'late';

// Per-vehicle computed fields added by analyzeRoute
export interface VehicleAnalysis {
  inferredDir: string;                  // bearing-based direction: '0' or '1'
  gapAhead: number | null;              // stop-sequence gap to the vehicle ahead (same direction)
  dwellSeconds: number;                 // elapsed seconds stopped at the current stop (0 if moving)
  predictedBunchSeconds: number | null; // projected seconds until this vehicle bunches with the one ahead
  anomalies: AnomalyType[];
  scheduleDeviation: number | null;     // seconds behind schedule (positive=late, negative=early)
}

export interface VehicleWithAnalysis extends Vehicle {
  analysis: VehicleAnalysis;
}

// Per-vehicle state retained between polls for rate-of-change detection
export interface VehicleRecord {
  stopSequence: number;
  stopId: string;
  status: number;
  dwellSince: number | null; // unix seconds when vehicle first stopped at current stop (null if moving)
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
  dwellAnomalies: number; // vehicles stopped ≥ 30s at the same stop
  largeGaps: number;      // gaps more than 2× the route's average gap
}

export interface GtfsStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

export interface RouteState {
  tag: string;
  title: string;
  color: string;
  stops: GtfsStop[];
  paths: [number, number][][];
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

// A concrete action the dispatcher should take right now
export type RecommendationAction =
  | 'HOLD'
  | 'RELEASE_EARLY'
  | 'SHORT_TURN'
  | 'CONVERT_TO_LOCAL'    // express vehicle serves all local stops through a gap zone
  | 'CONVERT_TO_EXPRESS'; // local vehicle skips intermediate stops to pull ahead of a bunch

export type RecommendationSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM';

export type RecommendationStatus = 'pending' | 'approved' | 'dismissed';

export interface DispatchRecommendation {
  id: string;                        // unique key: `${routeTag}-${vehicleId}-${action}`
  routeTag: string;                  // primary route this recommendation acts on
  partnerRouteTag?: string;          // for cross-route actions: the other route involved
  vehicleId: string;
  action: RecommendationAction;
  severity: RecommendationSeverity;
  holdSeconds: number | null;        // for HOLD actions: seconds to hold at current stop
  atStop: string;                    // stop where the action should happen
  reason: string;                    // human-readable explanation
  estimatedSecondsToBunch: number | null; // how soon a bunch will occur if no action
  headwayAfterAction: number | null; // predicted headway (in stops) if action taken
  generatedAt: number;               // unix ms
  // Decision state — set by the server when a dispatcher approves or dismisses
  status: RecommendationStatus;
  decidedAt: number | null;          // unix ms when dispatcher acted on this recommendation
  dismissReason: string | null;      // optional free-text reason when dismissed
  // Instruction outcome — populated for approved HOLD/SHORT_TURN recs after Bridge tracks compliance
  instructionStatus?: 'monitoring' | 'complied' | 'non_complied' | 'expired';
}

/**
 * Agency dispatch policy — controls which recommendation types Bridge will generate.
 *
 * Design philosophy:
 *   - Every constraint is EXPLICIT and NAMED. If an action type is disabled, a dispatcher
 *     looking at the config can see exactly why it isn't appearing and who set the policy.
 *   - Per-route overrides allow fine-grained control: maybe CONVERT_TO_LOCAL is allowed
 *     on route 54 but not route 36 due to operator union rules or equipment constraints.
 *   - Severity threshold gates low-priority noise without suppressing critical alerts.
 *     An agency that finds MEDIUM recommendations distracting can raise the threshold.
 *   - Nothing in this policy silently suppresses data. The raw anomaly data (/api/anomalies)
 *     is always available regardless of policy. Policy only filters the *action* recommendations.
 */
export interface DispatchPolicy {
  // Which action types are globally enabled. Remove an action type to disable it entirely.
  enabledActions: RecommendationAction[];

  // Minimum severity to surface a recommendation. 'MEDIUM' shows everything.
  // Set to 'HIGH' to suppress informational suggestions; 'CRITICAL' for emergency-only.
  minimumSeverity: RecommendationSeverity;

  // Per-route action overrides. Key is routeTag.
  // Example: { '36': { disabledActions: ['CONVERT_TO_LOCAL'] } }
  routeOverrides: Record<string, {
    disabledActions?: RecommendationAction[];
    minimumSeverity?: RecommendationSeverity;
  }>;

  // If true, cross-route recommendations (CONVERT_TO_LOCAL / CONVERT_TO_EXPRESS)
  // are globally disabled regardless of enabledActions. Useful for agencies that
  // have strict route separation policies or union rules against service switching.
  disableCrossRouteRecommendations: boolean;

  // Free-text policy notes visible in the UI and API, e.g.:
  // "CONVERT_TO_LOCAL disabled per operator contract clause 14.3 (Jan 2024)"
  // This documents WHY a constraint exists, not just that it does.
  policyNotes: string[];
}

// Default policy: everything enabled, no restrictions
export const DEFAULT_POLICY: DispatchPolicy = {
  enabledActions: ['HOLD', 'RELEASE_EARLY', 'SHORT_TURN', 'CONVERT_TO_LOCAL', 'CONVERT_TO_EXPRESS'],
  minimumSeverity: 'MEDIUM',
  routeOverrides: {},
  disableCrossRouteRecommendations: false,
  policyNotes: [],
};

// A local/express corridor pair on the same street
export interface CorridorPair {
  id: string;
  name: string;                // e.g. "Lawrence East"
  localRouteTag: string;       // e.g. "54"
  expressRouteTag: string;     // e.g. "954"
  // Approximate fraction of stops the express skips (0–1).
  // Used to estimate travel time difference between local and express service.
  expressSkipRatio: number;
}
