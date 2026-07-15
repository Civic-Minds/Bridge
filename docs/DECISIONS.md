# Product Decisions

This document records durable product and architecture decisions for Bridge. It
is not a running task list.

## 2026-07-15 — Bridge remains the product and repository name

The local project directory is `Dispatch`, but the product and GitHub repository
remain **Bridge** (`Civic-Minds/Bridge`). “Dispatch” describes the operational
domain and can be used for UI sections or future modules without renaming the
project again.

## 2026-07-15 — Start with a TTC surface-route pilot

The first operational pilot targets TTC surface routes, beginning with 501, 504,
and 510. The analysis pipeline should remain agency-agnostic, but multi-agency
configuration is deferred until the single-agency workflow is trustworthy.

## 2026-07-15 — Human approval is mandatory

Bridge recommends actions; it does not autonomously instruct operators. Every
operator-facing instruction requires an identified dispatcher or supervisor to
approve it. Automated delivery may follow approval, but it may not bypass it.

## 2026-07-15 — Atlas supplies shared context; Bridge owns dispatch operations

Atlas is the platform for reusable transit-data capabilities: feed configuration,
GTFS/GTFS-RT normalization, static geometry, stop structure, live snapshots,
historical positions, replay access, and baseline context. Bridge consumes those
contracts.

Bridge owns dispatch-specific operations: bunching/gap analysis, recommendations,
approvals, instruction delivery, and outcome tracking. If Bridge needs a new data
primitive, it should be proposed for Atlas when it benefits multiple tools; a
dispatch-specific projection belongs in Bridge.

## 2026-07-15 — Replay validation precedes agency integration

Changes to polling or recommendation logic must be testable against recorded
GTFS-Realtime data before they are trusted in a live operational workflow. The
first deployment milestone is read-only monitoring and evaluation; connecting an
agency’s operator or CAD channel comes later.

## 2026-07-15 — Webhooks complement, not replace, agency systems

Bridge’s outbound webhook is an integration boundary for approved instructions,
not a replacement for CAD, radio dispatch, scheduling, or operator management
systems. Delivery status, retries, and auditability are required before treating
the integration as operationally dependable.
