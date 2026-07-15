# Bridge

Real-time TTC bunching detection and dispatch action engine for Toronto streetcar routes.

## Problem

TTC dispatchers have no unified tool to detect bunching in real time and receive actionable recommendations. Existing monitoring is reactive — operators see problems but have no guidance on what to do. Bridge bridges this gap by turning live GTFS-RT data into a closed-loop system that detects anomalies, scores severity, and generates specific dispatch instructions.

## Features

- **Live Bunching Detection**: Consumes Atlas live snapshots every 10 seconds, detecting bunching, closing pairs, large gaps, and dwell anomalies across active streetcar routes.
- **Dispatch Action Engine**: Generates specific instructions — HOLD, RELEASE_EARLY, SHORT_TURN, CONVERT_TO_EXPRESS, CONVERT_TO_LOCAL — with calculated hold times, projected headways, and plain-language reasoning.
- **Route Ladder View**: SKATE-style linear dispatcher view with vehicles positioned by stop sequence and colour-coded by anomaly state.
- **Policy Layer**: Agency-configurable constraint system — disable action types, set severity thresholds, and document operating constraints per route.
- **Cross-Route Recommendations**: Detects local/express corridor proximity and suggests service substitutions across 16 TTC route pairs.

## Stack

- **Backend**: Node.js, TypeScript, Express
- **Frontend**: Leaflet, Vanilla JS
- **Data**: Atlas versioned live snapshots and public static artifacts backed by R2
- **Testing**: Jest + ts-jest (41 tests)

---

## Running locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Copy `.env.example` to `.env` to override defaults:

```bash
cp .env.example .env
```

## Default routes

| Route | Name       |
|-------|------------|
| 510   | Spadina    |
| 504   | King       |
| 501   | Queen      |

Additional TTC streetcar routes (505, 506, 509, 511, 512) can be enabled via `POST /api/config/active-routes`.

## Data source

Bridge consumes the canary live-data contract from Atlas:

- Vehicle positions: `/api/live-snapshot?agency=ttc&feed=vehicles`
- Trip updates: `/api/live-snapshot?agency=ttc&feed=trips`

Atlas owns upstream GTFS processing, GTFS-Realtime feeds, and the R2 archive. Bridge
consumes Atlas's public route and stop artifacts for geometry, stop ordering, and
spacing calibration; dispatch analysis and policy remain Bridge-owned.

No API key required.

## Scripts

| Command         | Description                          |
|-----------------|--------------------------------------|
| `npm run dev`   | Run with ts-node (development)       |
| `npm run build` | Compile TypeScript to `dist/`        |
| `npm start`     | Run compiled output from `dist/`     |
| `npm test`      | Run Jest test suite                  |

## Docker

```bash
docker build -t bridge .
docker run -p 3000:3000 bridge
```

## Status

In development. Atlas-backed live snapshots and static route artifacts, stop markers, anomaly
detection, recommendation approval, SQLite history, SSE updates, and webhook
delivery are implemented. The next milestone is replay-based validation and a
read-only operational pilot; operator-system integration remains gated behind that
validation.

---

- [Roadmap](./docs/roadmap/ROADMAP.md)
- [Changelog](./CHANGELOG.md)
- [Security](./SECURITY.md)

Created by Civic Minds
