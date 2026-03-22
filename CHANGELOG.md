# Changelog

## [Unreleased]

### Changed
- Replaced defunct NextBus XML API with TTC GTFS-Realtime vehicle positions feed (`https://bustime.ttc.ca/gtfsrt/vehicles`)
- Removed `node-fetch` and `fast-xml-parser` dependencies (native fetch + protobuf decode via `gtfs-realtime-bindings`)
- Route initialization no longer fetches geometry from NextBus — paths/stops to be populated from static GTFS in a future pass
- Expanded `ROUTE_META` to cover all TTC streetcar routes (501, 504–506, 509–512)
- Conflict zone radii corrected from degree values to metres

### Removed
- NextBus `routeConfig` and `vehicleLocations` API calls
- `/api/config/routes` endpoint (was proxying NextBus route list)

---

## [0.1.0] — 2026-03-22

- Initial prototype: NextBus-based vehicle polling for TTC routes 510, 504, 501
- Bunching detection (N² same-direction proximity check, < 150m threshold)
- Leaflet map with dark CartoDB tiles, LERP-animated vehicle markers
- Conflict zone overlays (Spadina & Queen, King & Spadina, Union Station Loop)
- Sidebar dashboard with active vehicle count, alert count, incident feed
