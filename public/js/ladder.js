// Route Ladder Module
// Renders a SKATE-style dispatcher view: vehicles positioned linearly along route,
// colored by schedule status, with gap indicators and actionable recommendations.

import * as API from './api.js';

let ladderContainer = null;
let recContainer = null;
let lastRecommendations = [];
let onDecisionCallback = null; // called after approve/dismiss so the parent can refresh recs

export function setDecisionCallback(fn) {
    onDecisionCallback = fn;
}

export function initLadder() {
    ladderContainer = document.getElementById('ladder-container');
    recContainer = document.getElementById('rec-container');
}

/**
 * Renders the route ladder view for all active routes.
 * Each route is a horizontal strip with vehicle chips positioned proportionally
 * by stopSequence, grouped by direction.
 */
export function renderLadder(state) {
    if (!ladderContainer || !state?.routes) return;

    const routes = Object.values(state.routes);
    if (routes.length === 0) {
        ladderContainer.innerHTML = '<div class="ladder-empty">No routes active.</div>';
        return;
    }

    ladderContainer.innerHTML = routes.map(route => renderRouteLadder(route)).join('');
}

function renderRouteLadder(route) {
    const vehicles = route.vehicles ?? [];
    if (vehicles.length === 0) {
        return `<div class="ladder-route">
            <div class="ladder-route-label" style="border-left:3px solid ${route.color}">${route.tag}</div>
            <div class="ladder-track-wrap"><span class="ladder-empty-msg">No vehicles reporting</span></div>
        </div>`;
    }

    // Split by inferred direction
    const dir0 = vehicles.filter(v => v.analysis.inferredDir === '0')
        .sort((a, b) => a.stopSequence - b.stopSequence);
    const dir1 = vehicles.filter(v => v.analysis.inferredDir === '1')
        .sort((a, b) => a.stopSequence - b.stopSequence);

    const allSeqs = vehicles.map(v => v.stopSequence).filter(s => s > 0);
    const minSeq = allSeqs.length > 0 ? Math.min(...allSeqs) : 0;
    const maxSeq = allSeqs.length > 0 ? Math.max(...allSeqs) : 1;
    const range = Math.max(maxSeq - minSeq, 1);

    function renderTrack(dirVehicles, dirLabel) {
        if (dirVehicles.length === 0) return '';
        const chips = dirVehicles.map(v => {
            const pct = ((v.stopSequence - minSeq) / range) * 90 + 2; // 2–92% range
            const chipClass = getChipClass(v);
            const devStr = formatDeviation(v.analysis.scheduleDeviation);
            const gapStr = v.analysis.gapAhead !== null ? `${v.analysis.gapAhead}↑` : '';
            const title = buildTooltip(v);
            return `<div class="ladder-chip ${chipClass}" style="left:${pct.toFixed(1)}%" title="${title}">
                <span class="chip-id">${v.id}</span>
                ${devStr ? `<span class="chip-dev">${devStr}</span>` : ''}
                ${gapStr ? `<span class="chip-gap">${gapStr}</span>` : ''}
            </div>`;
        }).join('');

        return `<div class="ladder-track">
            <span class="ladder-dir-label">${dirLabel}</span>
            <div class="ladder-rail">
                <div class="ladder-rail-line"></div>
                ${chips}
            </div>
        </div>`;
    }

    return `<div class="ladder-route">
        <div class="ladder-route-label" style="border-left:3px solid ${route.color}">
            <span class="ladder-route-tag">${route.tag}</span>
            <span class="ladder-route-name">${route.title.split('-')[1] || ''}</span>
            ${route.metrics.bunchingPairs > 0 ? `<span class="ladder-badge critical">${route.metrics.bunchingPairs} BUNCH</span>` : ''}
            ${route.metrics.largeGaps > 0 ? `<span class="ladder-badge warning">${route.metrics.largeGaps} GAP</span>` : ''}
        </div>
        ${renderTrack(dir0, '→')}
        ${renderTrack(dir1, '←')}
    </div>`;
}

function getChipClass(vehicle) {
    const a = vehicle.analysis.anomalies ?? [];
    if (a.includes('bunching'))  return 'chip-bunching';
    if (a.includes('closing'))   return 'chip-closing';
    if (a.includes('dwell'))     return 'chip-dwell';
    if (a.includes('early'))     return 'chip-early';
    if (a.includes('late'))      return 'chip-late';
    if (a.includes('gap_ahead')) return 'chip-gap-ahead';
    return 'chip-ok';
}

function formatDeviation(dev) {
    if (dev === null || dev === undefined) return '';
    if (Math.abs(dev) < 30) return ''; // within 30s — don't clutter
    const mins = Math.round(Math.abs(dev) / 60);
    const secs = Math.abs(dev) % 60;
    const label = mins > 0 ? `${mins}m${secs > 0 ? secs + 's' : ''}` : `${Math.abs(dev)}s`;
    return dev > 0 ? `+${label}` : `-${label}`;
}

function buildTooltip(v) {
    const a = v.analysis;
    const parts = [
        `Vehicle ${v.id}`,
        `Stop seq: ${v.stopSequence}`,
        `Gap ahead: ${a.gapAhead !== null ? a.gapAhead + ' stops' : 'n/a'}`,
        a.scheduleDeviation !== null ? `Schedule: ${a.scheduleDeviation > 0 ? '+' : ''}${Math.round(a.scheduleDeviation)}s` : null,
        a.anomalies.length > 0 ? `Flags: ${a.anomalies.join(', ')}` : null,
    ].filter(Boolean);
    return parts.join(' | ').replace(/"/g, "'");
}

/**
 * Renders the dispatch recommendations panel.
 * This replaces the color dashboard concept with specific, actionable instructions.
 */
export function renderRecommendations(recommendations) {
    if (!recContainer) return;
    lastRecommendations = recommendations ?? [];

    if (lastRecommendations.length === 0) {
        recContainer.innerHTML = '<div class="rec-empty">No active interventions required.</div>';
        return;
    }

    recContainer.innerHTML = lastRecommendations.map(rec => renderRecCard(rec)).join('');
}

function renderRecCard(rec) {
    const status = rec.status ?? 'pending';
    const severityClass = rec.severity.toLowerCase(); // 'critical', 'high', 'medium'
    const isCrossRoute = rec.action === 'CONVERT_TO_LOCAL' || rec.action === 'CONVERT_TO_EXPRESS';
    const actionLabel = {
        'HOLD':               'HOLD VEHICLE',
        'RELEASE_EARLY':      'RELEASE EARLY',
        'SHORT_TURN':         'SHORT TURN',
        'CONVERT_TO_LOCAL':   'CONVERT → LOCAL',
        'CONVERT_TO_EXPRESS': 'CONVERT → EXPRESS',
    }[rec.action] ?? rec.action;

    const holdStr = rec.holdSeconds
        ? `<div class="rec-detail"><span class="rec-detail-label">Hold time:</span> <strong>${rec.holdSeconds}s</strong></div>`
        : '';

    const bunchStr = rec.estimatedSecondsToBunch !== null && rec.estimatedSecondsToBunch > 0
        ? `<div class="rec-detail"><span class="rec-detail-label">Bunches in:</span> <strong>~${rec.estimatedSecondsToBunch}s</strong></div>`
        : '';

    const headwayStr = rec.headwayAfterAction !== null
        ? `<div class="rec-detail"><span class="rec-detail-label">Headway after:</span> <strong>${rec.headwayAfterAction} stops</strong></div>`
        : '';

    const timeStr = new Date(rec.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const routeLabel = isCrossRoute && rec.partnerRouteTag
        ? `Rt ${rec.routeTag} ↔ ${rec.partnerRouteTag}`
        : `Rt ${rec.routeTag}`;

    const crossRouteBadge = isCrossRoute ? `<span class="rec-cross-badge">CROSS-ROUTE</span>` : '';

    // Decision state badges and buttons
    let decisionBadge = '';
    let actionButtons = '';
    const escapedId = rec.id.replace(/'/g, "\\'");

    if (status === 'approved') {
        const instrStatus = rec.instructionStatus;
        let instrBadge = '';
        if (instrStatus === 'monitoring') {
            instrBadge = ` <span class="rec-instr-badge rec-instr-monitoring">⏱ Monitoring…</span>`;
        } else if (instrStatus === 'complied') {
            instrBadge = ` <span class="rec-instr-badge rec-instr-complied">✓ Vehicle held</span>`;
        } else if (instrStatus === 'non_complied') {
            instrBadge = ` <span class="rec-instr-badge rec-instr-noncomplied">⚠ Did not hold</span>`;
        } else if (instrStatus === 'expired') {
            instrBadge = ` <span class="rec-instr-badge rec-instr-expired">— Expired</span>`;
        }
        decisionBadge = `<span class="rec-decision-badge rec-approved">✓ ACCEPTED</span>${instrBadge}`;
    } else if (status === 'dismissed') {
        const reasonNote = rec.dismissReason ? ` — "${rec.dismissReason}"` : '';
        decisionBadge = `<span class="rec-decision-badge rec-dismissed">✗ DISMISSED${reasonNote}</span>`;
    } else {
        // pending — show action buttons
        actionButtons = `<div class="rec-actions">
            <button class="rec-btn rec-btn-approve" onclick="handleRecApprove('${escapedId}')">Accept</button>
            <button class="rec-btn rec-btn-dismiss" onclick="handleRecDismiss('${escapedId}')">Dismiss</button>
        </div>`;
    }

    const cardClass = `rec-card rec-${severityClass}${isCrossRoute ? ' rec-cross' : ''} rec-status-${status}`;

    return `<div class="${cardClass}" data-rec-id="${rec.id}">
        <div class="rec-header">
            <span class="rec-action-badge rec-badge-${severityClass}">${actionLabel}</span>
            ${crossRouteBadge}
            <span class="rec-vehicle">Veh ${rec.vehicleId}</span>
            <span class="rec-route">${routeLabel}</span>
            <span class="rec-time">${timeStr}</span>
            ${decisionBadge}
        </div>
        <div class="rec-reason">${rec.reason}</div>
        <div class="rec-details">
            ${holdStr}${bunchStr}${headwayStr}
        </div>
        ${actionButtons}
    </div>`;
}

// Exposed globally for inline onclick handlers
window.handleRecApprove = async function(id) {
    await API.approveRecommendation(id);
    if (onDecisionCallback) onDecisionCallback();
};

window.handleRecDismiss = async function(id) {
    await API.dismissRecommendation(id);
    if (onDecisionCallback) onDecisionCallback();
};
