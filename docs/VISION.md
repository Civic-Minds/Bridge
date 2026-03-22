# Bridge — Vision

## The Problem

Transit agencies have more real-time data than ever. GPS positions every 10 seconds.
Schedule adherence feeds. Passenger load sensors. Automated vehicle locations on every
bus and streetcar. And yet if you stand at a stop on King Street at 5:30pm, you will
still watch four 504s arrive together followed by a 25-minute gap.

The data didn't fix the problem because the data was never connected to the decision.

Every piece of the transit operations stack was built separately, procured separately,
and lives in its own silo:

- The AVL system knows where every vehicle is
- The CAD system handles radio dispatching
- The scheduling system knows what *should* be happening
- The passenger information system tells riders how long to wait
- The performance reporting system tells managers what went wrong last month

None of these systems talk to each other in real time. None of them tell a dispatcher
what to *do*. The dispatcher is expected to watch a screen full of dots, notice a
problem forming, and figure out the intervention on their own — under time pressure,
with incomplete context, while also managing radio traffic.

The result is predictable: interventions happen late, or not at all, and riders pay
the cost.

---

## What Bridge Is

Bridge is a real-time dispatch assistant. It connects the data that already exists,
runs it through operational logic that any experienced dispatcher would recognize,
and surfaces specific, actionable recommendations — not status indicators.

The difference matters. A red dot on a map tells you something is wrong.
Bridge tells you:

> **Hold vehicle 4521 at King & Spadina for 90 seconds.** It is closing on 4388 at
> 1 stop and will bunch in approximately 60 seconds. Holding now restores a 4-stop
> headway across the route.

or:

> **Lawrence East corridor — convert express vehicle 9042 to local service for this
> trip.** The 54-local has a 12-stop gap (≈18 min rider wait) and vehicle 9042 is
> inside that gap. Serving local stops reduces wait to ≈9 min. Express headway
> impact: +4 min on 954.

A dispatcher reading that has everything they need to make a decision in five seconds.
They approve it or dismiss it. If they approve, the instruction goes to the operator.

---

## Core Principles

**Prescribe, don't describe.**
The system should tell dispatchers what to do, not just what's wrong. Colours and
counts are useful for situational awareness. They are not useful for decision-making
under time pressure.

**The data already exists.**
Bridge does not require new infrastructure, new sensors, or new data collection.
Every TTC bus and streetcar publishes a GTFS-Realtime feed with position, stop
sequence, heading, and trip data. The schedule is public. The stop locations are
public. The corridors are public. The problem has always been the join, not the data.

**Human decision, machine thinking.**
Bridge recommends. Dispatchers decide. Operators execute. The algorithm handles the
pattern recognition and arithmetic — things computers are good at. The dispatcher
handles context the algorithm can't know: is that operator dealing with a medical
emergency on board, is that intersection blocked by a film shoot, is that vehicle
about to go out of service. The final call is always human.

**Respect operational constraints.**
Every agency has policies, contracts, and procedures that constrain what interventions
are possible. Bridge has a first-class policy layer: agencies configure which
recommendation types are enabled, at what severity thresholds, on which routes.
A recommendation that violates an operator contract should never appear on screen,
not be shown and then ignored.

**One channel, not many.**
Bridge is not trying to replace CAD, replace scheduling software, or become a new
platform. It sits alongside existing systems and produces one thing: a prioritized
list of specific actions, right now, ranked by urgency. It plugs into whatever
communication channel the agency already uses to reach operators.

---

## Where Bridge Is Going

The immediate goal is to close the loop between detection and instruction:

1. Dispatcher sees a recommendation in Bridge
2. Dispatcher approves it with one tap
3. Bridge generates a structured instruction (`vehicle + action + location + timing`)
4. Instruction posts to the agency's existing system (MDT, driver app, radio queue)
5. Operator receives a clear, specific message: *"Hold at next stop. Wait for release."*
6. Bridge tracks whether the vehicle moved, confirms or escalates

Beyond that, the vision is a system that gets better over time. Every recommendation
that was accepted or dismissed, every intervention that worked or didn't — that's
training data for a system that learns what actually improves service on a specific
route, at a specific time of day, under specific conditions.

The long-term goal is not to automate dispatch. It is to make every dispatcher as
effective as the best dispatcher on the best day — without burning them out doing
mental arithmetic while managing a radio.
