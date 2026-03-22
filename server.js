const express = require('express');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const cors = require('cors');

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const TTC_VEHICLE_POSITIONS_URL = 'https://bustime.ttc.ca/gtfsrt/vehicles';

let CONFIG = {
    routes: ['510', '504', '501'],
    pollInterval: 10000,
};

// Display metadata for known TTC surface routes
const ROUTE_META = {
    '501': { title: '501-Queen',        color: '#ff69b4' },
    '504': { title: '504-King',         color: '#ffaa00' },
    '505': { title: '505-Dundas',       color: '#a855f7' },
    '506': { title: '506-Carlton',      color: '#22d3ee' },
    '509': { title: '509-Harbourfront', color: '#34d399' },
    '510': { title: '510-Spadina',      color: '#ff0000' },
    '511': { title: '511-Bathurst',     color: '#60a5fa' },
    '512': { title: '512-St Clair',     color: '#f97316' },
};

const CONFLICT_ZONES = [
    { id: 'zone_spadina_queen', name: 'Spadina & Queen',    lat: 43.6482, lon: -79.3962, radius: 60 },
    { id: 'zone_king_spadina',  name: 'King & Spadina',     lat: 43.6457, lon: -79.3952, radius: 60 },
    { id: 'zone_union',         name: 'Union Station Loop', lat: 43.6456, lon: -79.3800, radius: 200 },
];

// State: { [routeTag]: { tag, title, color, stops, paths, vehicles, metrics, lastUpdated } }
let systemState = {};

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const dPhi = (lat2 - lat1) * Math.PI / 180;
    const dLambda = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function initRoutes() {
    systemState = {};
    for (const tag of CONFIG.routes) {
        const meta = ROUTE_META[tag] || { title: `Route ${tag}`, color: '#00f2ff' };
        systemState[tag] = {
            tag,
            title: meta.title,
            color: meta.color,
            stops: [],
            paths: [],  // Route geometry — to be populated from static GTFS
            vehicles: [],
            metrics: { activeCount: 0, bunching: 0, slow: 0 },
            lastUpdated: null,
        };
    }
    console.log(`[Init] Routes initialized: ${CONFIG.routes.join(', ')}`);
}

async function poll() {
    try {
        const res = await fetch(TTC_VEHICLE_POSITIONS_URL);
        if (!res.ok) throw new Error(`GTFS-RT fetch failed: ${res.status}`);

        const buffer = await res.arrayBuffer();
        const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));

        // Bucket vehicles by route
        const byRoute = {};
        for (const tag of CONFIG.routes) byRoute[tag] = [];

        for (const entity of feed.entity) {
            const v = entity.vehicle;
            if (!v?.position) continue;

            const routeId = v.trip?.routeId;
            if (!routeId || !byRoute[routeId]) continue;

            byRoute[routeId].push({
                id: v.vehicle?.id || entity.id,
                routeTag: routeId,
                lat: v.position.latitude,
                lon: v.position.longitude,
                speed: v.position.speed ?? 0,
                heading: v.position.bearing ?? 0,
                dirTag: v.trip?.directionId?.toString() ?? '',
                isStalled: (v.position.speed ?? 0) === 0,
            });
        }

        const now = Date.now();
        let totalVehicles = 0;

        for (const tag of CONFIG.routes) {
            if (!systemState[tag]) continue;
            const vehicles = byRoute[tag];

            // Bunching detection: same direction, < 150m apart
            let bunchingCount = 0;
            for (let i = 0; i < vehicles.length; i++) {
                for (let j = i + 1; j < vehicles.length; j++) {
                    const v1 = vehicles[i], v2 = vehicles[j];
                    if (v1.dirTag && v2.dirTag && v1.dirTag === v2.dirTag) {
                        if (getDistance(v1.lat, v1.lon, v2.lat, v2.lon) < 150) bunchingCount++;
                    }
                }
            }

            systemState[tag].vehicles = vehicles;
            systemState[tag].metrics = {
                activeCount: vehicles.length,
                bunching: bunchingCount,
                slow: vehicles.filter(v => v.speed > 0 && v.speed < 5).length,
            };
            systemState[tag].lastUpdated = now;
            totalVehicles += vehicles.length;
        }

        console.log(`[Poll] ${new Date().toLocaleTimeString()} — ${totalVehicles} vehicles across ${CONFIG.routes.length} routes`);

    } catch (err) {
        console.error('[Poll] Error:', err.message);
    }
}

initRoutes();
poll();
setInterval(poll, CONFIG.pollInterval);

// --- API ---

app.get('/api/state', (req, res) => {
    res.json({ agency: 'ttc', timestamp: Date.now(), routes: systemState, zones: CONFLICT_ZONES });
});

app.post('/api/config/active-routes', (req, res) => {
    const { routes } = req.body;
    if (!routes || !Array.isArray(routes)) return res.status(400).json({ error: 'Invalid routes array' });
    CONFIG.routes = routes;
    initRoutes();
    res.json({ success: true, activeRoutes: CONFIG.routes });
});

app.listen(port, () => console.log(`Bridge running at http://localhost:${port}`));
