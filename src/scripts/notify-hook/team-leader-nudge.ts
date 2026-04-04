/**
 * Team leader nudge: remind the leader to check teammate/mailbox state.
 */

import { readFile, writeFile, mkdir, appendFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { asNumber, safeString, isTerminalPhase } from './utils.js';
import { readJsonIfExists, getScopedStateDirsForCurrentSession } from './state-io.js';
import { runProcess } from './process-runner.js';
import { logTmuxHookEvent } from './log.js';
import { evaluatePaneInjectionReadiness, sendPaneInput } from './team-tmux-guard.js';
import { DEFAULT_MARKER } from '../tmux-hook-engine.js';
import { isLeaderRuntimeStale } from '../../team/leader-activity.js';
import { buildRuntimeTraceId, traceDecision } from '../../debug/runtime-trace.js';
const LEADER_PANE_MISSING_NO_INJECTION_REASON = 'leader_pane_missing_no_injection';
const LEADER_PANE_SHELL_NO_INJECTION_REASON = 'leader_pane_shell_no_injection';
const LEADER_NOTIFICATION_DEFERRED_TYPE = 'leader_notification_deferred';
const ACK_WITHOUT_START_EVIDENCE_REASON = 'ack_without_start_evidence';
const ACK_LIKE_PATTERNS = [
  /^ack(?::\s*[a-z0-9-]+(?:\s+initialized)?)?[.!]*$/i,
  /^(?:ok|okay|k|roger|copy|received|got it|understood|sounds good)[.!]*$/i,
  /^(?:on it|will do|i(?:'|’)ll do it|working on it)[.!]*$/i,
];

interface TaskCounts {
  pending: number;
  blocked: number;
  in_progress: number;
  completed: number;
  failed: number;
}

interface LeaderActionOptions {
  allWorkersIdle?: boolean;
  workerPanesAlive?: boolean;
  workerPanesReusable?: boolean;
  workerPaneIdsConfigured?: boolean;
  taskCounts?: Partial<TaskCounts>;
  teamProgressStalled?: boolean;
  leaderActionState?: string;
}

interface WorkerStatusSnapshot {
  state: string;
  current_task_id: string;
  missing?: boolean;
}

interface WorkerHeartbeatSnapshot {
  turn_count: number | null;
  missing: boolean;
}

interface WorkerProgressSnapshot {
  worker: string;
  state: string;
  current_task_id: string;
  status_missing: boolean;
  turn_count: number | null;
  heartbeat_missing: boolean;
}

interface TaskSignatureEntry {
  id: string;
  owner: string;
  status: string;
}

interface TeamTaskProgressSnapshot {
  taskCounts: TaskCounts;
  taskSignature: TaskSignatureEntry[];
  workRemaining: boolean;
}

interface TeamProgressSnapshot extends TeamTaskProgressSnapshot {
  workerSnapshot: WorkerProgressSnapshot[];
  missingSignalWorkers: number;
  signature: string;
}

interface MailboxMessage {
  message_id?: string;
  created_at?: string;
  timestamp?: string;
  from_worker?: string;
  from?: string;
  body?: string;
}

interface ProgressStateEntry {
  signature?: string;
  last_progress_at?: string;
  observed_at?: string;
  missing_signal_workers?: number;
  work_remaining?: boolean;
  leader_action_state?: string;
}

interface NudgeStateEntry {
  at?: string;
  last_message_id?: string;
  reason?: string;
  worker_count?: number;
}

interface NudgeState {
  last_nudged_by_team: Record<string, NudgeStateEntry>;
  last_idle_nudged_by_team: Record<string, NudgeStateEntry>;
  progress_by_team: Record<string, ProgressStateEntry>;
}

interface TeamWorkerConfig {
  name?: string;
  pane_id?: string;
}

interface MaybeNudgeTeamLeaderArgs {
  cwd: string;
  stateDir: string;
  logsDir: string;
  preComputedLeaderStale?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : safeString(error);
}

async function decisionTrace(cwd: string, event: string, payload: Record<string, unknown> = {}) {
  await traceDecision(cwd, 'team-leader-nudge', event, payload).catch(() => {});
}

function leaderNudgeTraceId(teamName: string, nowIso: string): string {
  return buildRuntimeTraceId('leader-nudge', safeString(teamName).trim() || 'unknown', safeString(nowIso).trim() || 'tick');
}

export function resolveLeaderNudgeIntervalMs() {
  const raw = safeString(process.env.OMX_TEAM_LEADER_NUDGE_MS || '');
  const parsed = asNumber(raw);
  // Default: 30 seconds for stale-leader follow-up. Guard against spam.
  if (parsed !== null && parsed >= 10_000 && parsed <= 30 * 60_000) return parsed;
  return 30_000;
}

export function resolveLeaderAllIdleNudgeCooldownMs() {
  const raw = safeString(process.env.OMX_TEAM_LEADER_ALL_IDLE_COOLDOWN_MS || '');
  const parsed = asNumber(raw);
  // Default: 30 seconds.
  if (parsed !== null && parsed >= 5_000 && parsed <= 10 * 60_000) return parsed;
  return 30_000;
}

export function resolveLeaderStalenessThresholdMs() {
  const raw = safeString(process.env.OMX_TEAM_LEADER_STALE_MS || '');
  const parsed = asNumber(raw);
  // Default: 3 minutes. Guard against unreasonable values.
  if (parsed !== null && parsed >= 10_000 && parsed <= 30 * 60_000) return parsed;
  return 180_000;
}

export function resolveFallbackProgressStallThresholdMs() {
  const raw = safeString(process.env.OMX_TEAM_PROGRESS_STALL_MS || '');
  const parsed = asNumber(raw);
  // Fallback-only threshold used when worker turn-count signals are unavailable.
  // Default: 2 minutes. Guard against unreasonable values.
  if (parsed !== null && parsed >= 10_000 && parsed <= 60 * 60_000) return parsed;
  return 120_000;
}

export function resolveWorkerTurnStallThresholdMs() {
  const raw = safeString(process.env.OMX_TEAM_WORKER_TURN_STALL_MS || '');
  const parsed = asNumber(raw);
  // Default: 30 seconds. Guard against unreasonable values.
  if (parsed !== null && parsed >= 10_000 && parsed <= 10 * 60_000) return parsed;
  return 30_000;
}

function buildStatusCheckReminder(teamName: string) {
  return `Next: check messages; keep orchestrating; if done, gracefully shut down: omx team shutdown ${teamName}.`;
}

function buildMailboxCheckReminder(teamName: string) {
  return `Next: read messages; keep orchestrating; if done, gracefully shut down: omx team shutdown ${teamName}.`;
}

function buildWorkerStartEvidenceReminder(teamName: string, workerName: string) {
  return `Next: check ${workerName} msg/output, confirm task in omx team status ${teamName}, then reassign/nudge.`;
}

function classifyLeaderActionState({
  allWorkersIdle = false,
  workerPanesAlive = false,
  workerPanesReusable = false,
  workerPaneIdsConfigured = true,
  taskCounts = {},
  teamProgressStalled = false,
}: LeaderActionOptions = {}) {
  void workerPanesAlive;
  void workerPaneIdsConfigured;
  const pending = Number.isFinite(taskCounts.pending) ? (taskCounts.pending ?? 0) : 0;
  const blocked = Number.isFinite(taskCounts.blocked) ? (taskCounts.blocked ?? 0) : 0;
  const inProgress = Number.isFinite(taskCounts.in_progress) ? (taskCounts.in_progress ?? 0) : 0;
  const tasksComplete = pending === 0 && blocked === 0 && inProgress === 0;
  const pendingFollowUpTasks = allWorkersIdle && pending > 0 && blocked === 0 && inProgress === 0;
  const blockedWaitingOnLeader = allWorkersIdle && blocked > 0 && pending === 0 && inProgress === 0;
  const terminalWaitingOnLeader = allWorkersIdle && tasksComplete;
  const stalledWaitingOnLeader = blockedWaitingOnLeader || teamProgressStalled;

  if (terminalWaitingOnLeader) return 'done_waiting_on_leader';
  if (stalledWaitingOnLeader) return 'stuck_waiting_on_leader';
  if (pendingFollowUpTasks && workerPanesReusable) return 'still_actionable';
  if (pendingFollowUpTasks) return 'all_workers_idle';
  return 'still_actionable';
}

function buildLeaderActionGuidance(teamName: string, {
  allWorkersIdle = false,
  workerPanesAlive = false,
  workerPanesReusable = false,
  taskCounts = {},
  leaderActionState = 'still_actionable',
}: LeaderActionOptions = {}) {
  void workerPanesAlive;
  const pending = Number.isFinite(taskCounts.pending) ? (taskCounts.pending ?? 0) : 0;
  const blocked = Number.isFinite(taskCounts.blocked) ? (taskCounts.blocked ?? 0) : 0;
  const inProgress = Number.isFinite(taskCounts.in_progress) ? (taskCounts.in_progress ?? 0) : 0;
  const pendingFollowUpTasks = allWorkersIdle && pending > 0 && blocked === 0 && inProgress === 0;

  if (pendingFollowUpTasks) {
    return workerPanesReusable
      ? 'Next: assign the next follow-up task to this idle team.'
      : 'Next: launch a new team for the next task set.';
  }
  if (leaderActionState === 'done_waiting_on_leader') {
    return `Next: decide whether to reconcile/merge results or gracefully shut down: omx team shutdown ${teamName}.`;
  }
  if (leaderActionState === 'stuck_waiting_on_leader') {
    return `Next: omx team status ${teamName}; read worker messages; unblock/reassign or shutdown.`;
  }
  return buildStatusCheckReminder(teamName);
}

export async function checkWorkerPanesAlive(tmuxTarget: string, workerPaneIds: string[] = []) {
  const sessionName = safeString(tmuxTarget).split(':')[0];
  const target = safeString(tmuxTarget).trim();
  const workerPaneIdSet = new Set(
    Array.isArray(workerPaneIds)
      ? workerPaneIds.map((paneId) => safeString(paneId).trim()).filter(Boolean)
      : [],
  );
  for (const probeTarget of [...new Set([target, sessionName].filter(Boolean))]) {
    const attempts = [probeTarget];
    if (attempts[0]) attempts.push(probeTarget);
    for (const attemptTarget of attempts) {
      try {
        const result = await runProcess('tmux', ['list-panes', '-t', attemptTarget, '-F', '#{pane_id}'], 2000);
        const lines = safeString(result.stdout)
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        const relevantLines = workerPaneIdSet.size > 0
          ? lines.filter((line) => workerPaneIdSet.has(line.split(/\s+/, 1)[0] || ''))
          : lines;
        if (relevantLines.length > 0) {
          return { alive: true, paneCount: relevantLines.length, sessionName, relevantLines };
        }
        break;
      } catch (error: unknown) {
        const message = errorMessage(error).trim().toLowerCase();
        const timedOut = message.startsWith('timeout after ');
        if (!timedOut) break;
      }
    }
  }
  return { alive: false, paneCount: 0, sessionName, relevantLines: [] };
}

export async function isLeaderStale(stateDir: string, thresholdMs: number, nowMs: number) {
  return isLeaderRuntimeStale(stateDir, thresholdMs, nowMs);
}

function resolveTerminalAtFromPhaseDoc(parsed: unknown, fallbackIso: string) {
  const record = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  const transitions = Array.isArray(record.transitions) ? record.transitions : [];
  for (let idx = transitions.length - 1; idx >= 0; idx -= 1) {
    const at = safeString(transitions[idx] && transitions[idx].at).trim();
    if (at) return at;
  }
  const updatedAt = safeString(record.updated_at).trim();
  return updatedAt || fallbackIso;
}

async function readTeamPhaseSnapshot(stateDir: string, teamName: string, nowIso: string) {
  const phasePath = join(stateDir, 'team', teamName, 'phase.json');
  try {
    if (!existsSync(phasePath)) return { currentPhase: '', terminal: false, completedAt: '' };
    const parsed = JSON.parse(await readFile(phasePath, 'utf-8'));
    const currentPhase = safeString(parsed && parsed.current_phase).trim();
    return {
      currentPhase,
      terminal: isTerminalPhase(currentPhase),
      completedAt: resolveTerminalAtFromPhaseDoc(parsed, nowIso),
    };
  } catch {
    return { currentPhase: '', terminal: false, completedAt: '' };
  }
}

async function syncScopedTeamStateFromPhase(
  teamStatePath: string,
  teamName: string,
  phaseSnapshot: { terminal: boolean; currentPhase: string; completedAt: string },
  nowIso: string,
) {
  if (!phaseSnapshot || !phaseSnapshot.terminal) return false;
  try {
    if (!existsSync(teamStatePath)) return false;
    const parsed = JSON.parse(await readFile(teamStatePath, 'utf-8'));
    if (!parsed || safeString(parsed.team_name).trim() !== teamName) return false;

    let changed = false;
    if (parsed.active !== false) {
      parsed.active = false;
      changed = true;
    }
    if (safeString(parsed.current_phase).trim() !== phaseSnapshot.currentPhase) {
      parsed.current_phase = phaseSnapshot.currentPhase;
      changed = true;
    }
    if (safeString(parsed.completed_at).trim() !== phaseSnapshot.completedAt && phaseSnapshot.completedAt) {
      parsed.completed_at = phaseSnapshot.completedAt;
      changed = true;
    }
    if (safeString(parsed.last_turn_at).trim() !== nowIso) {
      parsed.last_turn_at = nowIso;
      changed = true;
    }

    if (changed) {
      await writeFile(teamStatePath, JSON.stringify(parsed, null, 2));
    }
    return changed;
  } catch {
    return false;
  }
}

async function resolveCurrentSessionId(stateDir: string) {
  const fromEnv = safeString(
    process.env.OMX_SESSION_ID
    || process.env.CODEX_SESSION_ID
    || process.env.SESSION_ID
    || '',
  ).trim();
  if (fromEnv) return fromEnv;

  const sessionPath = join(stateDir, 'session.json');
  try {
    if (!existsSync(sessionPath)) return '';
    const parsed = JSON.parse(await readFile(sessionPath, 'utf-8'));
    const sessionId = safeString(parsed && parsed.session_id ? parsed.session_id : '').trim();
    return sessionId;
  } catch {
    return '';
  }
}

async function readWorkerStatusSnapshot(stateDir: string, teamName: string, workerName: string): Promise<WorkerStatusSnapshot> {
  if (!workerName) return { state: 'unknown', current_task_id: '' };
  const path = join(stateDir, 'team', teamName, 'workers', workerName, 'status.json');
  try {
    if (!existsSync(path)) return { state: 'unknown', current_task_id: '', missing: true };
    const parsed = JSON.parse(await readFile(path, 'utf-8'));
    return {
      state: safeString(parsed && parsed.state ? parsed.state : 'unknown') || 'unknown',
      current_task_id: safeString(parsed && parsed.current_task_id ? parsed.current_task_id : '').trim(),
      missing: false,
    };
  } catch {
    return { state: 'unknown', current_task_id: '', missing: false };
  }
}

async function readWorkerStatusState(stateDir: string, teamName: string, workerName: string) {
  const snapshot = await readWorkerStatusSnapshot(stateDir, teamName, workerName);
  return snapshot.state;
}

async function readWorkerHeartbeatSnapshot(stateDir: string, teamName: string, workerName: string): Promise<WorkerHeartbeatSnapshot> {
  if (!workerName) return { turn_count: null, missing: true };
  const path = join(stateDir, 'team', teamName, 'workers', workerName, 'heartbeat.json');
  try {
    if (!existsSync(path)) return { turn_count: null, missing: true };
    const parsed = JSON.parse(await readFile(path, 'utf-8'));
    return {
      turn_count: Number.isFinite(parsed?.turn_count) ? parsed.turn_count : null,
      missing: false,
    };
  } catch {
    return { turn_count: null, missing: false };
  }
}

async function readTeamTaskProgressSnapshot(stateDir: string, teamName: string): Promise<TeamTaskProgressSnapshot> {
  const tasksDir = join(stateDir, 'team', teamName, 'tasks');
  if (!existsSync(tasksDir)) {
    return {
      taskCounts: { pending: 0, blocked: 0, in_progress: 0, completed: 0, failed: 0 },
      taskSignature: [],
      workRemaining: false,
    };
  }

  const taskCounts = { pending: 0, blocked: 0, in_progress: 0, completed: 0, failed: 0 };
  const taskSignature = [];
  try {
    const taskFiles = (await readdir(tasksDir))
      .filter((entry) => /^task-\d+\.json$/.test(entry))
      .sort();
    for (const entry of taskFiles) {
      try {
        const parsed = JSON.parse(await readFile(join(tasksDir, entry), 'utf-8'));
        const id = safeString(parsed?.id || entry.replace(/^task-/, '').replace(/\.json$/, '')).trim();
        const status = safeString(parsed?.status || 'pending').trim() || 'pending';
        const owner = safeString(parsed?.owner || '').trim();
        if (Object.hasOwn(taskCounts, status)) taskCounts[status as keyof typeof taskCounts] += 1;
        taskSignature.push({ id, owner, status });
      } catch {
        // ignore malformed task files
      }
    }
  } catch {
    // ignore task-read failures
  }

  return {
    taskCounts,
    taskSignature,
    workRemaining: taskCounts.pending > 0 || taskCounts.blocked > 0 || taskCounts.in_progress > 0,
  };
}

async function readTeamProgressSnapshot(stateDir: string, teamName: string, workerNames: string[]): Promise<TeamProgressSnapshot> {
  const [taskSnapshot, workerSnapshot] = await Promise.all([
    readTeamTaskProgressSnapshot(stateDir, teamName),
    Promise.all(
      workerNames.map(async (workerName) => {
        const [status, heartbeat] = await Promise.all([
          readWorkerStatusSnapshot(stateDir, teamName, workerName),
          readWorkerHeartbeatSnapshot(stateDir, teamName, workerName),
        ]);
        return {
          worker: workerName,
          state: status.state,
          current_task_id: status.current_task_id,
          status_missing: status.missing === true,
          turn_count: heartbeat.turn_count,
          heartbeat_missing: heartbeat.missing === true,
        };
      }),
    ),
  ]);

  const missingSignalWorkers = workerSnapshot.filter(
    ({ status_missing, heartbeat_missing }) => status_missing || heartbeat_missing,
  ).length;

  return {
    ...taskSnapshot,
    workerSnapshot,
    missingSignalWorkers,
    signature: JSON.stringify({
      tasks: taskSnapshot.taskSignature,
      workers: workerSnapshot,
    }),
  };
}

function readPreviousWorkerTurnCounts(previousSignature: string): Map<string, number | null> {
  try {
    const parsed = JSON.parse(previousSignature || '{}');
    const workers = Array.isArray(parsed?.workers) ? parsed.workers : [];
    return new Map(workers
      .map((worker: WorkerProgressSnapshot) => [safeString(worker?.worker).trim(), Number.isFinite(worker?.turn_count) ? Number(worker.turn_count) : null] as const)
      .filter((entry: readonly [string, number | null]) => entry[0].length > 0));
  } catch {
    return new Map();
  }
}

function hasWorkerTurnProgress(workerSnapshot: WorkerProgressSnapshot[], previousTurnCounts: Map<string, number | null>) {
  return workerSnapshot.some((worker) => {
    if (worker.state !== 'working' && worker.state !== 'blocked') return false;
    if (!Number.isFinite(worker.turn_count) || worker.turn_count === null) return false;
    const previousTurnCount = previousTurnCounts.get(worker.worker);
    return previousTurnCount !== undefined && previousTurnCount !== null && Number.isFinite(previousTurnCount) && worker.turn_count > previousTurnCount;
  });
}

function hasTrackableActiveWorkerTurns(workerSnapshot: WorkerProgressSnapshot[], previousTurnCounts: Map<string, number | null>) {
  return workerSnapshot.some((worker) => {
    if (worker.state !== 'working' && worker.state !== 'blocked') return false;
    if (!Number.isFinite(worker.turn_count) || worker.turn_count === null) return false;
    const previousTurnCount = previousTurnCounts.get(worker.worker);
    return previousTurnCount !== undefined && previousTurnCount !== null && Number.isFinite(previousTurnCount);
  });
}

function formatDurationMs(durationMs: number) {
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m${remainingSeconds}s`;
}

function normalizeMailboxMessages(rawMailbox: unknown): MailboxMessage[] {
  if (Array.isArray(rawMailbox)) return rawMailbox as MailboxMessage[];
  if (rawMailbox && typeof rawMailbox === 'object' && Array.isArray((rawMailbox as { messages?: unknown[] }).messages)) {
    return (rawMailbox as { messages: MailboxMessage[] }).messages;
  }
  return [];
}

function normalizeMessageIdentity(msg: MailboxMessage | null): string {
  if (!msg || typeof msg !== 'object') return '';
  const explicitId = safeString(msg.message_id || '').trim();
  if (explicitId) return explicitId;
  const createdAt = safeString(msg.created_at || msg.timestamp || '').trim();
  const from = safeString(msg.from_worker || msg.from || '').trim();
  const body = safeString(msg.body || '').trim();
  return [createdAt, from, body].filter(Boolean).join('|');
}

function normalizeMailboxBody(body: unknown): string {
  return safeString(body).replace(/\s+/g, ' ').trim();
}

function isAckLikeMailboxBody(body: unknown): boolean {
  const normalized = normalizeMailboxBody(body);
  if (!normalized) return false;
  return ACK_LIKE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function formatMailboxBodyForLeader(body: unknown, maxLength = 40): string {
  const normalized = normalizeMailboxBody(body);
  if (!normalized) return 'ack-like update';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

async function workerHasOwnedStartedTask(stateDir: string, teamName: string, workerName: string) {
  const tasksDir = join(stateDir, 'team', teamName, 'tasks');
  if (!existsSync(tasksDir)) return false;

  try {
    const taskFiles = (await readdir(tasksDir))
      .filter((entry) => /^task-\d+\.json$/.test(entry))
      .sort();
    for (const entry of taskFiles) {
      try {
        const parsed = JSON.parse(await readFile(join(tasksDir, entry), 'utf-8'));
        if (safeString(parsed?.owner).trim() !== workerName) continue;
        const status = safeString(parsed?.status).trim();
        if (status === 'in_progress' || status === 'completed' || status === 'failed') return true;
      } catch {
        // ignore malformed task files
      }
    }
  } catch {
    return false;
  }

  return false;
}

async function getAckWithoutStartEvidence(stateDir: string, teamName: string, msg: MailboxMessage | null) {
  if (!msg || typeof msg !== 'object') return null;
  const fromWorker = safeString(msg.from_worker || '').trim();
  if (!fromWorker || fromWorker === 'leader-fixed') return null;
  if (!isAckLikeMailboxBody(msg.body)) return null;

  const status = await readWorkerStatusSnapshot(stateDir, teamName, fromWorker);
  if (
    status.current_task_id
    || status.state === 'working'
    || status.state === 'blocked'
    || status.state === 'done'
    || status.state === 'failed'
  ) {
    return null;
  }

  if (await workerHasOwnedStartedTask(stateDir, teamName, fromWorker)) {
    return null;
  }

  return {
    worker: fromWorker,
    body: formatMailboxBodyForLeader(msg.body),
    statusState: status.state,
  };
}

export async function emitTeamNudgeEvent(cwd: string, teamName: string, reason: string, nowIso: string) {
  const eventsDir = join(cwd, '.omx', 'state', 'team', teamName, 'events');
  const eventsPath = join(eventsDir, 'events.ndjson');
  try {
    await mkdir(eventsDir, { recursive: true });
    const event = {
      event_id: `nudge-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      team: teamName,
      type: 'team_leader_nudge',
      worker: 'leader-fixed',
      reason,
      created_at: nowIso,
    };
    await appendFile(eventsPath, JSON.stringify(event) + '\n');
  } catch {
    // Best effort
  }
}

async function emitLeaderNudgeDeferredEvent(
  cwd: string,
  teamName: string,
  reason: string,
  nowIso: string,
  { tmuxSession = '', leaderPaneId = '', paneCurrentCommand = '', sourceType = 'leader_nudge' }: { tmuxSession?: string; leaderPaneId?: string; paneCurrentCommand?: string; sourceType?: string } = {},
) {
  const eventsDir = join(cwd, '.omx', 'state', 'team', teamName, 'events');
  const eventsPath = join(eventsDir, 'events.ndjson');
  try {
    await mkdir(eventsDir, { recursive: true });
    const event = {
      event_id: `leader-deferred-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      team: teamName,
      type: LEADER_NOTIFICATION_DEFERRED_TYPE,
      worker: 'leader-fixed',
      to_worker: 'leader-fixed',
      reason,
      created_at: nowIso,
      tmux_session: tmuxSession || null,
      leader_pane_id: leaderPaneId || null,
      tmux_injection_attempted: false,
      pane_current_command: paneCurrentCommand || null,
      source_type: sourceType,
    };
    await appendFile(eventsPath, JSON.stringify(event) + '\n');
  } catch {
    // Best effort
  }
}

export async function maybeNudgeTeamLeader({ cwd, stateDir, logsDir, preComputedLeaderStale }: MaybeNudgeTeamLeaderArgs) {
  const intervalMs = resolveLeaderNudgeIntervalMs();
  const idleCooldownMs = resolveLeaderAllIdleNudgeCooldownMs();
  const fallbackProgressStallThresholdMs = resolveFallbackProgressStallThresholdMs();
  const workerTurnStallThresholdMs = resolveWorkerTurnStallThresholdMs();
  const nowMs = Date.now();
  const nowIso = new Date().toISOString();
  const omxDir = join(cwd, '.omx');
  const nudgeStatePath = join(stateDir, 'team-leader-nudge.json');

  let nudgeState: NudgeState = (await readJsonIfExists(nudgeStatePath, null) as NudgeState | null) || {
    last_nudged_by_team: {},
    last_idle_nudged_by_team: {},
    progress_by_team: {},
  };
  if (!nudgeState.last_nudged_by_team || typeof nudgeState.last_nudged_by_team !== 'object') {
    nudgeState.last_nudged_by_team = {};
  }
  if (!nudgeState.last_idle_nudged_by_team || typeof nudgeState.last_idle_nudged_by_team !== 'object') {
    nudgeState.last_idle_nudged_by_team = {};
  }
  if (!nudgeState.progress_by_team || typeof nudgeState.progress_by_team !== 'object') {
    nudgeState.progress_by_team = {};
  }

  const candidateTeamNames = new Set<string>();
  const currentSessionId = await resolveCurrentSessionId(stateDir);
  try {
    const scopedDirs = await getScopedStateDirsForCurrentSession(stateDir);
    const candidateStateDirs = [...new Set([...scopedDirs, stateDir])];
    for (const scopedDir of candidateStateDirs) {
      const teamStatePath = join(scopedDir, 'team-state.json');
      if (!existsSync(teamStatePath)) continue;
      const parsed = JSON.parse(await readFile(teamStatePath, 'utf-8'));
      if (!parsed) continue;
      const teamName = safeString(parsed.team_name || '').trim();
      if (!teamName) continue;

      const phaseSnapshot = await readTeamPhaseSnapshot(stateDir, teamName, nowIso);
      if (phaseSnapshot.terminal) {
        await syncScopedTeamStateFromPhase(teamStatePath, teamName, phaseSnapshot, nowIso);
        continue;
      }
      if (parsed.active === true) {
        candidateTeamNames.add(teamName);
      }
    }
  } catch {
    // Non-critical
  }

  // Use pre-computed staleness (captured before HUD state was updated this turn)
  const leaderStale = typeof preComputedLeaderStale === 'boolean' ? preComputedLeaderStale : false;

  for (const teamName of candidateTeamNames) {
    let tmuxSession = '';
    let leaderPaneId = '';
    let ownerSessionId = '';
    let workers: TeamWorkerConfig[] = [];
    try {
      const manifestPath = join(omxDir, 'state', 'team', teamName, 'manifest.v2.json');
      const configPath = join(omxDir, 'state', 'team', teamName, 'config.json');
      const srcPath = existsSync(manifestPath) ? manifestPath : configPath;
      if (existsSync(srcPath)) {
        const raw = JSON.parse(await readFile(srcPath, 'utf-8'));
        tmuxSession = safeString(raw && raw.tmux_session ? raw.tmux_session : '').trim();
        leaderPaneId = safeString(raw && raw.leader_pane_id ? raw.leader_pane_id : '').trim();
        ownerSessionId = safeString(raw && raw.leader && raw.leader.session_id ? raw.leader.session_id : '').trim();
        if (Array.isArray(raw && raw.workers)) workers = raw.workers;
      }
    } catch {
      // ignore
    }
    if (currentSessionId && ownerSessionId && ownerSessionId !== currentSessionId) continue;
    let mailbox: { messages?: MailboxMessage[] } | MailboxMessage[] | null = null;
    try {
      const mailboxPath = join(omxDir, 'state', 'team', teamName, 'mailbox', 'leader-fixed.json');
      mailbox = await readJsonIfExists(mailboxPath, null);
    } catch {
      mailbox = null;
    }
    const messages = normalizeMailboxMessages(mailbox);
    const newest = messages.length > 0 ? messages[messages.length - 1] : null;
    const newestId = normalizeMessageIdentity(newest);

    const workerNames = Array.isArray(workers)
      ? workers.map((w) => safeString(w && w.name ? w.name : '')).filter(Boolean)
      : [];
    const workerPaneIds = Array.isArray(workers)
      ? workers.map((w) => safeString(w && w.pane_id ? w.pane_id : '')).filter(Boolean)
      : [];
    const canonicalLeaderPaneId = safeString(leaderPaneId).trim();
    const traceId = leaderNudgeTraceId(teamName, nowIso);
    if (!tmuxSession && !canonicalLeaderPaneId) continue;
    await decisionTrace(cwd, 'leader_nudge.team_state', {
      trace_id: traceId,
      team_name: teamName,
      session_name: tmuxSession,
      leader_pane_id: canonicalLeaderPaneId,
      owner_session_id: ownerSessionId,
      current_session_id: currentSessionId,
      worker_count: workerNames.length,
      result: 'loaded',
    });
    const tmuxTarget = canonicalLeaderPaneId;
    const workerStates = workerNames.length > 0
      ? await Promise.all(workerNames.map((workerName) => readWorkerStatusState(stateDir, teamName, workerName)))
      : [];
    const allWorkersIdle = workerStates.length > 0 && workerStates.every((state) => state === 'idle' || state === 'done');
    const progressSnapshot = await readTeamProgressSnapshot(stateDir, teamName, workerNames);
    const prevProgress = nudgeState.progress_by_team[teamName] && typeof nudgeState.progress_by_team[teamName] === 'object'
      ? nudgeState.progress_by_team[teamName]
      : {};
    const previousSignature = safeString(prevProgress.signature || '');
    const previousProgressAtIso = safeString(prevProgress.last_progress_at || '');
    const previousProgressAtMs = previousProgressAtIso ? Date.parse(previousProgressAtIso) : NaN;
    const previousTurnCounts = readPreviousWorkerTurnCounts(previousSignature);
    const workerTurnProgress = hasWorkerTurnProgress(progressSnapshot.workerSnapshot, previousTurnCounts);
    const hasTrackableTurnSignals = hasTrackableActiveWorkerTurns(progressSnapshot.workerSnapshot, previousTurnCounts);
    const progressChanged = !previousSignature || previousSignature !== progressSnapshot.signature || workerTurnProgress;
    const effectiveProgressAtMs = progressChanged || !Number.isFinite(previousProgressAtMs)
      ? nowMs
      : previousProgressAtMs;
    const effectiveProgressAtIso = new Date(effectiveProgressAtMs).toISOString();
    const stalledForMs = Math.max(0, nowMs - effectiveProgressAtMs);
    const stallThresholdMs = hasTrackableTurnSignals ? workerTurnStallThresholdMs : fallbackProgressStallThresholdMs;

    const prev = nudgeState.last_nudged_by_team[teamName] && typeof nudgeState.last_nudged_by_team[teamName] === 'object'
      ? nudgeState.last_nudged_by_team[teamName]
      : {};
    const prevAtIso = safeString(prev.at || '');
    const prevAtMs = prevAtIso ? Date.parse(prevAtIso) : NaN;
    const prevMsgId = safeString(prev.last_message_id || '');
    const prevReason = safeString(prev.reason || '');

    const hasNewMessage = newestId && newestId !== prevMsgId;
    const dueByTime = !Number.isFinite(prevAtMs) || (nowMs - prevAtMs >= intervalMs);
    const ackWithoutStartEvidence = hasNewMessage
      ? await getAckWithoutStartEvidence(stateDir, teamName, newest)
      : null;

    let paneStatus = { alive: false, paneCount: 0, relevantLines: [] as string[] };
    let workerPanesReusable = false;
    const shouldProbeWorkerPanes =
      Boolean(tmuxSession)
      && !ackWithoutStartEvidence
      && (allWorkersIdle || leaderStale || progressSnapshot.workRemaining);
    if (shouldProbeWorkerPanes) {
      paneStatus = await checkWorkerPanesAlive(tmuxSession, workerPaneIds);
      workerPanesReusable = paneStatus.alive && workerPaneIds.length > 0;
    }
    await decisionTrace(cwd, 'leader_nudge.worker_panes_alive', {
      trace_id: traceId,
      team_name: teamName,
      session_name: tmuxSession,
      worker_pane_ids: workerPaneIds,
      pane_count: paneStatus.paneCount,
      alive: paneStatus.alive,
      reusable: workerPanesReusable,
      key_inputs: paneStatus.relevantLines || [],
      result: shouldProbeWorkerPanes
        ? (paneStatus.alive ? 'alive' : 'not_alive')
        : 'not_needed',
    });
    const teamProgressStalled =
      progressSnapshot.workRemaining
      && paneStatus.alive
      && !allWorkersIdle
      && !progressChanged
      && stalledForMs >= stallThresholdMs;
    await decisionTrace(cwd, 'leader_nudge.classification_inputs', {
      trace_id: traceId,
      team_name: teamName,
      session_name: tmuxSession,
      all_workers_idle: allWorkersIdle,
      worker_panes_alive: paneStatus.alive,
      worker_panes_reusable: workerPanesReusable,
      worker_pane_ids_configured: workerPaneIds.length > 0,
      task_counts: progressSnapshot.taskCounts,
      team_progress_stalled: teamProgressStalled,
      result: 'observed',
    });
    const leaderActionState = classifyLeaderActionState({
      allWorkersIdle,
      workerPanesAlive: paneStatus.alive,
      workerPanesReusable,
      workerPaneIdsConfigured: workerPaneIds.length > 0,
      taskCounts: progressSnapshot.taskCounts,
      teamProgressStalled,
    });
    const leaderActionGuidance = buildLeaderActionGuidance(teamName, {
      allWorkersIdle,
      workerPanesAlive: paneStatus.alive,
      workerPanesReusable,
      taskCounts: progressSnapshot.taskCounts,
      leaderActionState,
    });
    await decisionTrace(cwd, 'leader_nudge.classification_result', {
      trace_id: traceId,
      team_name: teamName,
      session_name: tmuxSession,
      leader_action_state: leaderActionState,
      guidance: leaderActionGuidance,
      result: 'classified',
    });
    nudgeState.progress_by_team[teamName] = {
      signature: progressSnapshot.signature,
      last_progress_at: effectiveProgressAtIso,
      observed_at: nowIso,
      missing_signal_workers: progressSnapshot.missingSignalWorkers,
      work_remaining: progressSnapshot.workRemaining,
      leader_action_state: leaderActionState,
    };
    const prevIdle = nudgeState.last_idle_nudged_by_team[teamName] && typeof nudgeState.last_idle_nudged_by_team[teamName] === 'object'
      ? nudgeState.last_idle_nudged_by_team[teamName]
      : {};
    const prevIdleAtIso = safeString(prevIdle.at || '');
    const prevIdleAtMs = prevIdleAtIso ? Date.parse(prevIdleAtIso) : NaN;
    const dueByIdleCooldown = !Number.isFinite(prevIdleAtMs) || (nowMs - prevIdleAtMs >= idleCooldownMs);
    const shouldSendAllIdleNudge = allWorkersIdle && dueByIdleCooldown;

    // Stale-leader follow-up is the only periodic visible nudge path.
    // This keeps the leader pane quieter when the leader is not actually stale.
    const stalePanesNudge = paneStatus.alive && leaderStale;
    const previousStalledTeamNudge = prevReason === 'stuck_waiting_on_leader';
    const stalledTeamNudge = teamProgressStalled && (dueByTime || !previousStalledTeamNudge);
    const staleFollowupDue = stalePanesNudge && dueByTime;

    if (!shouldSendAllIdleNudge && !hasNewMessage && !stalledTeamNudge && !staleFollowupDue) continue;
    await decisionTrace(cwd, 'leader_nudge.precheck', {
      trace_id: traceId,
      team_name: teamName,
      session_name: tmuxSession,
      leader_pane_id: leaderPaneId,
      all_workers_idle: allWorkersIdle,
      has_new_message: hasNewMessage,
      stalled_team_nudge: stalledTeamNudge,
      stale_followup_due: staleFollowupDue,
      leader_stale: leaderStale,
      result: 'candidate',
    });

    let nudgeReason = '';
    let text = '';
    if (shouldSendAllIdleNudge) {
      nudgeReason = leaderActionState === 'done_waiting_on_leader'
        ? 'done_waiting_on_leader'
        : leaderActionState === 'stuck_waiting_on_leader'
          ? 'stuck_waiting_on_leader'
          : 'all_workers_idle';
      const N = workerNames.length;
      const waitingText = leaderActionState === 'done_waiting_on_leader'
        ? ` Team ${teamName} is complete and waiting on leader action.`
        : leaderActionState === 'stuck_waiting_on_leader'
          ? ` Team ${teamName} is stuck and waiting on leader action.`
          : '';
      text = `[OMX] All ${N} worker${N === 1 ? '' : 's'} idle.${waitingText} ${leaderActionGuidance}`;
    } else if (ackWithoutStartEvidence) {
      nudgeReason = ACK_WITHOUT_START_EVIDENCE_REASON;
      text =
        `Team ${teamName}: ${ackWithoutStartEvidence.worker} said "${ackWithoutStartEvidence.body}" `
        + `but has no start evidence (status: ${ackWithoutStartEvidence.statusState}). `
        + buildWorkerStartEvidenceReminder(teamName, ackWithoutStartEvidence.worker);
    } else if (stalledTeamNudge) {
      nudgeReason = 'stuck_waiting_on_leader';
      const { pending, in_progress, blocked } = progressSnapshot.taskCounts;
      const missingSignals = progressSnapshot.missingSignalWorkers > 0
        ? `; ${progressSnapshot.missingSignalWorkers} signal${progressSnapshot.missingSignalWorkers === 1 ? '' : 's'} missing`
        : '';
      const stallPrefix = leaderStale ? 'leader stale, ' : 'worker panes stalled, ';
      text =
        `Team ${teamName}: ${stallPrefix}no progress ${formatDurationMs(stalledForMs)}. `
        + `${leaderActionGuidance} `
        + `(p:${pending} ip:${in_progress} b:${blocked}${missingSignals})`;
    } else if (stalePanesNudge && hasNewMessage) {
      nudgeReason = 'stale_leader_with_messages';
      text =
        `Team ${teamName}: leader stale, ${paneStatus.paneCount} pane(s) active, ${messages.length} msg(s) pending. `
        + buildMailboxCheckReminder(teamName);
    } else if (staleFollowupDue) {
      nudgeReason = 'stale_leader_panes_alive';
      text =
        `Team ${teamName}: leader stale, ${paneStatus.paneCount} worker pane(s) still active. `
        + leaderActionGuidance;
    } else if (hasNewMessage) {
      nudgeReason = 'new_mailbox_message';
      text = `Team ${teamName}: ${messages.length} msg(s) for leader. ${buildMailboxCheckReminder(teamName)}`;
    } else {
      continue;
    }
    const capped = text.length > 180 ? `${text.slice(0, 177)}...` : text;
    const markedText = `${capped} ${DEFAULT_MARKER}`;

    if (!tmuxTarget) {
      nudgeState.last_nudged_by_team[teamName] = { at: nowIso, last_message_id: newestId || prevMsgId || '', reason: nudgeReason };
      if (shouldSendAllIdleNudge) {
        nudgeState.last_idle_nudged_by_team[teamName] = { at: nowIso, worker_count: workerNames.length };
      }
      await emitLeaderNudgeDeferredEvent(cwd, teamName, LEADER_PANE_MISSING_NO_INJECTION_REASON, nowIso, {
        tmuxSession,
        leaderPaneId,
        sourceType: 'leader_nudge',
      });
      try {
        await logTmuxHookEvent(logsDir, {
          timestamp: nowIso,
          type: LEADER_NOTIFICATION_DEFERRED_TYPE,
          team: teamName,
          worker: 'leader-fixed',
          to_worker: 'leader-fixed',
          reason: LEADER_PANE_MISSING_NO_INJECTION_REASON,
          leader_pane_id: leaderPaneId || null,
          tmux_session: tmuxSession || null,
          tmux_injection_attempted: false,
          source_type: 'leader_nudge',
        });
      } catch { /* ignore */ }
      await decisionTrace(cwd, 'leader_nudge.decision', {
        trace_id: traceId,
        team_name: teamName,
        pane_target: '',
        session_name: tmuxSession,
        reason: LEADER_PANE_MISSING_NO_INJECTION_REASON,
        result: 'deferred',
      });
      continue;
    }

    await decisionTrace(cwd, 'leader_nudge.guard_start', {
      trace_id: traceId,
      team_name: teamName,
      pane_target: tmuxTarget,
      session_name: tmuxSession,
      result: 'start',
    });
    const paneGuard = await evaluatePaneInjectionReadiness(tmuxTarget, {
      skipIfScrolling: true,
      preferCanonicalBypass: false,
    });
    await decisionTrace(cwd, 'leader_nudge.guard_result', {
      trace_id: traceId,
      team_name: teamName,
      pane_target: tmuxTarget,
      session_name: tmuxSession,
      reason: safeString(paneGuard.reason).trim(),
      pane_current_command: safeString(paneGuard.paneCurrentCommand).trim(),
      result: paneGuard.ok ? 'ok' : 'blocked',
    });
    if (!paneGuard.ok) {
      const deferredReason = paneGuard.reason === 'pane_running_shell'
        ? LEADER_PANE_SHELL_NO_INJECTION_REASON
        : paneGuard.reason;
      nudgeState.last_nudged_by_team[teamName] = { at: nowIso, last_message_id: newestId || prevMsgId || '', reason: nudgeReason };
      if (shouldSendAllIdleNudge) {
        nudgeState.last_idle_nudged_by_team[teamName] = { at: nowIso, worker_count: workerNames.length };
      }
      await emitLeaderNudgeDeferredEvent(cwd, teamName, deferredReason, nowIso, {
        tmuxSession,
        leaderPaneId,
        paneCurrentCommand: paneGuard.paneCurrentCommand,
        sourceType: 'leader_nudge',
      });
      try {
        await logTmuxHookEvent(logsDir, {
          timestamp: nowIso,
          type: LEADER_NOTIFICATION_DEFERRED_TYPE,
          team: teamName,
          worker: 'leader-fixed',
          to_worker: 'leader-fixed',
          reason: deferredReason,
          leader_pane_id: leaderPaneId || null,
          tmux_session: tmuxSession || null,
          tmux_injection_attempted: false,
          pane_current_command: paneGuard.paneCurrentCommand || null,
          injection_skip_reason: paneGuard.reason,
          source_type: 'leader_nudge',
        });
      } catch { /* ignore */ }
      await decisionTrace(cwd, 'leader_nudge.decision', {
        trace_id: traceId,
        team_name: teamName,
        pane_target: tmuxTarget,
        session_name: tmuxSession,
        reason: deferredReason,
        pane_current_command: paneGuard.paneCurrentCommand,
        result: 'deferred',
      });
      continue;
    }

    try {
      await decisionTrace(cwd, 'leader_nudge.send_attempt', {
        trace_id: traceId,
        team_name: teamName,
        pane_target: tmuxTarget,
        session_name: tmuxSession,
        reason: nudgeReason,
        result: 'start',
      });
      const sendResult = await sendPaneInput({
        paneTarget: tmuxTarget,
        prompt: markedText,
        submitKeyPresses: 2,
        submitDelayMs: 100,
      });
      if (!sendResult.ok) {
        throw new Error(sendResult.error || sendResult.reason);
      }
      nudgeState.last_nudged_by_team[teamName] = { at: nowIso, last_message_id: newestId || prevMsgId || '', reason: nudgeReason };
      if (shouldSendAllIdleNudge) {
        nudgeState.last_idle_nudged_by_team[teamName] = { at: nowIso, worker_count: workerNames.length };
      }

      await emitTeamNudgeEvent(cwd, teamName, nudgeReason, nowIso);

      try {
        await logTmuxHookEvent(logsDir, {
          timestamp: nowIso,
          type: 'team_leader_nudge',
          team: teamName,
          tmux_target: tmuxTarget,
          reason: nudgeReason,
          pane_count: paneStatus.paneCount,
          leader_stale: leaderStale,
          message_count: messages.length,
          stalled_for_ms: teamProgressStalled ? stalledForMs : undefined,
          missing_signal_workers: progressSnapshot.missingSignalWorkers,
        });
      } catch { /* ignore */ }
      await decisionTrace(cwd, 'leader_nudge.decision', {
        trace_id: traceId,
        team_name: teamName,
        pane_target: tmuxTarget,
        session_name: tmuxSession,
        reason: nudgeReason,
        result: 'sent',
      });
    } catch (err: unknown) {
      try {
        await logTmuxHookEvent(logsDir, {
          timestamp: nowIso,
          type: 'team_leader_nudge',
          team: teamName,
          tmux_target: tmuxTarget,
          reason: nudgeReason,
          error: errorMessage(err),
        });
      } catch { /* ignore */ }
      await decisionTrace(cwd, 'leader_nudge.decision', {
        trace_id: traceId,
        team_name: teamName,
        pane_target: tmuxTarget,
        session_name: tmuxSession,
        reason: nudgeReason,
        error: errorMessage(err),
        result: 'error',
      });
    }
  }

  await writeFile(nudgeStatePath, JSON.stringify(nudgeState, null, 2)).catch(() => {});
}
