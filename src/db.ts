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

log.info('DB', 'opened', { path: DB_PATH });
