# Roadmap

Bridge is a real-time TTC bunching detection and dispatch action engine. This roadmap
outlines the path from the current live prototype to a safe, measurable operational
pilot and, later, a broader operational intelligence layer for transit agencies.

- **[Vision](docs/VISION.md)**: Why Bridge exists, the problem it's solving, the human-in-the-loop model, and long-term direction.
- **[Technical](docs/ROADMAP_TECHNICAL.md)**: Feature backlog organized by theme — dispatcher workflow, algorithm quality, static GTFS integration, multi-agency support, and infrastructure.
- **[Decisions](docs/DECISIONS.md)**: Durable product and architecture choices, including the human-approval boundary and Atlas integration model.

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

---

[Back to Home](./README.md)
