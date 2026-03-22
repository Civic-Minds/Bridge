# Bridge Roadmap

Bridge is a real-time transit dispatch assistant for the TTC. It detects service
degradation (bunching, gaps, dwell anomalies, schedule deviation) and produces
specific, actionable recommendations for dispatchers — rather than just showing
colour-coded status that a human still has to interpret.

The roadmap is organized by theme, not sprint, since priorities shift. Items within
each theme are roughly ordered by impact vs. effort.

---

## Theme 1 — Dispatcher Workflow (human-in-the-loop)

The current system surfaces recommendations but has no mechanism for a dispatcher
to act on them. The full loop is: **detect → recommend → approve → instruct → confirm**.

- [ ] **Recommendation approval/dismiss UI** — dispatcher clicks Accept or Dismiss on
  each action card. Accepted recommendations generate an operator instruction.
- [ ] **Operator instruction format** — when a dispatcher approves a HOLD recommendation,
  produce a structured message: `{ vehicleId, action, holdUntil, atStop, authorizedBy }`.
  This is the payload that would go to the in-vehicle display system.
- [ ] **In-vehicle display integration (stub)** — a configurable webhook endpoint that
  Bridge posts approved instructions to. Agencies connect this to their CAD system,
  MDT (mobile data terminal), or driver app. Bridge doesn't need to own this channel,
  just produce the right payload.
- [ ] **Recommendation acknowledgement tracking** — log whether recommendations were
  accepted, dismissed, or ignored (timed out). Feed this back into the algorithm to
  improve future suggestions (did holding that vehicle actually fix the gap?).
- [ ] **Supervisor override log** — audit trail of every recommendation generated,
  every decision made, and outcome. Useful for post-incident review and for documenting
  why certain policy constraints exist.

---

## Theme 2 — Algorithm Quality

The current algorithm is solid for detection but uses rough estimates for intervention
sizing (e.g. "seconds per stop" is a single constant). Better data improves recommendations.

- [ ] **Time-based headway** — current gap metric is stop-sequence difference (integer stops).
  Replace with time-based headway in seconds using vehicle speed + distance to next stop.
  This makes hold times much more accurate, especially on routes with uneven stop spacing.
- [ ] **Predicted headway (look-ahead)** — use vehicle speed and current position to predict
  where each vehicle will be in 5 and 10 minutes. Flag predicted bunches before they occur,
  not after. Current detection is reactive; this makes it proactive.
- [ ] **Dwell time estimation** — instead of counting polls at the same stop, estimate
  actual dwell time using `reportedAt` timestamps. More accurate than poll-count proxy.
- [ ] **Passenger load integration** — if real-time occupancy data is available (some TTC
  vehicles have APC), weight recommendations by load. A full bus stuck in a bunch is more
  urgent than an empty one.
- [ ] **Historical baseline** — track average headway and bunching frequency by route,
  time of day, and day of week. Use this to distinguish "route is normally irregular here"
  from "something unusual is happening." Avoids alert fatigue from chronic problem spots.

---

## Theme 3 — Static GTFS Integration

Route paths and stop coordinates are currently missing (`stops: []`, `paths: []`). This
limits the map view and makes geographic algorithms less precise.

- [ ] **Static GTFS loader** (`src/gtfs.ts`) — parse `shapes.txt`, `stops.txt`, and
  `stop_times.txt` from TTC static GTFS at server startup. Cache in memory.
- [ ] **Route polylines on map** — render actual route geometry on the Leaflet map instead
  of placeholder lines. Vehicles snap to their route path.
- [ ] **Stop markers** — show stops on the map, highlight the stop associated with each
  dwell anomaly.
- [ ] **Stop-to-stop distance lookup** — pre-compute distances between consecutive stops
  per route to replace the global `secondsPerStop` constant with route-specific values.
- [ ] **Shared stop detection** — for local/express corridor pairs, identify which stops
  are shared (served by both) vs. local-only (skipped by express). Use this to make
  CONVERT_TO_LOCAL recommendations more precise about which stops will be served.

---

## Theme 4 — Cross-Agency and Multi-Modal

Currently TTC-only. The architecture supports other GTFS-RT feeds.

- [ ] **Multi-agency support** — parameterize the feed URLs and agency ID. Allow monitoring
  Brampton Transit, MiWay, GO Transit, TTC simultaneously with agency-specific policies.
- [ ] **Bus monitoring** — extend beyond TTC streetcar routes to bus routes. The analysis
  is route-type-agnostic; the main change is expanding `ROUTE_META` and `CONFIG.routes`.
- [ ] **Corridor pair auto-detection** — instead of hardcoded `TTC_CORRIDOR_PAIRS`, detect
  local/express pairs automatically by comparing route shapes from static GTFS. Routes
  sharing >70% of their path (by geographic overlap) are candidate pairs.
- [ ] **Subway/SRT integration** — surface-level transit bunching is often downstream of
  subway delays (passengers stacking up at stations). Surfacing subway status alongside
  streetcar/bus data gives dispatchers context for unusual dwell patterns.

---

## Theme 5 — Data Persistence and Analytics

All state is currently in-memory. There is no history.

- [ ] **SQLite persistence** (`src/db.ts`) — store anomaly events, recommendation generations,
  and dispatcher decisions. Schema: `incidents`, `recommendations`, `decisions`.
- [ ] **24-hour trend charts** — bar chart in the sidebar showing bunching frequency per hour
  for each monitored route. Helps identify chronic problem times vs. current incidents.
- [ ] **Export API** — `GET /api/history?route=504&start=<ts>&end=<ts>` returns incident
  timeline for a route in a date range. Useful for performance reporting.
- [ ] **Baseline learning** — after collecting 2+ weeks of data, compute expected bunching
  rates per route/time/day. Trigger "elevated alert" when current rate exceeds baseline
  significantly (e.g. 2× normal bunching on a Sunday afternoon = unusual event).

---

## Theme 6 — Operational Context

Recommendations are currently generated from vehicle position data alone. Real dispatch
decisions depend on additional context that Bridge doesn't have yet.

- [ ] **Scheduled service level** — know how many vehicles *should* be on a route right now
  per the schedule. If 8 are scheduled and only 5 are reporting, surface a "missing service"
  alert before the gap becomes visible to riders.
- [ ] **Spare vehicle registry** — RELEASE_EARLY recommendations assume a spare is available
  at the terminal. If Bridge knows the spare board (vehicles staged at garages/terminals),
  it can make more specific recommendations: "Vehicle 9042 is staged at Neville Park Loop."
- [ ] **Special events overlay** — flag when a known event (Leafs game, CNE, etc.) is happening
  near a route. Event proximity predicts unusual ridership patterns and preemptively adjusts
  alert thresholds.
- [ ] **Construction and detour awareness** — if a route is on detour (from GTFS `calendar.txt`
  service exceptions or manual config), suppress short-turn recommendations for affected
  segments where the loop isn't accessible.

---

## Theme 7 — Infrastructure

- [ ] **WebSocket push** — replace 4-second frontend polling with server-sent events or
  WebSocket. Reduces latency from 4s to near-real-time for CRITICAL alerts.
- [ ] **Multi-instance deployment** — currently stateful (in-memory). Add Redis for shared
  state so multiple Bridge instances can run behind a load balancer.
- [ ] **Health endpoint** — `GET /health` returns feed staleness, last poll time, error rate.
  Useful for uptime monitoring.
- [ ] **Structured logging** — replace `console.log` with structured JSON logs (timestamp,
  level, route, event type). Enables log aggregation and alerting in production.
