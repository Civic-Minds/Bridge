# Bridge — Technical Roadmap

Feature backlog organized by theme. Items within each theme are roughly ordered
by impact vs. effort. This is a living document — priorities shift, but themes are stable.

---

## Theme 1 — Dispatcher Workflow (closing the loop)

The current system detects problems and surfaces recommendations. The full loop is:
**detect → recommend → approve → instruct → confirm**. Bridge currently stops at recommend.

- [ ] **Recommendation approval/dismiss UI** — dispatcher clicks Accept or Dismiss on
  each action card. Dismissed recommendations are logged with reason (optional free-text).
  Accepted recommendations transition to an instruction.
- [ ] **Structured operator instruction payload** — on approval, produce:
  `{ vehicleId, action, parameter, atStop, expiresAt, authorizedBy, recommendationId }`.
  This is the message that goes to the in-vehicle display or CAD system.
- [ ] **Outbound webhook** — configurable endpoint Bridge POSTs approved instructions to.
  Agencies connect this to their MDT, driver app, or CAD. Bridge doesn't own the delivery
  channel; it produces the right payload and hands it off.
- [ ] **Instruction outcome tracking** — after issuing a HOLD, did the vehicle actually stop?
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

- [ ] **Time-based headway** — replace stop-sequence gap (integer stops) with seconds-based
  headway using vehicle speed and distance to next stop. Makes hold times significantly
  more accurate on routes with uneven stop spacing.
- [ ] **Predicted bunching (look-ahead)** — use current vehicle velocity to project positions
  5 and 10 minutes ahead. Flag predicted bunches before they form. Current detection is
  reactive; look-ahead makes it proactive.
- [ ] **`reportedAt`-based dwell timing** — replace poll-count dwell proxy with actual
  elapsed time using `vehicle.reportedAt` timestamps. More accurate, poll-interval-independent.
- [ ] **Per-route `secondsPerStop` calibration** — replace the global 45s constant with
  route-specific values derived from historical travel times between stops. Feeds from
  static GTFS stop spacing + observed average speeds.
- [ ] **Passenger load weighting** — if APC (automatic passenger counter) data is available,
  weight recommendation urgency by load. A bunched full vehicle outranks a bunched empty one.
- [ ] **Historical baseline** — track average bunching frequency and headway variance by
  route, direction, hour, and day-of-week. Flag deviations from baseline rather than
  absolute thresholds. Reduces alert fatigue from chronically irregular routes.

---

## Theme 3 — Static GTFS Integration

Route paths and stop coordinates are currently unpopulated (`stops: []`, `paths: []`).
This limits map quality and makes geographic algorithms approximate.

- [ ] **Static GTFS loader** (`src/gtfs.ts`) — parse `shapes.txt`, `stops.txt`, and
  `stop_times.txt` at server startup. TTC static GTFS is publicly available, no auth needed.
- [ ] **Route polylines on map** — render actual route geometry instead of placeholder lines.
  Vehicles snap to the nearest point on their route path.
- [ ] **Stop markers** — show stops on map; highlight stops with active dwell anomalies.
- [ ] **Per-route stop spacing** — pre-compute distances between consecutive stops for each
  route. Feeds into time-based headway and per-route `secondsPerStop` calibration.
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

- [ ] **SQLite persistence** (`src/db.ts`) — store anomaly events, recommendations, and
  dispatcher decisions. Lightweight, no external dependency.
  Schema: `incidents(route, type, vehicle_id, timestamp, resolved_at)`,
  `recommendations(id, route, action, severity, generated_at, decision, decided_at)`.
- [ ] **Trend charts** — 24-hour bar chart in sidebar: bunching frequency per hour per route.
  Distinguishes current incident from chronic pattern.
- [ ] **History API** — `GET /api/history?route=504&start=<ts>&end=<ts>` returns incident
  timeline for a route in a time range. For performance reporting.
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

- [ ] **WebSocket / SSE push** — replace 4-second frontend polling with server-sent events.
  Reduces CRITICAL alert latency from up to 4s to near-real-time.
- [ ] **Health endpoint** — `GET /health` returns feed staleness, last poll timestamp,
  consecutive error count. For uptime monitoring.
- [ ] **Structured logging** — replace `console.log` with structured JSON logs (timestamp,
  level, route, event type). Enables log aggregation and production alerting.
- [ ] **Multi-instance state** — current in-memory state prevents horizontal scaling.
  Add Redis adapter so multiple Bridge instances share state behind a load balancer.
