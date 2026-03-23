# Bridge — Technical Roadmap

Feature backlog organized by theme. Items within each theme are roughly ordered
by impact vs. effort. This is a living document — priorities shift, but themes are stable.

---

## Theme 1 — Dispatcher Workflow (closing the loop)

The current system detects problems and surfaces recommendations. The full loop is:
**detect → recommend → approve → instruct → confirm**. Bridge currently stops at recommend.

- [x] **Recommendation approval/dismiss UI** — Accept/Dismiss buttons on each pending card.
  Dismissed recs hidden; approved recs dimmed. 5-minute TTL before re-surfacing.
- [ ] **Structured operator instruction payload** — on approval, produce:
  `{ vehicleId, action, parameter, atStop, expiresAt, authorizedBy, recommendationId }`.
  This is the message that goes to the in-vehicle display or CAD system.
- [x] **Outbound webhook** — `POST /api/webhook` sets a URL; Bridge delivers a signed
  instruction payload on every approval. HMAC-SHA256 signing optional.
- [x] **Instruction outcome tracking** — after issuing a HOLD, did the vehicle actually stop?
  After a SHORT_TURN, did the vehicle reverse? Close the loop by watching the vehicle's
  next position reports and flagging if the instruction wasn't followed.
- [ ] **Recommendation feedback loop** — log accepted/dismissed/expired status for every
  recommendation. Use this to tune algorithm parameters (e.g. if RELEASE_EARLY is
  dismissed 80% of the time on route 54, the gap threshold may be too aggressive).
- [ ] **Supervisor audit log** — timestamped record of every recommendation generated,
  every decision made, and outcome. For post-incident review and policy documentation.

---

## Theme 2 — Algorithm Quality

The current algorithm is reliable for detection but uses rough estimates for
intervention sizing. Better calibration improves recommendation accuracy.

- [x] **Time-based headway** — replace stop-sequence gap (integer stops) with seconds-based
  headway using vehicle speed and distance to next stop. Makes hold times significantly
  more accurate on routes with uneven stop spacing.
- [x] **Predicted bunching (look-ahead)** — `predictedBunchSeconds` derived from gap-closing
  rate per poll. Used in HOLD recommendation reason text and severity tier.
- [x] **`reportedAt`-based dwell timing** — `dwellSince` timestamp in VehicleRecord; `dwellSeconds`
  in VehicleAnalysis. Poll-interval-independent, accurate to the second.
- [x] **Per-route `secondsPerStop` calibration** — haversine-averaged stop spacing from GTFS
  geometry, passed to both recommendation generators each poll.
- [ ] **Passenger load weighting** — if APC (automatic passenger counter) data is available,
  weight recommendation urgency by load. A bunched full vehicle outranks a bunched empty one.
- [ ] **Historical baseline** — track average bunching frequency and headway variance by
  route, direction, hour, and day-of-week. Flag deviations from baseline rather than
  absolute thresholds. Reduces alert fatigue from chronically irregular routes.

---

## Theme 3 — Static GTFS Integration

Route paths and stop coordinates are currently unpopulated (`stops: []`, `paths: []`).
This limits map quality and makes geographic algorithms approximate.

- [x] **Static GTFS loader** (`src/gtfs.ts`) — parses `shapes.txt`, `stops.txt`, `trips.txt`,
  and `stop_times.txt` at server startup, filtered to monitored routes.
- [x] **Route polylines on map** — actual TTC shape geometry from `shapes.txt`.
- [x] **Stop markers** — circle markers with hover tooltips from ordered GTFS stop sequence.
- [x] **Per-route stop spacing** — haversine-averaged consecutive stop distances per route.
- [ ] **Shared stop detection for corridor pairs** — identify which stops are shared between
  a local and express route vs. local-only. Makes CONVERT_TO_LOCAL recommendations precise:
  "vehicle will serve stops X, Y, Z which the express skips."
- [ ] **Corridor pair auto-detection** — instead of hardcoded `TTC_CORRIDOR_PAIRS`, detect
  local/express pairs automatically by comparing route shapes. Routes sharing >70% of
  their path (by geographic overlap) are candidate pairs.

---

## Theme 4 — Multi-Agency and Multi-Modal

Currently TTC-only. The analysis pipeline is agency-agnostic; the binding is in config.

- [ ] **Multi-agency feed support** — parameterize feed URLs and agency ID. Support
  Brampton Transit, MiWay, GO Transit Bus, TTC simultaneously with per-agency policies.
- [ ] **Full bus route monitoring** — `ROUTE_META` currently covers TTC streetcars only.
  Extend to bus routes. The analysis algorithm doesn't distinguish vehicle types.
- [ ] **Subway delay surface** — bunching on surface routes is often downstream of subway
  delays (passengers stacking at stations). Surface subway status as context alongside
  streetcar/bus data so dispatchers can correlate.
- [ ] **Service alert integration** — ingest GTFS-RT service alerts feed. Suppress
  SHORT_TURN recommendations for segments on active detour (loop isn't accessible).

---

## Theme 5 — Data Persistence and Analytics

All state is in-memory. No history survives a restart.

- [x] **SQLite persistence** (`src/db.ts`) — `rec_decisions`, `anomaly_events`, and `instructions`
  tables. No external dependency (uses built-in `node:sqlite`).
- [x] **Trend charts** — 24-hour stacked bar chart in Trends tab: anomaly events per hour
  coloured by type. Route filter. Powered by `GET /api/history?groupBy=hour`.
- [x] **History API** — `GET /api/history?route=504&start=<ts>&end=<ts>` — event counts and
  average durations from `anomaly_events`, grouped by route and anomaly type.
- [ ] **Baseline learning** — after 2+ weeks of data, compute expected bunching rates by
  route/time/day. Alert when current rate exceeds baseline significantly.

---

## Theme 6 — Operational Context

Recommendations are currently generated from position data alone. Real dispatch
decisions depend on context Bridge doesn't have yet.

- [ ] **Scheduled service level** — know how many vehicles *should* be on a route right now.
  If 8 are scheduled and 5 are reporting, surface a "missing service" alert before the gap
  becomes visible to riders.
- [ ] **Spare vehicle registry** — RELEASE_EARLY recommendations assume a spare is staged
  at the terminal. If Bridge knows which spares are available and where, it can name the
  specific vehicle: "Vehicle 9042 is staged at Neville Park Loop."
- [ ] **Special events overlay** — flag when a known event (Leafs game, CNE, Pride) is
  happening near a route. Event proximity predicts unusual ridership and preemptively
  adjusts alert thresholds.
- [ ] **Construction / detour awareness** — if a route is on detour (from GTFS service
  exceptions or manual config), suppress recommendations for affected segments.

---

## Theme 7 — Infrastructure

- [x] **WebSocket / SSE push** — `GET /api/stream` broadcasts state + recs after every poll.
  Frontend uses EventSource; CRITICAL alerts arrive within one poll interval.
- [x] **Health endpoint** — `GET /health`: status, uptime, poll age, consecutive errors,
  SSE client count. HTTP 503 on 3+ consecutive failures.
- [x] **Structured logging** — `src/logger.ts` emits JSON lines (ts, level, component, msg,
  meta). All console.* replaced throughout server, analysis, and scripts.
- [ ] **Multi-instance state** — current in-memory state prevents horizontal scaling.
  Add Redis adapter so multiple Bridge instances share state behind a load balancer.
