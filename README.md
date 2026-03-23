# Bridge

Real-time TTC bunching detection and dispatch action engine for Toronto streetcar routes.

## Problem

TTC dispatchers have no unified tool to detect bunching in real time and receive actionable recommendations. Existing monitoring is reactive — operators see problems but have no guidance on what to do. Bridge bridges this gap by turning live GTFS-RT data into a closed-loop system that detects anomalies, scores severity, and generates specific dispatch instructions.

## Features

- **Live Bunching Detection**: Polls TTC GTFS-RT every 10 seconds, detects bunching, closing pairs, large gaps, and dwell anomalies across all active streetcar routes.
- **Dispatch Action Engine**: Generates specific instructions — HOLD, RELEASE_EARLY, SHORT_TURN, CONVERT_TO_EXPRESS, CONVERT_TO_LOCAL — with calculated hold times, projected headways, and plain-language reasoning.
- **Route Ladder View**: SKATE-style linear dispatcher view with vehicles positioned by stop sequence and colour-coded by anomaly state.
- **Policy Layer**: Agency-configurable constraint system — disable action types, set severity thresholds, and document operating constraints per route.
- **Cross-Route Recommendations**: Detects local/express corridor proximity and suggests service substitutions across 16 TTC route pairs.

## Stack

- **Backend**: Node.js, TypeScript, Express
- **Frontend**: Leaflet, Vanilla JS
- **Data**: TTC GTFS-RT (vehicle positions + trip updates)
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

TTC GTFS-Realtime vehicle positions: `https://bustime.ttc.ca/gtfsrt/vehicles`

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

In development. Route geometry (path rendering on the map) will be populated from static GTFS in a future pass. Vehicle markers are positioned live; route lines are not yet drawn.

---

- [Roadmap](./ROADMAP.md)
- [Changelog](./CHANGELOG.md)
- [Security](./SECURITY.md)

Created by Civic Minds
