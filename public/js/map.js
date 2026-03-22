// Map Module
import * as Utils from './utils.js';

let map;
let layers = {
    vehicles: L.layerGroup(),
    paths: L.layerGroup(),
    stops: L.layerGroup(),
    zones: L.layerGroup()
};

// Vehicle Markers Cache: { [id]: { marker, lastLat, lastLon, lastHeading, targetLat, targetLon, lastUpdate, speed } }
let vehicleCache = {};

export function initMap(elementId) {
    map = L.map(elementId, {
        zoomControl: false,
        attributionControl: false
    }).setView([43.6532, -79.3832], 13);

    // Dark matter style
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        subdomains: 'abcd',
        maxZoom: 19
    }).addTo(map);

    layers.paths.addTo(map);
    layers.zones.addTo(map);
    layers.stops.addTo(map);
    layers.vehicles.addTo(map); // Vehicles on top

    return map;
}

export function updateMapState(state) {
    if (!map) return;

    // 1. Update Routes (Paths)
    // We only redraw paths if they differ or clean start. 
    // For prototype simplicity, we clear and redraw paths occasionally or verify overlap?
    // Let's just clear and redraw paths on a "config change" but for now we might just do it if layer is empty.

    if (layers.paths.getLayers().length === 0) {
        Object.values(state.routes).forEach(route => {
            // Route polylines
            if (route.paths && route.paths.length > 0) {
                route.paths.forEach(path => {
                    L.polyline(path, {
                        color: route.color || '#00f2ff',
                        weight: 3,
                        opacity: 0.6,
                        smoothFactor: 1
                    }).addTo(layers.paths);
                });
            }

            // Stop markers — small circles, tooltip on hover
            if (route.stops && route.stops.length > 0) {
                route.stops.forEach(stop => {
                    L.circleMarker([stop.lat, stop.lon], {
                        radius: 3,
                        color: route.color || '#00f2ff',
                        fillColor: '#1a1a2e',
                        fillOpacity: 1,
                        weight: 1.5,
                        opacity: 0.7,
                    })
                    .bindTooltip(stop.name, { permanent: false, direction: 'top', className: 'stop-tooltip' })
                    .addTo(layers.stops);
                });
            }
        });

        // Render Conflict Zones
        state.zones.forEach(zone => {
            L.circle([zone.lat, zone.lon], {
                color: '#ff3e3e',
                fillColor: '#ff3e3e',
                fillOpacity: 0.1,
                radius: 60
            }).addTo(layers.zones);
        });
    }

    // 2. Update Vehicles
    const activeIds = new Set();
    const now = Date.now();

    Object.values(state.routes).forEach(route => {
        route.vehicles.forEach(v => {
            activeIds.add(v.id);

            if (!vehicleCache[v.id]) {
                // New Vehicle
                const icon = createVehicleIcon(v.heading, route.color);
                const marker = L.marker([v.lat, v.lon], { icon }).addTo(layers.vehicles);

                vehicleCache[v.id] = {
                    marker: marker,
                    currentLat: v.lat,
                    currentLon: v.lon,
                    targetLat: v.lat,
                    targetLon: v.lon,
                    currentHeading: v.heading,
                    lastUpdate: now
                };
            } else {
                // Update Existing
                const cache = vehicleCache[v.id];
                cache.targetLat = v.lat;
                cache.targetLon = v.lon;
                // If heading changed significantly, update icon
                if (Math.abs(cache.currentHeading - v.heading) > 10) {
                    cache.currentHeading = v.heading;
                    cache.marker.setIcon(createVehicleIcon(v.heading, route.color));
                }
                cache.lastUpdate = now;
            }
        });
    });

    // Remove stale vehicles
    Object.keys(vehicleCache).forEach(id => {
        if (!activeIds.has(Number(id)) && !activeIds.has(String(id))) {
            layers.vehicles.removeLayer(vehicleCache[id].marker);
            delete vehicleCache[id];
        }
    });

    // Auto-center map on first significant load if zoom is worldly
    if (map.getZoom() < 5 && activeIds.size > 0) {
        const first = Object.values(vehicleCache)[0];
        map.setView([first.targetLat, first.targetLon], 13);
    }
}

// Animation Loop for Smoothing
export function startAnimationLoop() {
    function animate() {
        // Interpolate all vehicles towards target
        // Basic Linear Interpolation (LERP) 
        // We assume updates come every ~10s. We want to move 10% of the way each frame? 
        // Better: standard LERP factor.

        const lerpFactor = 0.05;

        Object.values(vehicleCache).forEach(v => {
            const latDiff = v.targetLat - v.currentLat;
            const lonDiff = v.targetLon - v.currentLon;

            if (Math.abs(latDiff) > 0.00001 || Math.abs(lonDiff) > 0.00001) {
                v.currentLat += latDiff * lerpFactor;
                v.currentLon += lonDiff * lerpFactor;
                v.marker.setLatLng([v.currentLat, v.currentLon]);
            }
        });

        requestAnimationFrame(animate);
    }
    animate();
}

function createVehicleIcon(heading, color) {
    return L.divIcon({
        className: 'vehicle-marker-container',
        html: `<div class="vehicle-marker" style="transform: rotate(${heading}deg); border-bottom-color: ${color}"></div>`,
        iconSize: [20, 20],
        iconAnchor: [10, 10]
    });
}
