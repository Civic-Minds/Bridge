# Bridge — Overview for Transit Agencies

## What It Does

Bridge is a real-time dispatch assistant. It monitors your vehicle positions, detects
service problems as they form, and tells your dispatchers exactly what to do about them
— before riders notice.

Most transit operations software tells you what's wrong. Bridge tells you what to do:

> **Hold vehicle 4521 at King & Spadina for 90 seconds.** Closing on the vehicle ahead.
> Will restore 4-minute headway across the route.

> **Route 54 / 954 — Lawrence East corridor.** Express vehicle 9042 is inside a 12-stop
> local gap. Converting to local service for this trip reduces rider wait from 18 min to
> 9 min. Express headway impact: +4 min.

A dispatcher reads that, approves or dismisses it in one tap, and moves on. The algorithm
does the arithmetic; the dispatcher makes the call.

---

## What It Needs From You

Bridge runs entirely on data your agency almost certainly already publishes publicly:

**GTFS-Realtime vehicle positions feed**
A protobuf endpoint providing vehicle positions, stop sequence, heading, and trip ID.
If your vehicles have GPS and you have an AVL system, you have this feed.

**GTFS-Realtime trip updates feed** *(optional but recommended)*
Provides predicted arrival times per stop per trip. Bridge uses this to compute
schedule deviation (how many seconds late or early each vehicle is running).

**Static GTFS** *(optional, improves map quality)*
Your published route shapes and stop coordinates. Used to render route geometry
on the map and calibrate stop spacing estimates.

That's it. No new hardware. No new data collection. No proprietary integration required
to get started.

---

## What It Detects

Bridge runs continuously and flags four types of service problems:

| Problem | What it means | How detected |
|---|---|---|
| **Bunching** | Two vehicles running back-to-back (≤1 stop gap) | Stop-sequence gap analysis |
| **Closing** | Two vehicles whose gap is shrinking — will bunch soon | Gap change between polls |
| **Large gap** | Gap more than 2× the route average — long rider wait ahead | Gap vs. route average |
| **Dwell** | Vehicle stopped at the same stop for 30+ seconds | Consecutive poll comparison |

For routes where you run both local and express service on the same corridor, Bridge
also detects cross-route opportunities:

- Express vehicle inside a local-route gap → suggest converting to local service for that trip
- Local route bunched with a gap ahead → suggest rear vehicle runs express to pull ahead

---

## What It Recommends

Bridge produces five types of dispatch actions:

**HOLD** — Hold a vehicle at its current stop for a calculated number of seconds
to let spacing normalize. Used for closing pairs and active bunches.

**RELEASE EARLY** — Release a vehicle from a terminal earlier than scheduled
to fill a gap ahead. Triggered when a large gap exists and a spare may be available.

**SHORT TURN** — Instruct a late vehicle to turn back at a loop rather than
continuing to the end terminal. Fills the gap behind it without taking a vehicle
out of service.

**CONVERT TO LOCAL** — Instruct an express vehicle to serve all local stops
through a gap zone for one trip. Reduces rider wait on the local route; Bridge
quantifies the headway impact on the express so the dispatcher can weigh the tradeoff.

**CONVERT TO EXPRESS** — Instruct the rear-most vehicle in a bunched local group
to run express pattern (skip intermediate stops) to pull ahead of the bunch and
fill a gap further up the route simultaneously.

All recommendations are *suggestions*. Dispatchers approve or dismiss them. Nothing
is sent to an operator without human authorization.

---

## How Dispatcher Approval Works

1. A recommendation appears in the Dispatch panel, ranked by urgency (Critical / High / Medium)
2. The dispatcher reviews the reason and estimated impact
3. They tap **Accept** or **Dismiss**
4. If accepted, Bridge generates a structured instruction message and posts it to
   your configured endpoint — your MDT, driver app, or CAD system delivers it to the operator
5. The operator receives a clear, specific message on their in-cab display:
   *"Hold at next stop. Wait for release."* or *"Short-turn at Spadina Loop in 3 stops."*
6. Bridge tracks whether the vehicle responds and confirms or escalates

The instruction payload Bridge produces is standard JSON. If your MDT or CAD system
can receive a webhook, Bridge can integrate with it in a day.

---

## Policy Configuration

Every agency operates differently. Bridge has a first-class policy layer that respects
your operating procedures without requiring code changes.

You configure:

**Which action types are enabled**
If your collective agreement prohibits converting local buses to express service,
disable `CONVERT_TO_EXPRESS` globally. That recommendation will never appear.

**Minimum severity threshold**
Set to High if you only want alerts for imminent problems. Set to Critical if you only
want Bridge surfacing emergencies. Medium (default) shows everything.

**Per-route overrides**
Disable specific actions on specific routes. For example: SHORT_TURN enabled on route 54
but disabled on route 36 where there are no accessible loops.

**Policy notes**
Every constraint you configure can have a documented reason attached:
*"CONVERT_TO_LOCAL disabled — operator contract clause 14.3, Jan 2024."*
This creates an audit trail of why constraints exist, not just that they do.

Policy is updated live through the Bridge API or settings panel. No restart required.

---

## What Bridge Is Not

**Not a CAD system.** Bridge doesn't manage radio channels, operator assignments,
or trip blocking. It sits alongside your CAD and feeds it approved instructions.

**Not a scheduling tool.** Bridge doesn't touch your published schedules or run cuts.
It works with whatever service is scheduled today.

**Not a passenger information system.** Bridge doesn't directly update arrival signs
or trip planner predictions. Approved interventions can be forwarded to your GTFS-RT
publisher if you connect them.

**Not a replacement for dispatchers.** The algorithm handles pattern recognition and
arithmetic. The dispatcher handles context the algorithm can't know: medical incidents,
blocked intersections, vehicles going out of service, operator requests.
The final decision is always human.

---

## Getting Started

Bridge is open source and runs on any server with Node.js 20.

```bash
git clone https://github.com/Civic-Minds/Bridge
cd Bridge
npm install
npm run dev
```

Point it at your GTFS-RT feed URLs in `.env` and it starts monitoring immediately.
The default configuration monitors TTC streetcar routes 501, 504, and 510.
Switch to your routes by updating `CONFIG.routes` in `src/server.ts` or via the
live API at `POST /api/config/active-routes`.

For questions about integration or deployment, open an issue on GitHub.
