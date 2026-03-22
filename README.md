# Bridge

Real-time TTC bunching detection and early warning for Toronto streetcar routes.

Bridge polls the TTC GTFS-Realtime vehicle positions feed, detects bunching (two vehicles running < 150m apart in the same direction), and serves a live Leaflet map with vehicle markers, conflict zone overlays, and a sidebar dashboard.

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
