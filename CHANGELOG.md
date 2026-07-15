# Changelog

All notable changes to this project will be documented in this file.

## [1.6.1] - 2026-07-15

- **Atlas static-artifact migration**: Bridge now loads TTC route geometry and stops from Atlas R2, removing its direct static-GTFS download and keeping upstream transit data ownership in Atlas.
- **Live dependency isolation**: Bridge continues vehicle analysis when Atlas trip snapshots are unavailable, while logging the degraded trip-data state.

- Bridge now consumes Atlas’s versioned R2-backed canary live snapshots instead of polling TTC GTFS-RT directly; dispatch analysis remains Bridge-owned.

## [1.6.0] - 2026-03-22

### Added
- **Recommendation feedback loop** — `GET /api/feedback?window=<ms>&route=<tag>` returns dispatcher decision rates (approve/dismiss counts + accept %) per route and action type over a configurable window (default 7 days). Powered by the existing `rec_decisions` table. Visible in the Trends tab as a colour-coded table below the hour chart — rows with <40% accept rate on ≥5 decisions are flagged red.
- **Webhook UI in settings modal** — the outbound webhook URL and HMAC secret are now configurable from the browser. Shows current status (configured/signed/not configured) when the modal opens; "Disable webhook" button available inline.

### Changed
- **Removed dead dependencies** — `fast-xml-parser` and `node-fetch` were removed from `package.json` (dropped in 1.1.0 but never cleaned up). `@types/adm-zip` moved to `devDependencies`.

### Added
- **Outbound webhook** — `POST /api/webhook` configures a URL Bridge will POST to on every approved HOLD/SHORT_TURN. Payload: `{ schemaVersion, type, recommendationId, vehicleId, routeTag, action, holdSeconds, atStop, severity, reason, issuedAt, expiresAt, bridgeInstanceId }`. Optional HMAC-SHA256 signing via `X-Bridge-Signature` header. Fire-and-forget — never delays the approval response. `GET /api/webhook` returns config; `DELETE /api/webhook` disables.
- **Trends tab** — new 5th sidebar tab with a 24-hour anomaly frequency chart. One horizontal bar row per hour; segments coloured by anomaly type (bunching=red, closing=orange, dwell=amber, gap=blue, schedule=purple), width proportional to event count. Route filter and refresh button. Empty state when the DB has no events yet.
- **`GET /api/history?groupBy=hour`** — returns per-hour anomaly counts (as well as the existing totals-only mode), powering the trend chart.
- **Instruction outcome tracking** — when a dispatcher approves a HOLD or SHORT_TURN recommendation, Bridge now creates an `instructions` DB row and tracks whether the vehicle actually complied. Each poll checks position against the stop at issue time: if the vehicle leaves before `holdSeconds` elapses → `non_complied`; if hold window passes → `complied`; if vehicle stops reporting → `expired`. Outcome survives server restarts.
- **Compliance badges on approved rec cards** — approved HOLD/SHORT_TURN cards now show a live status badge: `⏱ Monitoring…` → `✓ Vehicle held` / `⚠ Did not hold` / `— Expired` as the instruction resolves.
- **`GET /api/history` fully implemented** — queries `anomaly_events` table for event counts and average duration grouped by route and anomaly type. Accepts `start`, `end` (unix ms, defaults to last 24 h) and optional `route` filter. Returns `{ history: [{ routeTag, anomalyType, eventCount, avgDurationMs }] }`.
- **`instructions` table** in `bridge.db` — schema: `rec_id`, `vehicle_id`, `route_tag`, `action`, `at_stop`, `stop_id_at_issue`, `hold_seconds`, `issued_at`, `expires_at`, `lat_at_issue`, `lon_at_issue`, `outcome`, `resolved_at`. Open instructions are reloaded from DB on boot.

### Changed
- **All `console.*` calls in `src/gtfs.ts` replaced** with structured `log.*` (JSON lines) matching the rest of the codebase.
- **`instructionStatus` field** added to `DispatchRecommendation` type — `'monitoring' | 'complied' | 'non_complied' | 'expired'` — populated by `applyDecisions()` when an instruction exists for the rec.
- **`src/server.ts` refactored** into four focused modules — `src/config.ts` (static TTC data), `src/state.ts` (shared `appState` container + constants), `src/poller.ts` (poll loop, analysis, SSE, boot), `src/server.ts` (Express routes + listen). No behaviour changes; all 41 tests pass.

---

## [1.5.0] - 2026-03-22

### Added
- **`src/logger.ts`** — structured JSON logger. Every log line is a single JSON object: `{ ts, level, component, msg, ...meta }`. Info/warn/debug to stdout, error to stderr. Compatible with Loki, Datadog, CloudWatch without a parser sidecar.
- **`src/db.ts`** — SQLite persistence via `node:sqlite` (built-in, no new dependency). Two tables: `rec_decisions` (dispatcher decisions survive server restarts within the 5-minute TTL) and `anomaly_events` (open/close records per vehicle anomaly, enables future trend charts and baseline learning). Decisions are loaded from DB on boot and upserted on every approve/dismiss.
- **`GET /api/stream`** — server-sent events endpoint. After every successful poll, Bridge pushes a `data: <json>` message containing the full state + recommendations to all connected clients. Latency from data availability to dispatcher screen drops from up to 4 seconds to approximately one poll interval.
- **`GET /api/history`** — stub endpoint for future trend/incident queries (`start`, `end`, `route` params).
- **Anomaly event tracking** — `reconcileAnomalies()` called after each route analysis; opens a DB row when an anomaly first appears, closes it when it clears. Powers the `anomaly_events` table.

### Changed
- **Frontend polling replaced with EventSource**: the 4-second `setInterval` loop is gone. The page opens an `EventSource('/api/stream')` connection; state and recommendations are rendered on each server push. An initial `Promise.all([fetchState, fetchRecommendations])` provides the first render before the first push arrives.
- **All `console.*` calls replaced** with `log.*` (structured JSON) across `src/server.ts`, `src/analysis.ts`, and `scripts/fetch-gtfs.ts`.
- **Dispatcher decisions now persisted to SQLite**: `saveDecision()` is called on every approve/dismiss; `loadRecentDecisions()` restores the in-memory map on boot. A server restart no longer loses pending decisions.
- **`GET /health`** now includes `sseClients` count.
- **`package.json` version** updated to `1.5.0` to reflect actual release state.
- **`docs/ROADMAP_TECHNICAL.md`** updated to mark all completed items.

---

## [1.4.0] - 2026-03-22

### Added
- **Predicted bunching look-ahead**: `VehicleAnalysis.predictedBunchSeconds` — for every closing pair, projects seconds until bunch from the current gap-closing rate (`stopsClosedThisPoll / pollInterval`). More accurate than a static stop-count estimate. Used in HOLD recommendation text and severity classification.
- **Recommendation state machine**: `DispatchRecommendation` now carries `status` (`pending` | `approved` | `dismissed`), `decidedAt`, and `dismissReason`. Dispatcher decisions are stored in a `recDecisions` map with a 5-minute TTL (after TTL, a persistent condition re-surfaces the recommendation).
- **`POST /api/recommendations/:id/approve`** — marks a recommendation as accepted; logs the decision.
- **`POST /api/recommendations/:id/dismiss`** — marks a recommendation as dismissed with optional `{ reason }` body.
- **`GET /health`** — production monitoring endpoint: returns `status` (`ok` | `degraded` | `error`), uptime, last poll timestamp, last poll age in seconds, consecutive error count, last error message, route count, and vehicle count. Returns HTTP 503 when `consecutiveErrors >= 3`.
- **Accept / Dismiss UI on recommendation cards**: each pending rec card has Accept and Dismiss buttons. Clicking either POSTs to the respective endpoint and immediately re-fetches the recommendation list. Approved cards are visually dimmed; dismissed cards are hidden from the main view.

### Changed
- **`reportedAt`-based dwell timing**: replaced the poll-count proxy (`dwellPolls`) with real elapsed time. `VehicleRecord.dwellSince` stores the unix-second timestamp when the vehicle first stopped at its current stop. `VehicleAnalysis.dwellSeconds` is the elapsed seconds. Threshold remains 30s but is now poll-interval-independent and accurate to the second.
- **HOLD recommendation reason string**: updated to include projected seconds to bunch (`bunches in ≈Xs`) when a look-ahead estimate is available.
- **`GET /api/recommendations`** overlays decisions before responding — each rec in the response reflects its current `status`, `decidedAt`, and `dismissReason`.
- **`GET /api/anomalies`**: `dwellPolls` field replaced with `dwellSeconds`.
- **Health tracking in `poll()`**: updates `healthState` on success and failure; cleans up stale decisions on each successful poll.

---

## [1.3.0] - 2026-03-22

### Changed
- **Time-based headway in `generateRecommendations`**: Replaced hardcoded `150m` stop spacing with a `stopSpacingM` parameter (default `150`). Callers pass the real per-route average stop spacing computed from GTFS geometry so hold times and time-to-bunch estimates reflect actual street geometry rather than a fixed constant.
- **Time-based headway in `generateCrossRouteRecommendations`**: Replaced the flat `secondsPerStop = 45` parameter with `stopSpacingByRoute: Map<string, number>`. Seconds-per-stop is now derived per corridor pair from the local route's GTFS spacing and the live average speed of its vehicles. Falls back to `150m / 4.5 m/s ≈ 33s` when data is absent.
- **`boot()` in `server.ts`**: After `loadGtfs()`, computes average stop spacing (m) per route by summing haversine distances between consecutive ordered stops and dividing by the number of gaps. Stored in `routeSpacing: Map<string, number>` and passed to both recommendation functions each poll.

---

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
