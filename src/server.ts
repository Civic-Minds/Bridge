import express, { Request, Response } from 'express';
import cors from 'cors';
import * as crypto from 'crypto';
import { DispatchPolicy, DEFAULT_POLICY, DispatchRecommendation } from './types';
import { log } from './logger';
import {
  saveDecision, loadRecentDecisions,
  createInstruction, StoredInstruction,
  queryAnomalyHistory, queryAnomalyHistoryHourly, queryFeedback,
} from './db';
import { CONFIG, CONFLICT_ZONES } from './config';
import { appState, PORT, POLL_INTERVAL_MS, BRIDGE_INSTANCE_ID, DECISION_TTL_MS } from './state';
import { boot, initRoutes, applyDecisions } from './poller';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

void boot();

// ── State & anomalies ──────────────────────────────────────────────────────

app.get('/api/state', (_req: Request, res: Response) => {
  res.json({ agency: 'ttc', timestamp: Date.now(), routes: appState.systemState, zones: CONFLICT_ZONES });
});

app.get('/api/anomalies', (_req: Request, res: Response) => {
  const anomalies = Object.values(appState.systemState).flatMap(route =>
    route.vehicles
      .filter(v => v.analysis.anomalies.length > 0)
      .map(v => ({
        routeTag:          route.tag,
        routeTitle:        route.title,
        vehicleId:         v.id,
        anomalies:         v.analysis.anomalies,
        inferredDir:       v.analysis.inferredDir,
        gapAhead:          v.analysis.gapAhead,
        dwellSeconds:      v.analysis.dwellSeconds,
        scheduleDeviation: v.analysis.scheduleDeviation,
        stopId:            v.stopId,
        stopSequence:      v.stopSequence,
        lat:               v.lat,
        lon:               v.lon,
      }))
  );
  res.json({ timestamp: Date.now(), count: anomalies.length, anomalies });
});

// ── Recommendations ────────────────────────────────────────────────────────

app.get('/api/recommendations', (_req: Request, res: Response) => {
  const all = applyDecisions(Object.values(appState.systemRecommendations).flat());
  const order: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
  all.sort((a, b) => order[a.severity] - order[b.severity]);
  const crossRouteCount = (appState.systemRecommendations['_cross_route'] ?? []).length;
  res.json({ timestamp: Date.now(), count: all.length, crossRouteCount, recommendations: all });
});

app.get('/api/recommendations/:routeTag', (req: Request, res: Response) => {
  const routeTag = Array.isArray(req.params.routeTag) ? req.params.routeTag[0] : req.params.routeTag;
  const recs = appState.systemRecommendations[routeTag];
  if (!recs) { res.status(404).json({ error: `Route ${routeTag} not monitored` }); return; }
  res.json({ timestamp: Date.now(), routeTag, count: recs.length, recommendations: applyDecisions(recs) });
});

app.post('/api/recommendations/:id/approve', (req: Request, res: Response) => {
  const id         = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const approvedAt = Date.now();
  appState.recDecisions.set(id, { status: 'approved', decidedAt: approvedAt, dismissReason: null });

  const rec = Object.values(appState.systemRecommendations).flat().find(r => r.id === id);
  if (rec) {
    saveDecision(id, rec.action, rec.vehicleId, rec.routeTag, 'approved', approvedAt, null);

    if (rec.action === 'HOLD' || rec.action === 'SHORT_TURN') {
      const vehicle = appState.systemState[rec.routeTag]?.vehicles.find(v => v.id === rec.vehicleId);
      if (vehicle) {
        const holdSecs  = rec.holdSeconds ?? 60;
        const expiresAt = approvedAt + holdSecs * 1000 + POLL_INTERVAL_MS * 3;
        createInstruction(
          id, rec.vehicleId, rec.routeTag, rec.action, rec.atStop,
          vehicle.stopId, holdSecs, approvedAt, expiresAt, vehicle.lat, vehicle.lon,
        );
        appState.openInstructions.set(id, {
          recId: id, vehicleId: rec.vehicleId, routeTag: rec.routeTag,
          action: rec.action, atStop: rec.atStop, stopIdAtIssue: vehicle.stopId,
          holdSeconds: holdSecs, issuedAt: approvedAt, expiresAt,
          latAtIssue: vehicle.lat, lonAtIssue: vehicle.lon,
          outcome: null, resolvedAt: null,
        } satisfies StoredInstruction);
        log.info('Instruction', 'created', { recId: id, vehicleId: rec.vehicleId, holdSecs, atStop: rec.atStop });

        void deliverWebhook({
          schemaVersion: '1', type: 'dispatch_instruction',
          recommendationId: id, vehicleId: rec.vehicleId, routeTag: rec.routeTag,
          action: rec.action, holdSeconds: holdSecs, atStop: rec.atStop,
          severity: rec.severity, reason: rec.reason,
          issuedAt: approvedAt, expiresAt, bridgeInstanceId: BRIDGE_INSTANCE_ID,
        });
      }
    }
  }
  log.info('Decision', 'approved', { id, vehicleId: rec?.vehicleId, routeTag: rec?.routeTag });
  res.json({ success: true, id, status: 'approved' });
});

app.post('/api/recommendations/:id/dismiss', (req: Request, res: Response) => {
  const id           = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const reason       = (req.body as { reason?: unknown }).reason;
  const dismissReason = typeof reason === 'string' ? reason : null;
  const dismissedAt  = Date.now();
  appState.recDecisions.set(id, { status: 'dismissed', decidedAt: dismissedAt, dismissReason });
  const rec = Object.values(appState.systemRecommendations).flat().find(r => r.id === id);
  if (rec) saveDecision(id, rec.action, rec.vehicleId, rec.routeTag, 'dismissed', dismissedAt, dismissReason);
  log.info('Decision', 'dismissed', { id, reason: dismissReason, vehicleId: rec?.vehicleId, routeTag: rec?.routeTag });
  res.json({ success: true, id, status: 'dismissed', dismissReason });
});

// ── Policy ─────────────────────────────────────────────────────────────────

app.get('/api/policy', (_req: Request, res: Response) => {
  res.json({
    policy: appState.activePolicy,
    availableActions: ['HOLD', 'RELEASE_EARLY', 'SHORT_TURN', 'CONVERT_TO_LOCAL', 'CONVERT_TO_EXPRESS'],
    severityLevels: ['MEDIUM', 'HIGH', 'CRITICAL'],
    defaults: DEFAULT_POLICY,
  });
});

app.post('/api/policy', (req: Request, res: Response) => {
  const body = req.body as Partial<DispatchPolicy>;
  if (body.enabledActions && !Array.isArray(body.enabledActions)) {
    res.status(400).json({ error: 'enabledActions must be an array' }); return;
  }
  if (body.minimumSeverity && !['MEDIUM', 'HIGH', 'CRITICAL'].includes(body.minimumSeverity)) {
    res.status(400).json({ error: 'minimumSeverity must be MEDIUM, HIGH, or CRITICAL' }); return;
  }
  appState.activePolicy = {
    ...appState.activePolicy, ...body,
    routeOverrides: { ...appState.activePolicy.routeOverrides, ...(body.routeOverrides ?? {}) },
    policyNotes: body.policyNotes ?? appState.activePolicy.policyNotes,
  };
  log.info('Policy', 'updated', { policy: appState.activePolicy });
  res.json({ success: true, policy: appState.activePolicy });
});

app.post('/api/policy/reset', (_req: Request, res: Response) => {
  appState.activePolicy = { ...DEFAULT_POLICY };
  log.info('Policy', 'reset to defaults');
  res.json({ success: true, policy: appState.activePolicy });
});

// ── Webhook ────────────────────────────────────────────────────────────────

/**
 * Fire-and-forget delivery of a signed instruction payload to the configured webhook URL.
 * If a secret is set, adds `X-Bridge-Signature: sha256=<hex>` for receiver verification.
 */
async function deliverWebhook(payload: Record<string, unknown>): Promise<void> {
  if (!appState.webhookConfig.url) return;
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type':      'application/json',
    'User-Agent':        'Bridge-Dispatch/1.0',
    'X-Bridge-Instance': BRIDGE_INSTANCE_ID,
  };
  if (appState.webhookConfig.secret) {
    const sig = crypto.createHmac('sha256', appState.webhookConfig.secret).update(body).digest('hex');
    headers['X-Bridge-Signature'] = `sha256=${sig}`;
  }
  try {
    const res = await fetch(appState.webhookConfig.url, { method: 'POST', headers, body });
    if (!res.ok) {
      log.warn('Webhook', 'delivery failed', { url: appState.webhookConfig.url, status: res.status });
    } else {
      log.info('Webhook', 'delivered', { url: appState.webhookConfig.url, status: res.status, recId: payload.recommendationId });
    }
  } catch (err) {
    log.error('Webhook', 'delivery error', { url: appState.webhookConfig.url, err: (err as Error).message });
  }
}

app.get('/api/webhook', (_req: Request, res: Response) => {
  res.json({
    configured:       appState.webhookConfig.url !== null,
    url:              appState.webhookConfig.url,
    hasSecret:        appState.webhookConfig.secret !== null,
    bridgeInstanceId: BRIDGE_INSTANCE_ID,
  });
});

app.post('/api/webhook', (req: Request, res: Response) => {
  const body = req.body as { url?: unknown; secret?: unknown };
  if (!body.url || typeof body.url !== 'string') {
    res.status(400).json({ error: 'url is required and must be a string' }); return;
  }
  try { new URL(body.url); } catch {
    res.status(400).json({ error: 'url must be a valid URL' }); return;
  }
  appState.webhookConfig.url    = body.url;
  appState.webhookConfig.secret = typeof body.secret === 'string' ? body.secret : null;
  log.info('Webhook', 'configured', { url: appState.webhookConfig.url, hasSecret: appState.webhookConfig.secret !== null });
  res.json({ success: true, configured: true, url: appState.webhookConfig.url, hasSecret: appState.webhookConfig.secret !== null });
});

app.delete('/api/webhook', (_req: Request, res: Response) => {
  appState.webhookConfig.url = null;
  appState.webhookConfig.secret = null;
  log.info('Webhook', 'disabled');
  res.json({ success: true, configured: false });
});

// ── Config ─────────────────────────────────────────────────────────────────

app.post('/api/config/active-routes', (req: Request, res: Response) => {
  const { routes } = req.body as { routes?: unknown };
  if (!routes || !Array.isArray(routes)) {
    res.status(400).json({ error: 'Invalid routes array' }); return;
  }
  CONFIG.routes = routes as string[];
  initRoutes();
  res.json({ success: true, activeRoutes: CONFIG.routes });
});

// ── SSE ────────────────────────────────────────────────────────────────────

app.get('/api/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  (res as unknown as { write: (s: string) => void }).write(':connected\n\n');
  appState.sseClients.add(res);
  log.info('SSE', 'client connected', { totalClients: appState.sseClients.size });
  req.on('close', () => {
    appState.sseClients.delete(res);
    log.info('SSE', 'client disconnected', { totalClients: appState.sseClients.size });
  });
});

// ── Feedback ───────────────────────────────────────────────────────────────

// GET /api/feedback?window=<ms>&route=<tag>
// Returns dispatcher decision rates (approve/dismiss) per route+action.
// Default window: 7 days. Use to spot systematically over-eager thresholds.
app.get('/api/feedback', (req: Request, res: Response) => {
  const windowMs = parseInt(req.query.window as string, 10) || 7 * 24 * 60 * 60 * 1000;
  const route    = typeof req.query.route === 'string' ? req.query.route : undefined;
  const rows     = queryFeedback(windowMs, route);
  res.json({ timestamp: Date.now(), windowMs, route: route ?? 'all', count: rows.length, feedback: rows });
});

// ── History ────────────────────────────────────────────────────────────────

app.get('/api/history', (req: Request, res: Response) => {
  const now     = Date.now();
  const endMs   = parseInt(req.query.end     as string, 10) || now;
  const startMs = parseInt(req.query.start   as string, 10) || endMs - 24 * 60 * 60 * 1000;
  const route   = typeof req.query.route   === 'string' ? req.query.route   : undefined;
  const groupBy = typeof req.query.groupBy === 'string' ? req.query.groupBy : undefined;

  if (startMs >= endMs) { res.status(400).json({ error: 'start must be before end' }); return; }

  if (groupBy === 'hour') {
    const rows = queryAnomalyHistoryHourly(startMs, endMs, route);
    res.json({ timestamp: now, startMs, endMs, route: route ?? 'all', groupBy: 'hour', count: rows.length, history: rows });
    return;
  }
  const rows = queryAnomalyHistory(startMs, endMs, route);
  res.json({ timestamp: now, startMs, endMs, route: route ?? 'all', count: rows.length, history: rows });
});

// ── Health ─────────────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  const now              = Date.now();
  const lastPollAgeSeconds = appState.healthState.lastPollAt > 0
    ? Math.round((now - appState.healthState.lastPollAt) / 1000)
    : null;
  const totalVehicles = Object.values(appState.systemState).reduce((s, r) => s + r.metrics.activeCount, 0);
  const status = appState.healthState.consecutiveErrors >= 3 ? 'error'
    : appState.healthState.consecutiveErrors >= 1 ? 'degraded'
    : 'ok';
  res.status(status === 'error' ? 503 : 200).json({
    status,
    uptime:            Math.round((now - appState.healthState.startedAt) / 1000),
    lastPollAt:        appState.healthState.lastPollAt || null,
    lastPollAgeSeconds,
    consecutiveErrors: appState.healthState.consecutiveErrors,
    lastError:         appState.healthState.lastError,
    routeCount:        CONFIG.routes.length,
    vehicleCount:      totalVehicles,
    sseClients:        appState.sseClients.size,
  });
});

app.listen(PORT, () => log.info('Server', 'listening', { port: PORT, pollIntervalMs: POLL_INTERVAL_MS }));
