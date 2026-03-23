/**
 * SQLite persistence layer.
 *
 * Uses the built-in node:sqlite module (Node 22.5+) — no external dependency.
 * Stores dispatcher decisions so they survive server restarts.
 *
 * Schema
 * ──────
 * rec_decisions  — one row per decision (approve / dismiss) keyed by recommendation ID.
 *                  Upserted on each decision; the in-memory map is the primary lookup,
 *                  this table is the durable backing store.
 *
 * anomaly_events — lifetime records of detected anomaly conditions per vehicle.
 *                  Opened when an anomaly first appears, closed when it clears.
 *                  Enables trend charts and baseline learning in a future version.
 */

import { DatabaseSync } from 'node:sqlite';
import * as path from 'path';
import * as fs from 'fs';
import { log } from './logger';

const DB_DIR  = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DB_DIR, 'bridge.db');

fs.mkdirSync(DB_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);

// WAL mode: readers don't block writers, better for concurrent server + occasional writer
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS rec_decisions (
    rec_id        TEXT    PRIMARY KEY,
    rec_action    TEXT    NOT NULL,
    vehicle_id    TEXT    NOT NULL,
    route_tag     TEXT    NOT NULL,
    status        TEXT    NOT NULL CHECK(status IN ('approved', 'dismissed')),
    decided_at    INTEGER NOT NULL,
    dismiss_reason TEXT
  );

  CREATE TABLE IF NOT EXISTS anomaly_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    route_tag    TEXT    NOT NULL,
    vehicle_id   TEXT    NOT NULL,
    anomaly_type TEXT    NOT NULL,
    started_at   INTEGER NOT NULL,
    cleared_at   INTEGER
  );

  CREATE TABLE IF NOT EXISTS instructions (
    rec_id          TEXT    PRIMARY KEY,
    vehicle_id      TEXT    NOT NULL,
    route_tag       TEXT    NOT NULL,
    action          TEXT    NOT NULL,
    at_stop         TEXT    NOT NULL,
    stop_id_at_issue TEXT   NOT NULL,
    hold_seconds    INTEGER,
    issued_at       INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,
    lat_at_issue    REAL    NOT NULL,
    lon_at_issue    REAL    NOT NULL,
    outcome         TEXT    CHECK(outcome IN ('complied', 'non_complied', 'expired')),
    resolved_at     INTEGER
  );
`);

// ── Recommendation decisions ───────────────────────────────────────────────

const stmtUpsertDecision = db.prepare(`
  INSERT OR REPLACE INTO rec_decisions
    (rec_id, rec_action, vehicle_id, route_tag, status, decided_at, dismiss_reason)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const stmtLoadDecisions = db.prepare(`
  SELECT rec_id, status, decided_at, dismiss_reason
  FROM rec_decisions
  WHERE decided_at > ?
`);

export function saveDecision(
  recId: string,
  recAction: string,
  vehicleId: string,
  routeTag: string,
  status: 'approved' | 'dismissed',
  decidedAt: number,
  dismissReason: string | null,
): void {
  stmtUpsertDecision.run(recId, recAction, vehicleId, routeTag, status, decidedAt, dismissReason ?? null);
}

export interface StoredDecision {
  recId: string;
  status: 'approved' | 'dismissed';
  decidedAt: number;
  dismissReason: string | null;
}

export function loadRecentDecisions(ttlMs: number): StoredDecision[] {
  const cutoff = Date.now() - ttlMs;
  const rows = stmtLoadDecisions.all(cutoff) as Array<{
    rec_id: string;
    status: string;
    decided_at: number;
    dismiss_reason: string | null;
  }>;
  return rows.map(r => ({
    recId: r.rec_id,
    status: r.status as 'approved' | 'dismissed',
    decidedAt: r.decided_at,
    dismissReason: r.dismiss_reason,
  }));
}

// ── Anomaly events ─────────────────────────────────────────────────────────

const stmtOpenAnomaly = db.prepare(`
  INSERT INTO anomaly_events (route_tag, vehicle_id, anomaly_type, started_at)
  VALUES (?, ?, ?, ?)
`);

const stmtCloseAnomaly = db.prepare(`
  UPDATE anomaly_events
  SET cleared_at = ?
  WHERE vehicle_id = ? AND anomaly_type = ? AND cleared_at IS NULL
`);

const stmtOpenAnomalies = db.prepare(`
  SELECT vehicle_id, anomaly_type FROM anomaly_events WHERE cleared_at IS NULL
`);

// In-memory set of currently-open anomalies: "vehicleId:anomalyType"
let openAnomalies = new Set<string>();

/** Seed open-anomaly state from DB on startup so we don't duplicate on reconnect. */
export function seedOpenAnomalies(): void {
  const rows = stmtOpenAnomalies.all() as Array<{ vehicle_id: string; anomaly_type: string }>;
  openAnomalies = new Set(rows.map(r => `${r.vehicle_id}:${r.anomaly_type}`));
  log.info('DB', 'anomaly state seeded', { openCount: openAnomalies.size });
}

/**
 * Reconcile anomaly events for a single vehicle after a poll.
 * Opens new anomaly rows when an anomaly first appears; closes them when it clears.
 */
export function reconcileAnomalies(
  routeTag: string,
  vehicleId: string,
  currentAnomalies: string[],
  nowMs: number,
): void {
  for (const anomaly of currentAnomalies) {
    const key = `${vehicleId}:${anomaly}`;
    if (!openAnomalies.has(key)) {
      stmtOpenAnomaly.run(routeTag, vehicleId, anomaly, nowMs);
      openAnomalies.add(key);
    }
  }
  // Close anomalies that are no longer present for this vehicle
  const currentSet = new Set(currentAnomalies);
  for (const key of openAnomalies) {
    const [vid, atype] = key.split(':');
    if (vid === vehicleId && !currentSet.has(atype)) {
      stmtCloseAnomaly.run(nowMs, vehicleId, atype);
      openAnomalies.delete(key);
    }
  }
}

// ── Instruction outcome tracking ───────────────────────────────────────────

export interface StoredInstruction {
  recId: string;
  vehicleId: string;
  routeTag: string;
  action: string;
  atStop: string;
  stopIdAtIssue: string;
  holdSeconds: number | null;
  issuedAt: number;
  expiresAt: number;
  latAtIssue: number;
  lonAtIssue: number;
  outcome: 'complied' | 'non_complied' | 'expired' | null;
  resolvedAt: number | null;
}

const stmtCreateInstruction = db.prepare(`
  INSERT OR REPLACE INTO instructions
    (rec_id, vehicle_id, route_tag, action, at_stop, stop_id_at_issue,
     hold_seconds, issued_at, expires_at, lat_at_issue, lon_at_issue,
     outcome, resolved_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
`);

const stmtLoadOpenInstructions = db.prepare(`
  SELECT * FROM instructions WHERE outcome IS NULL
`);

const stmtResolveInstruction = db.prepare(`
  UPDATE instructions SET outcome = ?, resolved_at = ? WHERE rec_id = ?
`);

const stmtGetInstruction = db.prepare(`
  SELECT * FROM instructions WHERE rec_id = ?
`);

export function createInstruction(
  recId: string,
  vehicleId: string,
  routeTag: string,
  action: string,
  atStop: string,
  stopIdAtIssue: string,
  holdSeconds: number | null,
  issuedAt: number,
  expiresAt: number,
  latAtIssue: number,
  lonAtIssue: number,
): void {
  stmtCreateInstruction.run(
    recId, vehicleId, routeTag, action, atStop, stopIdAtIssue,
    holdSeconds, issuedAt, expiresAt, latAtIssue, lonAtIssue,
  );
}

function rowToInstruction(r: Record<string, unknown>): StoredInstruction {
  return {
    recId: r.rec_id as string,
    vehicleId: r.vehicle_id as string,
    routeTag: r.route_tag as string,
    action: r.action as string,
    atStop: r.at_stop as string,
    stopIdAtIssue: r.stop_id_at_issue as string,
    holdSeconds: r.hold_seconds as number | null,
    issuedAt: r.issued_at as number,
    expiresAt: r.expires_at as number,
    latAtIssue: r.lat_at_issue as number,
    lonAtIssue: r.lon_at_issue as number,
    outcome: r.outcome as 'complied' | 'non_complied' | 'expired' | null,
    resolvedAt: r.resolved_at as number | null,
  };
}

export function loadOpenInstructions(): StoredInstruction[] {
  const rows = stmtLoadOpenInstructions.all() as Array<Record<string, unknown>>;
  return rows.map(rowToInstruction);
}

export function resolveInstruction(
  recId: string,
  outcome: 'complied' | 'non_complied' | 'expired',
  resolvedAt: number,
): void {
  stmtResolveInstruction.run(outcome, resolvedAt, recId);
}

export function getInstruction(recId: string): StoredInstruction | null {
  const row = stmtGetInstruction.get(recId) as Record<string, unknown> | null;
  return row ? rowToInstruction(row) : null;
}

// ── Anomaly history query ───────────────────────────────────────────────────

export interface AnomalyHistoryRow {
  routeTag: string;
  anomalyType: string;
  eventCount: number;
  avgDurationMs: number | null;
}

const stmtQueryHistory = db.prepare(`
  SELECT
    route_tag,
    anomaly_type,
    COUNT(*)                                                       AS event_count,
    AVG(COALESCE(cleared_at, ?) - started_at)                     AS avg_duration_ms
  FROM anomaly_events
  WHERE started_at >= ? AND started_at <= ?
  GROUP BY route_tag, anomaly_type
  ORDER BY route_tag, event_count DESC
`);

const stmtQueryHistoryRoute = db.prepare(`
  SELECT
    route_tag,
    anomaly_type,
    COUNT(*)                                                       AS event_count,
    AVG(COALESCE(cleared_at, ?) - started_at)                     AS avg_duration_ms
  FROM anomaly_events
  WHERE started_at >= ? AND started_at <= ? AND route_tag = ?
  GROUP BY route_tag, anomaly_type
  ORDER BY event_count DESC
`);

export function queryAnomalyHistory(
  startMs: number,
  endMs: number,
  routeTag?: string,
): AnomalyHistoryRow[] {
  const rows = routeTag
    ? stmtQueryHistoryRoute.all(endMs, startMs, endMs, routeTag)
    : stmtQueryHistory.all(endMs, startMs, endMs);
  return (rows as Array<Record<string, unknown>>).map(r => ({
    routeTag: r.route_tag as string,
    anomalyType: r.anomaly_type as string,
    eventCount: r.event_count as number,
    avgDurationMs: r.avg_duration_ms as number | null,
  }));
}

log.info('DB', 'opened', { path: DB_PATH });
