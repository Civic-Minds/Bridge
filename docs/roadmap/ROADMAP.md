# Roadmap

Bridge is a real-time dispatch assistant for transit operations. The roadmap moves
from a live TTC prototype to a safe, measurable operational pilot, then toward a
broader operational intelligence layer.

- **[Product](./PRODUCT.md)**: Dispatcher workflow, pilot scope, and user-facing capabilities.
- **[Technical](./TECHNICAL.md)**: Engineering backlog for the live pipeline and analysis engine.
- **[Operations](./OPERATIONS.md)**: Validation, deployment, agency integration, and rollout gates.
- **[Decisions](../DECISIONS.md)**: Durable product and architecture choices.

## Delivery sequence

1. **Validate the live pipeline** — replay GTFS-Realtime data, test feed failure
   modes, and measure recommendation quality.
2. **Run a read-only TTC pilot** — monitor a defined route set and compare Bridge’s
   alerts with observed service without sending operator instructions.
3. **Complete the operational loop** — add authenticated approvals, durable audit
   events, reliable webhook delivery, and outcome evaluation.
4. **Integrate shared context** — consume Atlas geometry, corridors, archived
   positions, and historical baselines where they improve decisions.
5. **Expand carefully** — add agencies, buses, and agency-system integrations only
   after the single-agency workflow is demonstrably reliable.

[Back to project home](../../README.md)
