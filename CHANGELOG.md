# Changelog

## [Unreleased]

### Added
- TypeScript migration: `src/types.ts`, `src/analysis.ts`, `src/server.ts`
- `tsconfig.json` (ES2020, strict, commonjs)
- `src/__tests__/analysis.test.ts` — Jest/ts-jest test suite for `getDistance` and `detectBunching`
- `jest.config.js` with ts-jest preset
- `Dockerfile` (node:20-alpine, multi-step build)
- `.env.example` with `PORT` and `POLL_INTERVAL_MS`
- `README.md` — project overview, run instructions, data source, Docker usage
- `PORT` and `POLL_INTERVAL_MS` now read from environment variables (defaults: 3000, 10000)
- `detectBunching` extracted to `src/analysis.ts` alongside `getDistance`

### Changed
- Replaced defunct NextBus XML API with TTC GTFS-Realtime vehicle positions feed (`https://bustime.ttc.ca/gtfsrt/vehicles`)
- Removed `node-fetch` and `fast-xml-parser` dependencies (native fetch + protobuf decode via `gtfs-realtime-bindings`)
- Route initialization no longer fetches geometry from NextBus — paths/stops to be populated from static GTFS in a future pass
- Expanded `ROUTE_META` to cover all TTC streetcar routes (501, 504–506, 509–512)
- Conflict zone radii corrected from degree values to metres
- `package.json` scripts updated: `start`, `dev`, `build`, `test`

### Removed
- NextBus `routeConfig` and `vehicleLocations` API calls
- `/api/config/routes` endpoint (was proxying NextBus route list)
- `routeConfig.xml` — obsolete NextBus geometry cache

---

## [0.1.0] — 2026-03-22

- Initial prototype: NextBus-based vehicle polling for TTC routes 510, 504, 501
- Bunching detection (N² same-direction proximity check, < 150m threshold)
- Leaflet map with dark CartoDB tiles, LERP-animated vehicle markers
- Conflict zone overlays (Spadina & Queen, King & Spadina, Union Station Loop)
- Sidebar dashboard with active vehicle count, alert count, incident feed
