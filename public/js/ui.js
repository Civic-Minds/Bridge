// UI Module
import * as API from './api.js';

let dom = {
    incidentFeed: null,
    statActive: null,
    statBunching: null,
    statGaps: null,
    lastUpdated: null,
    routeList: null,
    settingsModal: null,
};

export function initUI() {
    dom.incidentFeed  = document.getElementById('incident-log');
    dom.statActive    = document.getElementById('stat-count');
    dom.statBunching  = document.getElementById('stat-bunching');
    dom.statGaps      = document.getElementById('stat-gaps');
    dom.lastUpdated   = document.getElementById('last-updated');
    dom.routeList     = document.getElementById('route-list-container');
    dom.settingsModal = document.getElementById('settings-overlay');

    window.toggleSettings = toggleSettings;
    window.saveConfig = saveConfig;
}

export function updateDashboard(state, recData) {
    if (!state || !state.routes) return;

    const routes = Object.values(state.routes);

    let totalVehicles = 0;
    let totalBunching = 0;
    let totalGaps = 0;

    routes.forEach(r => {
        totalVehicles += r.metrics.activeCount || 0;
        totalBunching += r.metrics.bunchingPairs || 0;
        totalGaps     += r.metrics.largeGaps || 0;
    });

    dom.statActive.innerText   = totalVehicles;
    dom.statBunching.innerText = totalBunching;
    dom.statGaps.innerText     = totalGaps;
    dom.lastUpdated.innerText  = `SYNC: ${new Date(state.timestamp).toLocaleTimeString()}`;

    renderRouteList(routes);
    renderIncidents(routes);
}

function renderRouteList(routes) {
    dom.routeList.innerHTML = routes.map(r => {
        const deviationCount = (r.vehicles ?? []).filter(v =>
            v.analysis?.anomalies?.includes('late') || v.analysis?.anomalies?.includes('early')
        ).length;

        return `<div class="route-item" style="border-left: 3px solid ${r.color}">
            <div>
                <span class="route-tag">${r.tag}</span>
                <span class="route-name">${r.title.split('-')[1] || r.title}</span>
            </div>
            <div class="route-stats">
                <span>${r.metrics.activeCount} veh</span>
                ${r.metrics.bunchingPairs > 0 ? `<span class="badge-danger">${r.metrics.bunchingPairs} bunch</span>` : ''}
                ${r.metrics.largeGaps > 0 ? `<span class="badge-warning">${r.metrics.largeGaps} gap</span>` : ''}
                ${deviationCount > 0 ? `<span class="badge-warning">${deviationCount} off-sch</span>` : ''}
            </div>
        </div>`;
    }).join('');
}

function renderIncidents(routes) {
    let incidents = [];

    routes.forEach(r => {
        if (r.metrics.bunchingPairs > 0) {
            incidents.push({ type: 'danger', msg: `Route ${r.tag}: ${r.metrics.bunchingPairs} bunching pair${r.metrics.bunchingPairs > 1 ? 's' : ''}`, time: r.lastUpdated });
        }
        if (r.metrics.closingPairs > 0) {
            incidents.push({ type: 'warning', msg: `Route ${r.tag}: ${r.metrics.closingPairs} closing pair${r.metrics.closingPairs > 1 ? 's' : ''} (pre-bunch)`, time: r.lastUpdated });
        }
        if (r.metrics.largeGaps > 0) {
            incidents.push({ type: 'warning', msg: `Route ${r.tag}: ${r.metrics.largeGaps} large gap${r.metrics.largeGaps > 1 ? 's' : ''} (rider wait risk)`, time: r.lastUpdated });
        }
        if (r.metrics.dwellAnomalies > 0) {
            incidents.push({ type: 'warning', msg: `Route ${r.tag}: ${r.metrics.dwellAnomalies} vehicle${r.metrics.dwellAnomalies > 1 ? 's' : ''} stalled ≥30s`, time: r.lastUpdated });
        }

        // Schedule deviation summary
        const lateCount  = (r.vehicles ?? []).filter(v => v.analysis?.anomalies?.includes('late')).length;
        const earlyCount = (r.vehicles ?? []).filter(v => v.analysis?.anomalies?.includes('early')).length;
        if (lateCount > 0)  incidents.push({ type: 'warning', msg: `Route ${r.tag}: ${lateCount} vehicle${lateCount > 1 ? 's' : ''} running late`, time: r.lastUpdated });
        if (earlyCount > 0) incidents.push({ type: 'warning', msg: `Route ${r.tag}: ${earlyCount} vehicle${earlyCount > 1 ? 's' : ''} running early`, time: r.lastUpdated });
    });

    if (incidents.length === 0) {
        dom.incidentFeed.innerHTML = '<div class="log-item dim">System Nominal.</div>';
    } else {
        dom.incidentFeed.innerHTML = incidents.map(i => `
            <div class="log-item ${i.type}">
                <span class="log-time">${i.time ? new Date(i.time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'}) : '--:--'}</span>
                <span>${i.msg}</span>
            </div>
        `).join('');
    }
}

export function toggleSettings(show) {
    dom.settingsModal.style.display = show ? 'flex' : 'none';
}

export async function saveConfig() {
    const input = document.getElementById('routes-input').value;
    const routes = input.split(',').map(s => s.trim()).filter(s => s);
    await API.updateActiveRoutes(routes);
    toggleSettings(false);
    window.location.reload();
}
