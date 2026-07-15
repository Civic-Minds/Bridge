# Product Roadmap

The product roadmap for a dispatcher using Bridge during live service.

## Current surface

| Capability | Status | Question it answers |
|---|---|---|
| Live route monitoring | Live | Where are vehicles and how many are active? |
| Bunching and gap detection | Live | Which service problems are forming now? |
| Route ladder and map | Live | Where are vehicles positioned along the route? |
| Dispatch recommendations | Live prototype | What action could improve spacing? |
| Dispatcher approval and dismissal | Live prototype | Does the dispatcher accept this action? |
| Instruction webhook | Live prototype | How can an approved action reach an agency system? |
| Outcome tracking | Live prototype | Did the vehicle respond as expected? |

## Next product milestones

- [ ] **Read-only pilot surface**: make freshness, feed health, recommendation age,
  and evaluation status obvious to the dispatcher.
- [ ] **Recommendation detail**: show confidence, affected service area, expected
  rider impact, and the tradeoff created by each action.
- [ ] **Decision history**: let supervisors review approved, dismissed, expired,
  and completed recommendations with reasons.
- [ ] **Route and time filters**: focus the operational view on a route, direction,
  service period, or active incident.
- [ ] **Agency-configured workflows**: expose policy, action eligibility, and
  delivery channels without requiring code changes.

## Product boundary

Bridge is a dispatch assistant, not a CAD replacement, scheduling system, operator
management system, or passenger information system. See [Decisions](../DECISIONS.md)
for the human-approval and integration boundaries.

[Back to Roadmap](./ROADMAP.md)
