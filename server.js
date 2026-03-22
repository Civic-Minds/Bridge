const express = require('express');
const fetch = require('node-fetch');
const { XMLParser } = require('fast-xml-parser');
const cors = require('cors');
const fs = require('fs');

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configuration - Now supporting multiple routes
let CONFIG = {
    agency: process.env.AGENCY || 'ttc',
    // Default to Toronto's busiest streetcar lines: 510 (Spadina), 504 (King), 501 (Queen)
    routes: ['510', '504', '501'],
    pollInterval: 10000,
};

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: ""
});

// State Container
// Structure: { [routeTag]: { title, stops: [], paths: [], vehicles: [], predictions: [], lastUpdated, metrics: {} } }
let systemState = {};

// Conflict Zones / Intersections (Global for now, could be per-route or geo-fenced later)
let CONFLICT_ZONES = [
    { id: 'zone_spadina_queen', name: 'Spadina & Queen', lat: 43.6482, lon: -79.3962, radius: 0.0006 },
    { id: 'zone_king_spadina', name: 'King & Spadina', lat: 43.6457, lon: -79.3952, radius: 0.0006 },
    { id: 'zone_union', name: 'Union Station Loop', lat: 43.6456, lon: -79.3800, radius: 0.0020 }
];

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const delPhi = (lat2 - lat1) * Math.PI / 180;
    const delLambda = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(delPhi / 2) * Math.sin(delPhi / 2) +
        Math.cos(phi1) * Math.cos(phi2) *
        Math.sin(delLambda / 2) * Math.sin(delLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// Initialize a single route
async function initRoute(routeTag) {
    console.log(`[Init] Fetching config for Route: ${routeTag}`);
    try {
        const url = `https://webservices.nextbus.com/service/publicXMLFeed?command=routeConfig&a=${CONFIG.agency}&r=${routeTag}`;
        const res = await fetch(url);
        const xml = await res.text();
        const data = parser.parse(xml);

        if (!data.body.route) {
            console.error(`[Init] Failed to load route ${routeTag}`);
            return;
        }

        const routeData = data.body.route;

        // Parse Stops
        const stops = Array.isArray(routeData.stop) ? routeData.stop : [routeData.stop];
        const parsedStops = stops.map(s => ({
            id: s.tag,
            title: s.title,
            lat: parseFloat(s.lat),
            lon: parseFloat(s.lon),
            stopId: s.stopId
        }));

        // Parse Paths (Polylines)
        // The XML returns <path> elements containing <point> elements
        let paths = [];
        if (routeData.path) {
            const rawPaths = Array.isArray(routeData.path) ? routeData.path : [routeData.path];
            paths = rawPaths.map(p => {
                const points = Array.isArray(p.point) ? p.point : [p.point];
                return points.map(pt => ({ lat: parseFloat(pt.lat), lon: parseFloat(pt.lon) }));
            });
        }

        // Initialize State for this route
        systemState[routeTag] = {
            tag: routeTag,
            title: routeData.title,
            color: routeData.color ? `#${routeData.color}` : '#00f2ff',
            oppositeColor: routeData.oppositeColor ? `#${routeData.oppositeColor}` : '#ffffff',
            bbox: { latMin: parseFloat(routeData.latMin), latMax: parseFloat(routeData.latMax), lonMin: parseFloat(routeData.lonMin), lonMax: parseFloat(routeData.lonMax) },
            stops: parsedStops,
            paths: paths,
            vehicles: [],
            metrics: { activeCount: 0, bunching: 0, gaps: 0 },
            lastUpdated: null
        };

        console.log(`[Init] Route ${routeTag} ready with ${parsedStops.length} stops and ${paths.length} path segments.`);

    } catch (e) {
        console.error(`[Init] Error initializing ${routeTag}:`, e.message);
    }
}

async function initSystem() {
    console.log("Initializing System...");
    systemState = {}; // Reset
    const promises = CONFIG.routes.map(r => initRoute(r));
    await Promise.all(promises);
    console.log("System Initialization Complete.");
    poll(); // Start polling immediately
}

async function poll() {
    const now = Date.now();

    // We can fetch vehicle locations for ALL routes in one specific command if we wanted to be clever,
    // but the NextBus API traditionally takes one route at a time for 'vehicleLocations' or we can pass 't=0' to get all since time 0?
    // Actually, command=vehicleLocations&a=<agency>&r=<route>&t=0 is the standard.
    // To support multi-route parallel fetching:

    for (const routeTag of CONFIG.routes) {
        if (!systemState[routeTag]) continue; // Skip if not initialized

        try {
            const url = `https://webservices.nextbus.com/service/publicXMLFeed?command=vehicleLocations&a=${CONFIG.agency}&r=${routeTag}&t=0`;
            const response = await fetch(url);
            const xmlData = await response.text();
            const jsonObj = parser.parse(xmlData);

            const vehicleData = jsonObj.body.vehicle;
            const rawVehicles = vehicleData ? (Array.isArray(vehicleData) ? vehicleData : [vehicleData]) : [];

            // Process Vehicles
            const processedVehicles = rawVehicles.map(v => {
                const speed = parseInt(v.speedKmHr) || 0;
                return {
                    id: v.id,
                    routeTag: routeTag,
                    lat: parseFloat(v.lat),
                    lon: parseFloat(v.lon),
                    speed: speed,
                    heading: parseInt(v.heading) || 0,
                    dirTag: v.dirTag,
                    secsSinceReport: parseInt(v.secsSinceReport) || 0,
                    isStalled: speed === 0
                };
            });

            // Calculate Metrics
            let bunchingCount = 0;
            // Simple N^2 bunching check
            for (let i = 0; i < processedVehicles.length; i++) {
                for (let j = i + 1; j < processedVehicles.length; j++) {
                    const v1 = processedVehicles[i];
                    const v2 = processedVehicles[j];
                    // If same direction and very close (< 150m)
                    if (v1.dirTag && v2.dirTag && v1.dirTag === v2.dirTag) {
                        const dist = getDistance(v1.lat, v1.lon, v2.lat, v2.lon);
                        if (dist < 150) bunchingCount++;
                    }
                }
            }

            // Update State
            systemState[routeTag].vehicles = processedVehicles;
            systemState[routeTag].metrics = {
                activeCount: processedVehicles.length,
                bunching: bunchingCount,
                slow: processedVehicles.filter(v => v.speed < 5 && v.speed > 0).length
            };
            systemState[routeTag].lastUpdated = now;

        } catch (error) {
            console.error(`[Poll] Error for route ${routeTag}:`, error.message);
        }
    }
}

// Start the loop
let pollIntervalId = setInterval(poll, CONFIG.pollInterval);
initSystem();

// --- API Endpoints ---

app.get('/api/state', (req, res) => {
    res.json({
        agency: CONFIG.agency,
        timestamp: Date.now(),
        routes: systemState,
        zones: CONFLICT_ZONES
    });
});

app.get('/api/config/routes', async (req, res) => {
    try {
        const url = `https://webservices.nextbus.com/service/publicXMLFeed?command=routeList&a=${CONFIG.agency}`;
        const response = await fetch(url);
        const xml = await response.text();
        const data = parser.parse(xml);
        const routes = Array.isArray(data.body.route) ? data.body.route : [data.body.route];
        res.json(routes.map(r => ({ tag: r.tag, title: r.title })));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/config/active-routes', async (req, res) => {
    const { routes } = req.body; // Expects { routes: ['510', '504'] }
    if (!routes || !Array.isArray(routes)) return res.status(400).json({ error: "Invalid routes array" });

    console.log("Updating active routes to:", routes);
    CONFIG.routes = routes;

    clearInterval(pollIntervalId);
    await initSystem();
    pollIntervalId = setInterval(poll, CONFIG.pollInterval);

    res.json({ success: true, activeRoutes: CONFIG.routes });
});

app.listen(port, () => console.log(`Bridge Command Center running at http://localhost:${port}`));
