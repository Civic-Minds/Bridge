// UI Module
import * as API from './api.js';

let dom = {
    incidentFeed: null,
    statActive: null,
    statAlerts: null,
    lastUpdated: null,
    routeList: null,
    settingsModal: null
};

export function initUI() {
    dom.incidentFeed = document.getElementById('incident-log');
    dom.statActive = document.getElementById('stat-count');
    dom.statAlerts = document.getElementById('stat-alerts');
    dom.lastUpdated = document.getElementById('last-updated');
    dom.routeList = document.getElementById('route-list-container');
    dom.settingsModal = document.getElementById('settings-overlay');

    // Attach global event listeners if needed
    window.toggleSettings = toggleSettings;
    window.saveConfig = saveConfig;
}

export function updateDashboard(state) {
    if (!state || !state.routes) return;

    const routes = Object.values(state.routes);

    // Aggregates
    let totalVehicles = 0;
    let totalAlerts = 0;

    routes.forEach(r => {
        totalVehicles += r.metrics.activeCount || 0;
        totalAlerts += (r.metrics.bunching || 0) + (r.metrics.slow || 0);
    });

    dom.statActive.innerText = totalVehicles;
    dom.statAlerts.innerText = totalAlerts;
    dom.lastUpdated.innerText = `SYNC: ${new Date(state.timestamp).toLocaleTimeString()}`;

    // Update Route List
    renderRouteList(routes);

    // Update Incident Feed
    renderIncidents(routes);
}

function renderRouteList(routes) {
    // Simple diffing: if count matches and content roughly same, skip? 
    // For now, simple re-render is fine for < 10 items.

    dom.routeList.innerHTML = routes.map(r => `
        <div class="route-item" style="border-left: 3px solid ${r.color}">
            <div class="route-header">
                <span class="route-tag">${r.tag}</span>
                <span class="route-name">${r.title.split('-')[1] || r.title}</span>
            </div>
            <div class="route-stats">
                <span>${r.metrics.activeCount} Buses</span>
                ${r.metrics.bunching > 0 ? `<span class="badge-danger">${r.metrics.bunching} Bunching</span>` : ''}
            </div>
        </div>
    `).join('');
}

function renderIncidents(routes) {
    // Generate incidents from state
    let incidents = [];
    routes.forEach(r => {
        if (r.metrics.bunching > 0) {
            incidents.push({ type: 'danger', msg: `Route ${r.tag}: Bunching Detected`, time: r.lastUpdated });
        }
        if (r.metrics.slow > 5) {
            incidents.push({ type: 'warning', msg: `Route ${r.tag}: High Congestion`, time: r.lastUpdated });
        }
    });

    // We don't want to clear the log every time, just prepend new unique ones? 
    // For this prototype, we'll just show the *current* active alerts as a list.

    if (incidents.length === 0) {
        dom.incidentFeed.innerHTML = '<div class="log-item dim">System Nominal.</div>';
    } else {
        dom.incidentFeed.innerHTML = incidents.map(i => `
            <div class="log-item ${i.type}">
                <span class="log-time">${new Date(i.time).toLocaleTimeString().split(' ')[0]}</span>
                <span>${i.msg}</span>
            </div>
        `).join('');
    }
}

// Settings Logic
export function toggleSettings(show) {
    dom.settingsModal.style.display = show ? 'flex' : 'none';
    if (show) loadRouteConfig();
}

async function loadRouteConfig() {
    const allRoutes = await API.fetchAvailableRoutes();
    // In a real app we'd check which are active.
    // For now just list them in a multi-select or something.
    // We will just let user type tags for this "Dev Mode" version:
    // ... Or we can simplify and not implement full config UI for this step, 
    // relying on the text input in the original design but updated for array.
}

async function saveConfig() {
    const input = document.getElementById('routes-input').value;
    const routes = input.split(',').map(s => s.trim()).filter(s => s);
    await API.updateActiveRoutes(routes);
    toggleSettings(false);
    // Reload page to flush? Or just let state update handle it. 
    // State update handles it, but we might want to clear map layers.
    window.location.reload();
}
