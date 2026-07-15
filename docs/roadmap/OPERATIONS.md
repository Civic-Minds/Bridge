# Operations Roadmap

The operational path from a working prototype to a system an agency could safely
evaluate.

## Readiness gates

1. **Pipeline verified**: live and replayed GTFS-Realtime feeds decode correctly,
   remain fresh, and fail visibly when unavailable.
2. **Recommendations evaluated**: alert frequency, persistence, and likely false
   positives are measured by route, direction, and time period.
3. **Read-only pilot**: Bridge monitors a defined TTC route set without sending
   operator instructions.
4. **Controlled integration**: approved instructions go to a test endpoint with
   authenticated users, retries, delivery status, and a complete audit trail.
5. **Agency review**: operating policies, escalation procedures, action constraints,
   and responsible supervisors are documented before live integration.

## Deployment stages

- **Development**: Atlas canary snapshots, local static GTFS during migration, and recorded fixtures.
- **Evaluation**: persistent history, replay reports, and read-only live monitoring.
- **Test integration**: signed webhook delivery to a non-operational endpoint.
- **Agency pilot**: human-approved instructions for a narrowly defined route set.
- **Expansion**: additional routes, agencies, action types, and integrations only
  after pilot evidence supports them.

## Required operational controls

- Authenticated dispatcher and supervisor identities.
- Durable recommendation, decision, delivery, and outcome events.
- Feed freshness and service-health alerts.
- Retry-safe instruction delivery with deduplication.
- Policy controls that suppress actions the agency does not permit.
- A clear manual fallback when Bridge or an upstream feed is unavailable.

[Back to Roadmap](./ROADMAP.md)
