/**
 * State file I/O helpers for notify-hook modules.
 */

import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { asNumber, safeString } from './utils.js';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export { readdir };

type JsonObject = Record<string, unknown>;

function normalizeNumberRecord(raw: unknown): Record<string, number> {
  const normalized: Record<string, number> = {};
  const entries = Object.entries(raw && typeof raw === 'object' ? raw as JsonObject : {});
  for (const [key, value] of entries) {
    const numeric = asNumber(value);
    if (numeric !== null) normalized[key] = numeric;
  }
  return normalized;
}

export interface TmuxState {
  total_injections: number;
  pane_counts: Record<string, number>;
  session_counts: Record<string, number>;
  recent_keys: Record<string, number>;
  last_injection_ts: number;
  last_reason: string;
  last_event_at: string;
  last_target?: string;
  last_prompt_preview?: string;
}

export interface NotifyState {
  recent_turns: Record<string, number>;
  last_event_at: string;
}

export function readJsonIfExists<T>(path: string, fallback: T): Promise<T> {
  return readFile(path, 'utf-8')
    .then((content) => JSON.parse(content) as T)
    .catch(() => fallback);
}

export async function getScopedStateDirsForCurrentSession(baseStateDir: string, payloadSessionId?: unknown): Promise<string[]> {
  const explicitSessionId = safeString(payloadSessionId || '');
  if (SESSION_ID_PATTERN.test(explicitSessionId)) {
    const sessionDir = join(baseStateDir, 'sessions', explicitSessionId);
    return [sessionDir];
  }

  const sessionPath = join(baseStateDir, 'session.json');
  try {
    const session = JSON.parse(await readFile(sessionPath, 'utf-8')) as JsonObject;
    const sessionId = safeString(session.session_id);
    if (SESSION_ID_PATTERN.test(sessionId)) {
      const sessionDir = join(baseStateDir, 'sessions', sessionId);
      if (existsSync(sessionDir)) return [sessionDir];
    }
  } catch {
    // No session file or malformed - fall back to global only
  }
  return [baseStateDir];
}

export function normalizeTmuxState(raw: unknown): TmuxState {
  if (!raw || typeof raw !== 'object') {
    return {
      total_injections: 0,
      pane_counts: {},
      session_counts: {},
      recent_keys: {},
      last_injection_ts: 0,
      last_reason: 'init',
      last_event_at: '',
    };
  }
  const record = raw as JsonObject;
  return {
    total_injections: asNumber(record.total_injections) ?? 0,
    pane_counts: normalizeNumberRecord(record.pane_counts),
    session_counts: normalizeNumberRecord(record.session_counts),
    recent_keys: normalizeNumberRecord(record.recent_keys),
    last_injection_ts: asNumber(record.last_injection_ts) ?? 0,
    last_reason: safeString(record.last_reason),
    last_event_at: safeString(record.last_event_at),
    last_target: safeString(record.last_target) || undefined,
    last_prompt_preview: safeString(record.last_prompt_preview) || undefined,
  };
}

export function normalizeNotifyState(raw: unknown): NotifyState {
  if (!raw || typeof raw !== 'object') {
    return {
      recent_turns: {},
      last_event_at: '',
    };
  }
  const record = raw as JsonObject;
  return {
    recent_turns: normalizeNumberRecord(record.recent_turns),
    last_event_at: safeString(record.last_event_at),
  };
}

export function pruneRecentTurns(recentTurns: unknown, now: number): Record<string, number> {
  const pruned: Record<string, number> = {};
  const minTs = now - (24 * 60 * 60 * 1000);
  const entries = Object.entries(
    recentTurns && typeof recentTurns === 'object' ? recentTurns as JsonObject : {},
  ).slice(-2000);
  for (const [key, value] of entries) {
    const ts = asNumber(value);
    if (ts !== null && ts >= minTs) pruned[key] = ts;
  }
  return pruned;
}

export function pruneRecentKeys(recentKeys: unknown, now: number): Record<string, number> {
  const pruned: Record<string, number> = {};
  const minTs = now - (24 * 60 * 60 * 1000);
  const entries = Object.entries(
    recentKeys && typeof recentKeys === 'object' ? recentKeys as JsonObject : {},
  ).slice(-1000);
  for (const [key, value] of entries) {
    const ts = asNumber(value);
    if (ts !== null && ts >= minTs) pruned[key] = ts;
  }
  return pruned;
}
