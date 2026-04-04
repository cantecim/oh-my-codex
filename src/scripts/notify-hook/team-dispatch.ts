import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'node:url';
import { safeString } from './utils.js';
import { resolveBridgeStateDir, resolveRuntimeBinaryPath } from '../../runtime/bridge.js';
import { buildRuntimeTraceId, traceDecision as appendRuntimeDecisionTrace } from '../../debug/runtime-trace.js';

const __filename = fileURLToPath(import.meta.url);
void dirname(__filename);
import { runProcessWithTrace } from './process-runner.js';
import { resolvePaneTarget } from './tmux-injection.js';
import { evaluatePaneInjectionReadiness, sendPaneInput } from './team-tmux-guard.js';
import {
  buildCapturePaneArgv,
  normalizeTmuxCapture,
  paneHasActiveTask,
  paneLooksReady,
} from '../tmux-hook-engine.js';

interface DispatchRequest {
  request_id: string;
  kind: string;
  team_name: string;
  to_worker: string;
  worker_index?: number;
  pane_id?: string;
  trigger_message: string;
  message_id?: string;
  inbox_correlation_key?: string;
  transport_preference: string;
  fallback_allowed: boolean;
  status: string;
  attempt_count: number;
  created_at: string;
  updated_at: string;
  notified_at?: string;
  delivered_at?: string;
  failed_at?: string;
  last_reason?: string;
}

interface DispatchWorkerConfig {
  index?: number;
  pane_id?: string;
  worker_cli?: string;
}

interface DispatchConfig {
  leader_pane_id?: string;
  tmux_session?: string;
  workers?: DispatchWorkerConfig[];
}

interface TriggerCooldownEntry {
  at: number;
  lastRequestId: string;
}

interface InjectTarget {
  type: 'pane' | 'session';
  value: string;
}

interface InjectResult {
  ok: boolean;
  reason: string;
  pane?: string;
}

interface LeaderDeferredEventArgs {
  stateDir: string;
  teamName: string;
  request: DispatchRequest;
  reason: string;
  nowIso: string;
  tmuxSession?: string;
  leaderPaneId?: string;
  sourceType?: string;
}

interface DrainPendingTeamDispatchOptions {
  cwd?: string;
  stateDir?: string;
  logsDir?: string;
  maxPerTick?: number;
  injector?: (request: DispatchRequest, config: DispatchConfig, cwd: string, stateDir: string) => Promise<InjectResult>;
}

interface BridgeDispatchState {
  records: unknown[];
}

interface IssueCooldownState {
  by_issue: Record<string, number>;
}

interface StoredTriggerCooldownEntry {
  at?: number;
  last_request_id?: string;
}

interface TriggerCooldownState {
  by_trigger: Record<string, number | StoredTriggerCooldownEntry>;
}

interface MailboxMessage {
  message_id?: string;
  notified_at?: string;
}

interface MailboxState {
  worker: string;
  messages: MailboxMessage[];
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? safeString((error as { code?: unknown }).code) : '';
}

/**
 * Route dispatch state transitions through the Rust runtime binary.
 * Non-fatal: if the binary is missing or fails, the legacy JSON fallback lane
 * remains available when the caller is already operating outside the bridge-
 * owned path.
 * Disable entirely with OMX_RUNTIME_BRIDGE=0.
 */
function runtimeExec(command: Record<string, unknown>, stateDir: string) {
  if (process.env.OMX_RUNTIME_BRIDGE === '0') return;
  try {
    const binaryPath = resolveRuntimeBinaryPath();
    execFileSync(binaryPath, ['exec', JSON.stringify(command), `--state-dir=${stateDir}`], {
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch {
    // non-fatal: JS path is the fallback
  }
}

function readJson<T>(path: string, fallback: T): Promise<T> {
  return readFile(path, 'utf8')
    .then((raw) => JSON.parse(raw) as T)
    .catch(() => fallback);
}

async function readBridgeDispatchRequests(stateDir: string, teamName: string): Promise<DispatchRequest[] | null> {
  const candidate = join(stateDir, 'dispatch.json');
  if (!existsSync(candidate)) return null;
  const parsed = await readJson<BridgeDispatchState | null>(candidate, null);
  if (!parsed || !Array.isArray(parsed.records)) return null;
  return parsed.records
    .map((record: unknown) => {
      if (!record || typeof record !== 'object') return null;
      const normalizedRecord = record as Record<string, unknown>;
      const metadata = normalizedRecord.metadata && typeof normalizedRecord.metadata === 'object'
        ? normalizedRecord.metadata as Record<string, unknown>
        : {};
      const metadataTeam = safeString(metadata.team_name).trim();
      if (metadataTeam && metadataTeam !== teamName) return null;
      const normalizedDispatchRecord: DispatchRequest = {
        request_id: safeString(normalizedRecord.request_id).trim(),
        kind: safeString(metadata.kind).trim() || 'inbox',
        team_name: teamName,
        to_worker: safeString(normalizedRecord.target).trim(),
        worker_index: typeof metadata.worker_index === 'number' ? metadata.worker_index : undefined,
        pane_id: safeString(metadata.pane_id).trim() || undefined,
        trigger_message: safeString(metadata.trigger_message).trim() || safeString(normalizedRecord.reason).trim() || safeString(normalizedRecord.request_id).trim(),
        message_id: safeString(metadata.message_id).trim() || undefined,
        inbox_correlation_key: safeString(metadata.inbox_correlation_key).trim() || undefined,
        transport_preference: safeString(metadata.transport_preference).trim() || 'hook_preferred_with_fallback',
        fallback_allowed: typeof metadata.fallback_allowed === 'boolean' ? metadata.fallback_allowed : true,
        status: safeString(normalizedRecord.status).trim() || 'pending',
        attempt_count: 0,
        created_at: safeString(normalizedRecord.created_at).trim() || new Date().toISOString(),
        updated_at:
          safeString(normalizedRecord.delivered_at).trim()
          || safeString(normalizedRecord.failed_at).trim()
          || safeString(normalizedRecord.notified_at).trim()
          || safeString(normalizedRecord.created_at).trim()
          || new Date().toISOString(),
        notified_at: safeString(normalizedRecord.notified_at).trim() || undefined,
        delivered_at: safeString(normalizedRecord.delivered_at).trim() || undefined,
        failed_at: safeString(normalizedRecord.failed_at).trim() || undefined,
        last_reason: safeString(normalizedRecord.reason).trim() || undefined,
      };
      return normalizedDispatchRecord;
    })
    .filter((record): record is DispatchRequest => record !== null && Boolean(record.request_id && record.to_worker && record.trigger_message));
}

async function writeJsonAtomic<T>(path: string, value: T) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, path);
}

// Keep stale-timeout semantics aligned with src/team/state.ts LOCK_STALE_MS.
const DISPATCH_LOCK_STALE_MS = 5 * 60 * 1000;
const DEFAULT_ISSUE_DISPATCH_COOLDOWN_MS = 15 * 60 * 1000;
const ISSUE_DISPATCH_COOLDOWN_ENV = 'OMX_TEAM_DISPATCH_ISSUE_COOLDOWN_MS';
const DEFAULT_DISPATCH_TRIGGER_COOLDOWN_MS = 30 * 1000;
const DISPATCH_TRIGGER_COOLDOWN_ENV = 'OMX_TEAM_DISPATCH_TRIGGER_COOLDOWN_MS';
const LEADER_PANE_MISSING_DEFERRED_REASON = 'leader_pane_missing_deferred';
const LEADER_NOTIFICATION_DEFERRED_TYPE = 'leader_notification_deferred';

async function emitOperationalHookEvent(cwd: string, eventName: string, context: Record<string, unknown>) {
  try {
    const { buildNativeHookEvent } = await import('../../hooks/extensibility/events.js');
    const { dispatchHookEvent } = await import('../../hooks/extensibility/dispatcher.js');
    const event = buildNativeHookEvent(eventName, {
      normalized_event: eventName,
      scope: 'team-dispatch',
      ...context,
    });
    await dispatchHookEvent(event, { cwd });
  } catch {
    // best effort only
  }
}

function resolveIssueDispatchCooldownMs(env = process.env) {
  const raw = safeString(env[ISSUE_DISPATCH_COOLDOWN_ENV]).trim();
  if (raw === '') return DEFAULT_ISSUE_DISPATCH_COOLDOWN_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_ISSUE_DISPATCH_COOLDOWN_MS;
  return parsed;
}

function resolveDispatchTriggerCooldownMs(env = process.env) {
  const raw = safeString(env[DISPATCH_TRIGGER_COOLDOWN_ENV]).trim();
  if (raw === '') return DEFAULT_DISPATCH_TRIGGER_COOLDOWN_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_DISPATCH_TRIGGER_COOLDOWN_MS;
  return parsed;
}

function extractIssueKey(triggerMessage: unknown) {
  const match = safeString(triggerMessage).match(/\b([A-Z][A-Z0-9]+-\d+)\b/i);
  return match?.[1]?.toUpperCase() || null;
}

function issueCooldownStatePath(teamDirPath: string) {
  return join(teamDirPath, 'dispatch', 'issue-cooldown.json');
}

function triggerCooldownStatePath(teamDirPath: string) {
  return join(teamDirPath, 'dispatch', 'trigger-cooldown.json');
}

async function readIssueCooldownState(teamDirPath: string): Promise<IssueCooldownState> {
  const fallback: IssueCooldownState = { by_issue: {} };
  const parsed = await readJson(issueCooldownStatePath(teamDirPath), fallback);
  if (!parsed || typeof parsed !== 'object' || typeof parsed.by_issue !== 'object' || parsed.by_issue === null) {
    return fallback;
  }
  return parsed;
}

async function readTriggerCooldownState(teamDirPath: string): Promise<TriggerCooldownState> {
  const fallback: TriggerCooldownState = { by_trigger: {} };
  const parsed = await readJson(triggerCooldownStatePath(teamDirPath), fallback);
  if (!parsed || typeof parsed !== 'object' || typeof parsed.by_trigger !== 'object' || parsed.by_trigger === null) {
    return fallback;
  }
  return parsed;
}

function normalizeTriggerKey(value: unknown) {
  return safeString(value).replace(/\s+/g, ' ').trim();
}

function parseTriggerCooldownEntry(entry: unknown): TriggerCooldownEntry {
  if (typeof entry === 'number') {
    return { at: entry, lastRequestId: '' };
  }
  if (!entry || typeof entry !== 'object') {
    return { at: NaN, lastRequestId: '' };
  }
  const record = entry as StoredTriggerCooldownEntry;
  return {
    at: Number(record.at),
    lastRequestId: safeString(record.last_request_id).trim(),
  };
}

async function withDispatchLock<T>(teamDirPath: string, fn: () => Promise<T>): Promise<T> {
  const lockDir = join(teamDirPath, 'dispatch', '.lock');
  const ownerPath = join(lockDir, 'owner');
  const ownerToken = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const deadline = Date.now() + 5_000;
  await mkdir(dirname(lockDir), { recursive: true });

  while (true) {
    try {
      await mkdir(lockDir, { recursive: false });
      try {
        await writeFile(ownerPath, ownerToken, 'utf8');
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error: unknown) {
      if (errorCode(error) !== 'EEXIST') throw error;
      try {
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs > DISPATCH_LOCK_STALE_MS) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // best effort
      }
      if (Date.now() > deadline) throw new Error(`Timed out acquiring dispatch lock for ${teamDirPath}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      const currentOwner = await readFile(ownerPath, 'utf8');
      if (currentOwner.trim() === ownerToken) {
        await rm(lockDir, { recursive: true, force: true });
      }
    } catch {
      // best effort
    }
  }
}

async function withMailboxLock<T>(teamDirPath: string, workerName: string, fn: () => Promise<T>): Promise<T> {
  const lockDir = join(teamDirPath, 'mailbox', `.lock-${workerName}`);
  const ownerPath = join(lockDir, 'owner');
  const ownerToken = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const deadline = Date.now() + 5_000;
  await mkdir(dirname(lockDir), { recursive: true });

  while (true) {
    try {
      await mkdir(lockDir, { recursive: false });
      try {
        await writeFile(ownerPath, ownerToken, 'utf8');
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error: unknown) {
      if (errorCode(error) !== 'EEXIST') throw error;
      try {
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs > DISPATCH_LOCK_STALE_MS) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // best effort
      }
      if (Date.now() > deadline) throw new Error(`Timed out acquiring mailbox lock for ${teamDirPath}/${workerName}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      const currentOwner = await readFile(ownerPath, 'utf8');
      if (currentOwner.trim() === ownerToken) {
        await rm(lockDir, { recursive: true, force: true });
      }
    } catch {
      // best effort
    }
  }
}

function resolveLeaderPaneId(config: DispatchConfig) {
  return safeString(config?.leader_pane_id).trim();
}


function defaultInjectTarget(request: DispatchRequest, config: DispatchConfig): InjectTarget | null {
  if (request.to_worker === 'leader-fixed') {
    const leaderPaneId = resolveLeaderPaneId(config);
    if (leaderPaneId) return { type: 'pane', value: leaderPaneId };
    return null;
  }
  if (request.pane_id) return { type: 'pane', value: request.pane_id };
  if (typeof request.worker_index === 'number' && Array.isArray(config?.workers)) {
    const worker = config.workers.find((candidate) => Number(candidate?.index) === request.worker_index);
    if (worker?.pane_id) return { type: 'pane', value: worker.pane_id };
  }
  if (typeof request.worker_index === 'number' && config.tmux_session) {
    return { type: 'pane', value: `${config.tmux_session}.${request.worker_index}` };
  }
  if (config.tmux_session) return { type: 'session', value: config.tmux_session };
  return null;
}

async function appendLeaderNotificationDeferredEvent({
  stateDir,
  teamName,
  request,
  reason,
  nowIso,
  tmuxSession = '',
  leaderPaneId = '',
  sourceType = 'team_dispatch',
}: LeaderDeferredEventArgs) {
  const eventsDir = join(stateDir, 'team', teamName, 'events');
  const eventsPath = join(eventsDir, 'events.ndjson');
  const event = {
    event_id: `leader-deferred-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    team: teamName,
    type: LEADER_NOTIFICATION_DEFERRED_TYPE,
    worker: request.to_worker,
    to_worker: request.to_worker,
    reason,
    created_at: nowIso,
    request_id: request.request_id,
    ...(request.message_id ? { message_id: request.message_id } : {}),
    tmux_session: tmuxSession || null,
    leader_pane_id: leaderPaneId || null,
    tmux_injection_attempted: false,
    source_type: sourceType,
  };
  await mkdir(eventsDir, { recursive: true }).catch(() => {});
  await appendFile(eventsPath, JSON.stringify(event) + '\n').catch(() => {});
}

function resolveWorkerCliForRequest(request: DispatchRequest, config: DispatchConfig) {
  const workers = Array.isArray(config?.workers) ? config.workers : [];
  const idx = Number.isFinite(request?.worker_index) ? Number(request.worker_index) : null;
  if (idx !== null) {
    const worker = workers.find((candidate) => Number(candidate?.index) === idx);
    const workerCli = safeString(worker?.worker_cli).trim().toLowerCase();
    if (workerCli === 'claude') return 'claude';
  }
  return 'codex';
}

function capturedPaneContainsTrigger(captured: unknown, trigger: unknown) {
  if (!captured || !trigger) return false;
  return normalizeTmuxCapture(captured).includes(normalizeTmuxCapture(trigger));
}

function capturedPaneContainsTriggerNearTail(captured: unknown, trigger: unknown, nonEmptyTailLines = 24) {
  if (!captured || !trigger) return false;
  const normalizedTrigger = normalizeTmuxCapture(trigger);
  if (!normalizedTrigger) return false;
  const lines = safeString(captured)
    .split('\n')
    .map((line) => line.replace(/\r/g, '').trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return false;
  const tail = lines.slice(-Math.max(1, nonEmptyTailLines)).join(' ');
  return normalizeTmuxCapture(tail).includes(normalizedTrigger);
}

const INJECT_VERIFY_DELAY_MS = 250;
const INJECT_VERIFY_ROUNDS = 3;

async function injectDispatchRequest(request: DispatchRequest, config: DispatchConfig, cwd: string, stateDir: string): Promise<InjectResult> {
  const traceId = dispatchTraceId(request);
  const target = defaultInjectTarget(request, config);
  await decisionTrace(cwd, 'dispatch.target_selected', {
    trace_id: traceId,
    request_id: safeString(request.request_id).trim(),
    to_worker: safeString(request.to_worker).trim(),
    attempt_count: Number.isFinite(request.attempt_count) ? Math.max(0, Math.floor(request.attempt_count)) : 0,
    target_type: safeString(target?.type).trim(),
    target_value: safeString(target?.value).trim(),
    result: target ? 'selected' : 'missing',
  });
  if (!target) {
    return { ok: false, reason: 'missing_tmux_target' };
  }
  await decisionTrace(cwd, 'dispatch.target_resolve_start', {
    trace_id: traceId,
    request_id: safeString(request.request_id).trim(),
    target_type: safeString(target.type).trim(),
    target_value: safeString(target.value).trim(),
    result: 'start',
  });
  const resolution = await resolvePaneTarget(target, '', cwd, '');
  await decisionTrace(cwd, 'dispatch.target_resolve_result', {
    trace_id: traceId,
    request_id: safeString(request.request_id).trim(),
    target_type: safeString(target.type).trim(),
    target_value: safeString(target.value).trim(),
    resolved_pane: safeString(resolution.paneTarget).trim(),
    reason: safeString(resolution.reason).trim(),
    matched_session: safeString(resolution.matched_session).trim(),
    result: resolution.paneTarget ? 'resolved' : 'failed',
  });
  if (!resolution.paneTarget) {
    return { ok: false, reason: `target_resolution_failed:${resolution.reason}` };
  }
  const paneGuard = await evaluatePaneInjectionReadiness(resolution.paneTarget, {
    skipIfScrolling: true,
    requireRunningAgent: false,
    requireReady: false,
    requireIdle: false,
    preferCanonicalBypass: false,
  });
  await decisionTrace(cwd, 'dispatch.pane_guard_result', {
    trace_id: traceId,
    request_id: safeString(request.request_id).trim(),
    resolved_pane: safeString(resolution.paneTarget).trim(),
    reason: safeString(paneGuard.reason).trim(),
    pane_current_command: safeString(paneGuard.paneCurrentCommand).trim(),
    result: paneGuard.ok ? 'ok' : 'blocked',
  });
  if (!paneGuard.ok) {
    return { ok: false, reason: paneGuard.reason };
  }

  const attemptCountAtStart = Number.isFinite(request.attempt_count)
    ? Math.max(0, Math.floor(request.attempt_count))
    : 0;
  const submitKeyPresses = resolveWorkerCliForRequest(request, config) === 'claude' ? 1 : 2;
  let preCaptureHasTrigger = false;
  if (attemptCountAtStart >= 1) {
    try {
      const preCapture = await runProcessWithTrace('tmux', buildCapturePaneArgv(resolution.paneTarget, 8), 2000, {
        trace_id: traceId,
        command_role: 'pre_capture_narrow',
        request_id: safeString(request.request_id).trim(),
      });
      preCaptureHasTrigger = capturedPaneContainsTrigger(preCapture.stdout, request.trigger_message);
      await decisionTrace(cwd, 'dispatch.pre_capture_result', {
        trace_id: traceId,
        request_id: safeString(request.request_id).trim(),
        attempt_count: attemptCountAtStart,
        resolved_pane: safeString(resolution.paneTarget).trim(),
        trigger_visible: preCaptureHasTrigger,
        capture_excerpt: safeString(preCapture.stdout).slice(-200),
        result: 'observed',
      });
    } catch {
      preCaptureHasTrigger = false;
      await decisionTrace(cwd, 'dispatch.pre_capture_result', {
        trace_id: traceId,
        request_id: safeString(request.request_id).trim(),
        attempt_count: attemptCountAtStart,
        resolved_pane: safeString(resolution.paneTarget).trim(),
        trigger_visible: false,
        reason: 'capture_failed',
        result: 'error',
      });
    }
  }

  // Retype whenever trigger text is NOT in the narrow input area, regardless of attempt count.
  // Pre-0.7.4 bug: 80-line capture matched trigger in scrollback output, falsely skipping retype.
  const shouldTypePrompt = attemptCountAtStart === 0 || !preCaptureHasTrigger;
  await decisionTrace(cwd, 'dispatch.send_attempt', {
    trace_id: traceId,
    request_id: safeString(request.request_id).trim(),
    attempt_count: attemptCountAtStart,
    resolved_pane: safeString(resolution.paneTarget).trim(),
    should_type_prompt: shouldTypePrompt,
    submit_key_presses: submitKeyPresses,
    result: 'start',
  });
  if (shouldTypePrompt) {
    if (attemptCountAtStart >= 1) {
      await runProcessWithTrace('tmux', ['send-keys', '-t', resolution.paneTarget, 'C-u'], 1000, {
        trace_id: traceId,
        command_role: 'clear_input_buffer',
        request_id: safeString(request.request_id).trim(),
      }).catch(() => {});
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  const sendResult = await sendPaneInput({
    paneTarget: resolution.paneTarget,
    prompt: request.trigger_message,
    submitKeyPresses,
    typePrompt: shouldTypePrompt,
  });
  if (!sendResult.ok) {
    return { ok: false, reason: sendResult.error || sendResult.reason };
  }

  // Post-injection verification: confirm the trigger text was consumed.
  // Fixes #391: without this, dispatch marks 'notified' even when the worker
  // pane is sitting on an unsent draft (C-m was not effectively applied).
  const verifyNarrowArgv = buildCapturePaneArgv(resolution.paneTarget, 8);
  const verifyWideArgv = buildCapturePaneArgv(resolution.paneTarget);
  for (let round = 0; round < INJECT_VERIFY_ROUNDS; round++) {
    await new Promise((r) => setTimeout(r, INJECT_VERIFY_DELAY_MS));
    try {
      // Primary: trigger text no longer in narrow input area.
      // Secondary guard: also inspect the recent non-empty tail of wide capture.
      // This avoids false confirmations when Codex leaves the unsent draft just
      // above a large blank area (narrow capture misses it) while still avoiding
      // full-scrollback false positives.
      const narrowCap = await runProcessWithTrace('tmux', verifyNarrowArgv, 2000, {
        trace_id: traceId,
        command_role: 'verify_narrow',
        request_id: safeString(request.request_id).trim(),
        verify_round: round + 1,
      });
      const wideCap = await runProcessWithTrace('tmux', verifyWideArgv, 2000, {
        trace_id: traceId,
        command_role: 'verify_wide',
        request_id: safeString(request.request_id).trim(),
        verify_round: round + 1,
      });
      const triggerInNarrow = capturedPaneContainsTrigger(narrowCap.stdout, request.trigger_message);
      const triggerNearTail = capturedPaneContainsTriggerNearTail(wideCap.stdout, request.trigger_message);
      const activeTask = paneHasActiveTask(wideCap.stdout);
      const looksReady = paneLooksReady(wideCap.stdout);
      await decisionTrace(cwd, 'dispatch.verify_round_result', {
        trace_id: traceId,
        request_id: safeString(request.request_id).trim(),
        verify_round: round + 1,
        resolved_pane: safeString(resolution.paneTarget).trim(),
        trigger_in_narrow: triggerInNarrow,
        trigger_near_tail: triggerNearTail,
        pane_has_active_task: activeTask,
        pane_looks_ready: looksReady,
        narrow_excerpt: safeString(narrowCap.stdout).slice(-160),
        wide_excerpt: safeString(wideCap.stdout).slice(-160),
        result: 'observed',
      });
      if (activeTask) {
        runtimeExec({ command: 'MarkDelivered', request_id: request.request_id }, stateDir);
        return { ok: true, reason: 'tmux_send_keys_confirmed_active_task', pane: resolution.paneTarget };
      }
      // Do not declare success while a *worker* pane is still bootstrapping / not
      // input-ready. Otherwise a pre-ready send can be marked "confirmed" and later
      // appear as a stuck unsent draft once the UI finishes loading.
      // Keep leader-fixed behavior unchanged to avoid regressing leader notification flow.
      if (request.to_worker !== 'leader-fixed' && !looksReady) {
        continue;
      }
      if (!triggerInNarrow && !triggerNearTail) {
        runtimeExec({ command: 'MarkDelivered', request_id: request.request_id }, stateDir);
        return { ok: true, reason: 'tmux_send_keys_confirmed', pane: resolution.paneTarget };
      }
    } catch {
      await decisionTrace(cwd, 'dispatch.verify_round_result', {
        trace_id: traceId,
        request_id: safeString(request.request_id).trim(),
        verify_round: round + 1,
        resolved_pane: safeString(resolution.paneTarget).trim(),
        reason: 'capture_failed',
        result: 'error',
      });
    }
    // Draft still visible and no active task — retry C-m
    await sendPaneInput({
      paneTarget: resolution.paneTarget,
      prompt: request.trigger_message,
      submitKeyPresses,
      typePrompt: false,
    }).catch(() => {});
  }

  // Trigger text is still visible after all retry rounds.
  return { ok: true, reason: 'tmux_send_keys_unconfirmed', pane: resolution.paneTarget };
}

function shouldSkipRequest(request: DispatchRequest) {
  if (request.status !== 'pending') return true;
  const preference = safeString(request.transport_preference).trim();
  return preference !== '' && preference !== 'hook_preferred_with_fallback';
}

async function updateMailboxNotified(stateDir: string, teamName: string, workerName: string, messageId: string) {
  const teamDirPath = join(stateDir, 'team', teamName);
  const mailboxPath = join(teamDirPath, 'mailbox', `${workerName}.json`);
  return await withMailboxLock(teamDirPath, workerName, async () => {
    const mailbox = await readJson<MailboxState>(mailboxPath, { worker: workerName, messages: [] });
    if (!mailbox || !Array.isArray(mailbox.messages)) return false;
    const msg = mailbox.messages.find((candidate) => candidate?.message_id === messageId);
    if (!msg) return false;
    if (!msg.notified_at) msg.notified_at = new Date().toISOString();
    await writeJsonAtomic(mailboxPath, mailbox);
    return true;
  });
}

async function appendDispatchLog(logsDir: string, event: Record<string, unknown>) {
  const path = join(logsDir, `team-dispatch-${new Date().toISOString().slice(0, 10)}.jsonl`);
  await mkdir(logsDir, { recursive: true }).catch(() => {});
  await appendFile(path, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`).catch(() => {});
}

async function decisionTrace(cwd: string, event: string, payload: Record<string, unknown> = {}) {
  await appendRuntimeDecisionTrace(cwd, 'team-dispatch', event, payload).catch(() => {});
}

function dispatchTraceId(request: Partial<DispatchRequest> | null | undefined) {
  return buildRuntimeTraceId('dispatch', safeString(request?.request_id).trim() || 'unknown');
}

export async function drainPendingTeamDispatch({
  cwd = process.cwd(),
  stateDir = resolveBridgeStateDir(cwd),
  logsDir = join(cwd, '.omx', 'logs'),
  maxPerTick = 5,
  injector = injectDispatchRequest,
}: DrainPendingTeamDispatchOptions = {}) {
  if (safeString(process.env.OMX_TEAM_WORKER)) {
    return { processed: 0, skipped: 0, failed: 0, reason: 'worker_context' };
  }
  const teamRoot = join(stateDir, 'team');
  if (!existsSync(teamRoot)) return { processed: 0, skipped: 0, failed: 0 };

  const teams = await readdir(teamRoot).catch(() => []);

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  const issueCooldownMs = resolveIssueDispatchCooldownMs();
  const triggerCooldownMs = resolveDispatchTriggerCooldownMs();

  for (const teamName of teams) {
    if (processed >= maxPerTick) break;
    const teamDirPath = join(teamRoot, teamName);
    const manifestPath = join(teamDirPath, 'manifest.v2.json');
    const configPath = join(teamDirPath, 'config.json');
    const requestsPath = join(teamDirPath, 'dispatch', 'requests.json');

    const config = await readJson<DispatchConfig>(existsSync(manifestPath) ? manifestPath : configPath, {});
    await withDispatchLock(teamDirPath, async () => {
      const bridgeRequests = await readBridgeDispatchRequests(stateDir, teamName);
      const usingLegacyRequests = bridgeRequests === null;
      const requests = usingLegacyRequests ? await readJson<DispatchRequest[]>(requestsPath, []) : bridgeRequests;
      if (!Array.isArray(requests)) return;
      const issueCooldownState = await readIssueCooldownState(teamDirPath);
      const triggerCooldownState = await readTriggerCooldownState(teamDirPath);
      const issueCooldownByIssue: Record<string, number> = issueCooldownState.by_issue || {};
      const triggerCooldownByKey: Record<string, number | StoredTriggerCooldownEntry> = triggerCooldownState.by_trigger || {};
      const nowMs = Date.now();

      let mutated = false;
      for (const request of requests) {
        if (processed >= maxPerTick) break;
        if (!request || typeof request !== 'object') continue;
        await decisionTrace(cwd, 'dispatch.request_loaded', {
          trace_id: dispatchTraceId(request),
          team_name: teamName,
          request_id: safeString(request.request_id).trim(),
          to_worker: safeString(request.to_worker).trim(),
          status: safeString(request.status).trim(),
          result: 'loaded',
        });
        if (shouldSkipRequest(request)) {
          skipped += 1;
          await decisionTrace(cwd, 'dispatch.request_skipped', {
            trace_id: dispatchTraceId(request),
            team_name: teamName,
            request_id: safeString(request.request_id).trim(),
            to_worker: safeString(request.to_worker).trim(),
            status: safeString(request.status).trim(),
            reason: 'should_skip_request',
            result: 'skipped',
          });
          continue;
        }

        if (request.to_worker === 'leader-fixed' && !resolveLeaderPaneId(config)) {
          const nowIso = new Date().toISOString();
          const alreadyDeferred = safeString(request.last_reason).trim() === LEADER_PANE_MISSING_DEFERRED_REASON;
          request.updated_at = nowIso;
          request.last_reason = LEADER_PANE_MISSING_DEFERRED_REASON;
          request.status = 'pending';
          skipped += 1;
          mutated = true;
          if (!alreadyDeferred) {
            await appendDispatchLog(logsDir, {
              type: 'dispatch_deferred',
              team: teamName,
              request_id: request.request_id,
              worker: request.to_worker,
              to_worker: request.to_worker,
              message_id: request.message_id || null,
              reason: LEADER_PANE_MISSING_DEFERRED_REASON,
              status: 'pending',
              tmux_session: safeString(config?.tmux_session).trim() || null,
              leader_pane_id: safeString(config?.leader_pane_id).trim() || null,
              tmux_injection_attempted: false,
            });
            // On the legacy fallback lane, requests.json still carries the queue
            // state for this deferred request; this event stays a progress
            // artifact for hook/watcher readers.
            await appendLeaderNotificationDeferredEvent({
              stateDir,
              teamName,
              request,
              reason: LEADER_PANE_MISSING_DEFERRED_REASON,
              nowIso,
              tmuxSession: safeString(config?.tmux_session).trim(),
              leaderPaneId: safeString(config?.leader_pane_id).trim(),
              sourceType: 'team_dispatch',
            });
          }
          await decisionTrace(cwd, 'dispatch.request_deferred', {
            trace_id: dispatchTraceId(request),
            team_name: teamName,
            request_id: safeString(request.request_id).trim(),
            to_worker: safeString(request.to_worker).trim(),
            reason: LEADER_PANE_MISSING_DEFERRED_REASON,
            result: 'deferred',
          });
          continue;
        }

        const issueKey = extractIssueKey(request.trigger_message);
        if (issueCooldownMs > 0 && issueKey) {
          const lastInjectedMs = Number(issueCooldownByIssue[issueKey]);
          if (Number.isFinite(lastInjectedMs) && lastInjectedMs > 0 && nowMs - lastInjectedMs < issueCooldownMs) {
            skipped += 1;
            await decisionTrace(cwd, 'dispatch.request_skipped', {
              trace_id: dispatchTraceId(request),
              team_name: teamName,
              request_id: safeString(request.request_id).trim(),
              to_worker: safeString(request.to_worker).trim(),
              reason: 'issue_cooldown_active',
              result: 'skipped',
            });
            continue;
          }
        }

        const triggerKey = normalizeTriggerKey(request.trigger_message);
        if (triggerCooldownMs > 0 && triggerKey) {
          const parsed = parseTriggerCooldownEntry(triggerCooldownByKey[triggerKey]);
          const withinCooldown = Number.isFinite(parsed.at) && parsed.at > 0 && nowMs - parsed.at < triggerCooldownMs;
          const sameRequestRetry = parsed.lastRequestId !== '' && parsed.lastRequestId === safeString(request.request_id).trim();
          if (withinCooldown && !sameRequestRetry) {
            skipped += 1;
            await decisionTrace(cwd, 'dispatch.request_skipped', {
              trace_id: dispatchTraceId(request),
              team_name: teamName,
              request_id: safeString(request.request_id).trim(),
              to_worker: safeString(request.to_worker).trim(),
              reason: 'trigger_cooldown_active',
              result: 'skipped',
            });
            continue;
          }
        }

        const result = await injector(request, config, resolve(cwd), stateDir);
        if (issueKey && issueCooldownMs > 0) {
          issueCooldownByIssue[issueKey] = Date.now();
          mutated = true;
        }
        if (triggerKey && triggerCooldownMs > 0) {
          triggerCooldownByKey[triggerKey] = {
            at: Date.now(),
            last_request_id: safeString(request.request_id).trim(),
          };
          mutated = true;
        }
        const nowIso = new Date().toISOString();
        request.attempt_count = Number.isFinite(request.attempt_count) ? Math.max(0, request.attempt_count + 1) : 1;
        request.updated_at = nowIso;

        if (result.ok) {
          // Unconfirmed sends: trigger text was still visible after retry
          // rounds. Leave as pending for the next tick to retry (up to 3
          // total attempts) rather than marking notified. Fixes #391.
          const MAX_UNCONFIRMED_ATTEMPTS = 3;
          if (result.reason === 'tmux_send_keys_unconfirmed' && request.attempt_count < MAX_UNCONFIRMED_ATTEMPTS) {
            request.last_reason = result.reason;
            mutated = true;
            skipped += 1;
            await appendDispatchLog(logsDir, {
              type: 'dispatch_unconfirmed_retry',
              team: teamName,
              request_id: request.request_id,
              worker: request.to_worker,
              attempt: request.attempt_count,
              reason: result.reason,
            });
            await emitOperationalHookEvent(cwd, 'retry-needed', {
              team: teamName,
              worker: request.to_worker,
              request_id: request.request_id,
              attempt: request.attempt_count,
              command: request.trigger_message,
              reason: result.reason,
              status: 'retry-needed',
            });
            await decisionTrace(cwd, 'dispatch.request_processed', {
              trace_id: dispatchTraceId(request),
              team_name: teamName,
              request_id: safeString(request.request_id).trim(),
              to_worker: safeString(request.to_worker).trim(),
              reason: result.reason,
              attempt_count: request.attempt_count,
              result: 'retry_pending',
            });
            continue;
          }
          if (result.reason === 'tmux_send_keys_unconfirmed') {
            request.status = 'failed';
            request.failed_at = nowIso;
            request.last_reason = 'unconfirmed_after_max_retries';
            runtimeExec({ command: 'MarkFailed', request_id: request.request_id, reason: 'unconfirmed_after_max_retries' }, stateDir);
            processed += 1;
            failed += 1;
            mutated = true;
            await appendDispatchLog(logsDir, {
              type: 'dispatch_failed',
              team: teamName,
              request_id: request.request_id,
              worker: request.to_worker,
              message_id: request.message_id || null,
              reason: request.last_reason,
            });
            await emitOperationalHookEvent(cwd, 'failed', {
              team: teamName,
              worker: request.to_worker,
              request_id: request.request_id,
              message_id: request.message_id || null,
              command: request.trigger_message,
              reason: request.last_reason,
              error_summary: request.last_reason,
              status: 'failed',
            });
            await decisionTrace(cwd, 'dispatch.request_failed', {
              trace_id: dispatchTraceId(request),
              team_name: teamName,
              request_id: safeString(request.request_id).trim(),
              to_worker: safeString(request.to_worker).trim(),
              reason: request.last_reason,
              result: 'failed',
            });
            continue;
          }
          request.status = 'notified';
          request.notified_at = nowIso;
          request.last_reason = result.reason;
          runtimeExec({ command: 'MarkNotified', request_id: request.request_id, channel: 'tmux' }, stateDir);
          if (usingLegacyRequests && request.kind === 'mailbox' && request.message_id) {
            runtimeExec({ command: 'MarkMailboxNotified', message_id: request.message_id }, stateDir);
            await updateMailboxNotified(stateDir, teamName, request.to_worker, request.message_id).catch(() => {});
          }
          processed += 1;
          mutated = true;
          await appendDispatchLog(logsDir, {
            type: 'dispatch_notified',
            team: teamName,
            request_id: request.request_id,
            worker: request.to_worker,
            message_id: request.message_id || null,
            reason: result.reason,
          });
          await decisionTrace(cwd, 'dispatch.request_processed', {
            trace_id: dispatchTraceId(request),
            team_name: teamName,
            request_id: safeString(request.request_id).trim(),
            to_worker: safeString(request.to_worker).trim(),
            reason: result.reason,
            result: 'notified',
          });
        } else {
          request.status = 'failed';
          request.failed_at = nowIso;
          request.last_reason = result.reason;
          runtimeExec({ command: 'MarkFailed', request_id: request.request_id, reason: result.reason }, stateDir);
          processed += 1;
          failed += 1;
          mutated = true;
          await appendDispatchLog(logsDir, {
            type: 'dispatch_failed',
            team: teamName,
            request_id: request.request_id,
            worker: request.to_worker,
            message_id: request.message_id || null,
            reason: result.reason,
          });
          await emitOperationalHookEvent(cwd, result.reason === LEADER_PANE_MISSING_DEFERRED_REASON ? 'handoff-needed' : 'failed', {
            team: teamName,
            worker: request.to_worker,
            request_id: request.request_id,
            message_id: request.message_id || null,
            command: request.trigger_message,
            reason: result.reason,
            ...(result.reason === LEADER_PANE_MISSING_DEFERRED_REASON
              ? { status: 'handoff-needed' }
              : { status: 'failed', error_summary: result.reason }),
          });
          await decisionTrace(cwd, 'dispatch.request_failed', {
            trace_id: dispatchTraceId(request),
            team_name: teamName,
            request_id: safeString(request.request_id).trim(),
            to_worker: safeString(request.to_worker).trim(),
            reason: result.reason,
            result: 'failed',
          });
        }
      }

      if (mutated) {
        issueCooldownState.by_issue = issueCooldownByIssue;
        await writeJsonAtomic(issueCooldownStatePath(teamDirPath), issueCooldownState);
        triggerCooldownState.by_trigger = triggerCooldownByKey;
        await writeJsonAtomic(triggerCooldownStatePath(teamDirPath), triggerCooldownState);
        if (usingLegacyRequests) {
          await writeJsonAtomic(requestsPath, requests);
        }
      }
    });
  }

  return { processed, skipped, failed };
}
