/**
 * Shared mutable runtime state for Bridge.
 *
 * All server-wide state lives in the single `appState` object so every module
 * that needs to read or mutate shared data imports from one place.
 * This avoids the ES-module read-only binding restriction on exported `let`s.
 *
 * Constants that derive from the environment (POLL_INTERVAL_MS) or that are
 * needed across modules (DECISION_TTL_MS, BRIDGE_INSTANCE_ID) are also here.
 */

import * as crypto from 'crypto';
import { Response }  from 'express';
import { RouteState, DispatchRecommendation, VehicleHistory, DispatchPolicy, DEFAULT_POLICY } from './types';
import { GtfsRouteData } from './gtfs';
import { StoredInstruction } from './db';

// ── Constants ──────────────────────────────────────────────────────────────

export const PORT             = parseInt(process.env.PORT             ?? '3000',  10);
export const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '10000', 10);

/** After this window, a dismissed/approved decision expires and the rec can re-surface. */
export const DECISION_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Stable per-process UUID included in webhook payloads for traceability. */
export const BRIDGE_INSTANCE_ID = crypto.randomUUID();

// ── Mutable application state ──────────────────────────────────────────────

export const appState = {
  /** Latest vehicle + metrics state per route, keyed by routeTag. */
  systemState: {} as Record<string, RouteState>,

  /** Latest recommendations per route, keyed by routeTag (and '_cross_route'). */
  systemRecommendations: {} as Record<string, DispatchRecommendation[]>,

  /** Per-route vehicle state retained between polls for rate-of-change detection. */
  vehicleHistory: {} as Record<string, VehicleHistory>,

  /** Active dispatch policy — mutable at runtime via POST /api/policy. */
  activePolicy: { ...DEFAULT_POLICY } as DispatchPolicy,

  /** Static GTFS data loaded once at startup. */
  gtfsData: new Map<string, GtfsRouteData>(),

  /** Average stop spacing (metres) per route, derived from GTFS geometry at startup. */
  routeSpacing: new Map<string, number>(),

  /**
   * Dispatcher decisions: keyed by recommendation ID.
   * In-memory primary lookup; SQLite rec_decisions table is the durable backing store.
   * Entries expire after DECISION_TTL_MS so persistent conditions re-surface.
   */
  recDecisions: new Map<string, {
    status: 'approved' | 'dismissed';
    decidedAt: number;
    dismissReason: string | null;
  }>(),

  /**
   * Open instructions: approved HOLD/SHORT_TURN recs being watched for compliance.
   * Resolved entries are removed each poll; loaded from DB on restart.
   */
  openInstructions: new Map<string, StoredInstruction>(),

  /** Resolved instruction outcomes, kept for the session so applyDecisions can surface them. */
  resolvedOutcomes: new Map<string, 'complied' | 'non_complied' | 'expired'>(),

  /**
   * Outbound webhook config — POST /api/webhook to configure at runtime.
   * Bridge fires a signed payload to this URL on every approved HOLD/SHORT_TURN.
   */
  webhookConfig: { url: null as string | null, secret: null as string | null },

  /** Connected SSE dispatcher clients. */
  sseClients: new Set<Response>(),

  /** Aggregate health metrics updated each poll, served by GET /health. */
  healthState: {
    startedAt:         Date.now(),
    lastPollAt:        0,
    lastPollSuccess:   true,
    consecutiveErrors: 0,
    lastError:         null as string | null,
    sseClients:        0,
  },
};
