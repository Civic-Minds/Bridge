# Changelog

All notable changes to this project will be documented in this file.

## [1.2.0] - 2026-03-22

### Added
- **Static GTFS Loader** (`src/gtfs.ts`): Parses `stops.txt`, `trips.txt`, `shapes.txt`, and `stop_times.txt` at server startup. Filters to monitored routes only so `stop_times.txt` (the large file) doesn't load the full TTC dataset. Uses a proper quoted CSV parser to handle stop names with commas.
- **Route Polylines**: `RouteState.paths` is now populated with actual TTC shape geometry from `shapes.txt`. The map renders route lines on first load instead of leaving the paths layer empty.
- **Stop Markers**: `RouteState.stops` is now populated with ordered stops from the representative (longest) trip per route. The map renders small circle markers with hover tooltips showing stop names.
- **`scripts/fetch-gtfs.ts`**: Downloads and extracts TTC GTFS static data from Toronto Open Data on startup. Uses the CKAN API to resolve the current download URL. Re-downloads if data is older than 45 days.
- **`data/gtfs/`**: Local directory for GTFS files (excluded from git). `data/.gitkeep` tracks the directory.

### Changed
- **`RouteState` types**: `stops: unknown[]` and `paths: unknown[]` replaced with `stops: GtfsStop[]` and `paths: [number, number][][]`. `GtfsStop` interface added to `types.ts`.
- **Server boot sequence**: Startup is now async — GTFS data loads before routes are initialized. Falls back gracefully to empty paths/stops if the GTFS directory is missing.
- **`npm start` / `npm run dev`**: Both scripts now run `fetch-gtfs.ts` before the server, ensuring GTFS data is always present on boot.
- **`tsconfig.json`**: `rootDir` widened to `"."` and `scripts/**/*` added to `include` so the fetch script type-checks alongside `src/`.

## [1.1.0] - 2026-03-22

### Added — Dispatch Action Engine
- `generateRecommendations()` — produces specific, actionable dispatch instructions
  instead of colour-coded status indicators. Actions include:
  - `HOLD`: hold a closing/bunching vehicle N seconds at its current stop to restore headway
  - `RELEASE_EARLY`: release a terminal-held vehicle to fill a gap ahead
  - `SHORT_TURN`: turn a late vehicle back at a loop to fill the gap behind it
  - Each recommendation includes calculated hold time, estimated seconds to bunch,
    projected headway after the action, and a plain-language reason
- `generateCrossRouteRecommendations()` — cross-route service substitution engine:
  - `CONVERT_TO_EXPRESS`: rear-most vehicle in a bunched local group runs express pattern,
    pulling ahead of the bunch and filling a gap further up the corridor simultaneously
  - `CONVERT_TO_LOCAL`: express vehicle inside a local-route gap zone serves all local
    stops for one trip, reducing rider wait with quantified headway impact on the express
  - Detects corridor proximity using geographic distance (not stop sequence — sequences
    from different routes are incomparable numbers)
  - `TTC_CORRIDOR_PAIRS` registry: 16 TTC local/express pairs (Lawrence E/W, Finch E/W,
    Sheppard E/W, Steeles E/W, Dufferin, Jane, Kipling, Don Mills, Warden, Eglinton East,
    Keele, Midland) with `expressSkipRatio` for headway impact estimates
- `DispatchPolicy` — agency-configurable constraint layer controlling which action types
  Bridge will generate. Prevents recommendations from appearing when agency operating
  procedures, union contracts, or route constraints prohibit them. Fields:
  - `enabledActions`: global action type allowlist
  - `minimumSeverity`: suppress suggestions below MEDIUM / HIGH / CRITICAL threshold
  - `routeOverrides`: per-route disabled actions and severity thresholds
  - `disableCrossRouteRecommendations`: master switch for local/express conversion suggestions
  - `policyNotes`: free-text documentation of *why* a constraint exists (not just that it does)
  - `DEFAULT_POLICY` exports full permissive defaults for out-of-box use
- `TURNBACK_LOOPS` per-route registry — physical loop/terminal locations for all TTC
  streetcar routes (501–512). SHORT_TURN recommendations name the nearest feasible loop
  and its distance from the vehicle
- `scheduleDeviation` added to `VehicleAnalysis` — seconds behind schedule (positive=late,
  negative=early), computed from the GTFS-RT trip updates feed that was previously parsed
  but never used
- `early` / `late` anomaly types: >60s early or >120s late triggers anomaly flag
- `/api/recommendations` endpoint — all current dispatch recommendations sorted by severity
  (CRITICAL → HIGH → MEDIUM), including cross-route suggestions; `crossRouteCount` field
  distinguishes cross-route from single-route recommendations
- `/api/recommendations/:routeTag` — per-route recommendations
- `GET /api/policy` — returns active policy, available action types, and defaults
- `POST /api/policy` — partial policy update (merges with current; does not wipe other routes)
- `POST /api/policy/reset` — restores default permissive policy
- Route ladder view (`public/js/ladder.js`) — SKATE-style linear dispatcher view:
  vehicles positioned proportionally along route by stop sequence, coloured by anomaly
  state (bunching pulses red, closing=amber, early=blue, late=amber, on-time=green)
- 4-tab sidebar: Dispatch (action cards), Ladder (route view), Routes (summary), Feed (log)
- Dispatch tab flashes red when CRITICAL recommendations are active
- Policy configuration panel in settings modal — per-action checkboxes, severity threshold
  selector, cross-route master disable, and policy note field for documenting constraints
- Stats bar now shows Active / Bunching / Gaps / Actions (recommendation count)
- `fetchPolicy`, `updatePolicy`, `resetPolicy` added to `public/js/api.js`
- 14 new tests: schedule deviation, `generateRecommendations`, `generateCrossRouteRecommendations`,
  and `DispatchPolicy` enforcement (41 total, all passing)

### Changed
- Bearing-based direction inference (`inferDirection`) — TTC GTFS-RT reports dir:0 for all vehicles; bearing correctly separates northbound/southbound on 510 and eastbound/westbound on 504/501
- `buildPredictionIndex` — parses GTFS-RT trip updates feed into a tripId→stopId→time lookup; now actively used for schedule deviation computation
- `/api/anomalies` endpoint — now includes `scheduleDeviation` per vehicle
- Both feeds (vehicle positions + trip updates) fetched in parallel each poll
- `tripId` added to `Vehicle` type
- Stop-sequence based route analysis (`analyzeRoute`) replacing proximity bunching check
- Four anomaly signals: `bunchingPairs` (gap ≤ 1 stop), `closingPairs` (gap shrinking),
  `dwellAnomalies` (stopped ≥ 30s), `largeGaps` (gap > 2× average)
- Per-route vehicle history retained between polls to enable rate-of-change detection
- `VehicleRecord` and `VehicleHistory` types for cross-poll state
- New vehicle fields captured from GTFS-RT: `stopSequence`, `stopId`, `currentStatus`, `reportedAt`
- TypeScript migration: `src/types.ts`, `src/analysis.ts`, `src/server.ts`
- `tsconfig.json` (ES2020, strict, commonjs)
- `src/__tests__/analysis.test.ts` — Jest/ts-jest test suite
- `jest.config.js` with ts-jest preset
- `Dockerfile` (node:20-alpine, multi-step build)
- `.env.example` with `PORT` and `POLL_INTERVAL_MS`
- `README.md` — project overview, run instructions, data source, Docker usage
- `PORT` and `POLL_INTERVAL_MS` now read from environment variables (defaults: 3000, 10000)
- Fixed bug: `ui.js` was referencing `metrics.bunching` / `metrics.slow` (non-existent fields)
  instead of `metrics.bunchingPairs` / `metrics.dwellAnomalies`
- Replaced defunct NextBus XML API with TTC GTFS-Realtime vehicle positions feed
- Removed `node-fetch` and `fast-xml-parser` dependencies (native fetch + protobuf)
- Route initialization no longer fetches geometry from NextBus
- Expanded `ROUTE_META` to cover all TTC streetcar routes (501, 504–506, 509–512)
- Conflict zone radii corrected from degree values to metres
- `package.json` scripts updated: `start`, `dev`, `build`, `test`

### Removed
- NextBus `routeConfig` and `vehicleLocations` API calls
- `/api/config/routes` endpoint (was proxying NextBus route list)
- `routeConfig.xml` — obsolete NextBus geometry cache

---

## [0.1.0] - 2026-03-22

- Initial prototype: NextBus-based vehicle polling for TTC routes 510, 504, 501
- Bunching detection (N² same-direction proximity check, < 150m threshold)
- Leaflet map with dark CartoDB tiles, LERP-animated vehicle markers
- Conflict zone overlays (Spadina & Queen, King & Spadina, Union Station Loop)
- Sidebar dashboard with active vehicle count, alert count, incident feed
