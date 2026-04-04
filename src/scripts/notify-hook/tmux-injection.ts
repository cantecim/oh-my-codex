/**
 * Tmux prompt injection for notify-hook.
 * Handles pane resolution, injection guards, and state healing.
 */

import { readFile, writeFile } from 'fs/promises';
import { join, resolve as resolvePath } from 'path';
import { safeString, asNumber } from './utils.js';
import { buildRuntimeTraceId, traceDecision as appendRuntimeDecisionTrace } from '../../debug/runtime-trace.js';
import {
  readJsonIfExists,
  normalizeTmuxState,
  pruneRecentKeys,
  getScopedStateDirsForCurrentSession,
  readdir,
  type TmuxState,
} from './state-io.js';
import { runProcess } from './process-runner.js';
import { logTmuxHookEvent } from './log.js';
import { evaluatePaneInjectionReadiness, mapPaneInjectionReadinessReason, sendPaneInput } from './team-tmux-guard.js';
import {
  normalizeTmuxHookConfig,
  pickActiveMode,
  evaluateInjectionGuards,
  buildSendKeysArgv,
  resolveCodexPane,
  type TmuxTargetConfig,
} from '../tmux-hook-engine.js';

interface PaneResolutionResult {
  paneTarget: string | null;
  reason: string;
  matched_session?: string | null;
  pane_cwd?: string;
  expected_cwd?: string;
}

interface TmuxSessionRow {
  paneId: string;
  active: boolean;
  currentCommand: string;
  startCommand: string;
}

interface HandleTmuxInjectionArgs {
  payload: Record<string, unknown>;
  cwd: string;
  stateDir: string;
  logsDir: string;
}

interface ActiveModeState {
  active?: boolean;
  tmux_pane_id?: string;
}

function isHudPaneStartCommand(startCommand: unknown): boolean {
  return /\bomx\b.*\bhud\b.*--watch/i.test(safeString(startCommand));
}

async function decisionTrace(cwd: string, event: string, payload: Record<string, unknown> = {}): Promise<void> {
  await appendRuntimeDecisionTrace(cwd, 'tmux-injection', event, payload).catch(() => {});
}

function tmuxInjectionTraceId(target: TmuxTargetConfig | string | null | undefined, turnId = ''): string {
  const targetLabel = typeof target === 'string' ? target : target?.value;
  return buildRuntimeTraceId('tmux-injection', safeString(turnId).trim() || safeString(targetLabel).trim() || 'unknown');
}

function shouldReturnResolvedPane(result: PaneResolutionResult): boolean {
  return Boolean(result?.paneTarget) || safeString(result?.reason).trim() === 'pane_cwd_mismatch';
}

async function resolvePaneCwdMismatch(paneId: string, expectedCwd: string): Promise<PaneResolutionResult | null> {
  if (!expectedCwd) return null;
  try {
    const paneCwdResult = await runProcess('tmux', ['display-message', '-p', '-t', paneId, '#{pane_current_path}']);
    const paneCwd = safeString(paneCwdResult.stdout).trim();
    if (paneCwd && resolvePath(paneCwd) !== resolvePath(expectedCwd)) {
      return {
        paneTarget: null,
        reason: 'pane_cwd_mismatch',
        pane_cwd: paneCwd,
        expected_cwd: expectedCwd,
      };
    }
  } catch {
    // Best effort only — if tmux cannot report cwd, keep the explicit pane target.
  }
  return null;
}

async function finalizeResolvedPane(paneId: string, reason: string, expectedCwd: string): Promise<PaneResolutionResult> {
  const cwdMismatch = await resolvePaneCwdMismatch(paneId, expectedCwd);
  if (cwdMismatch) return cwdMismatch;
  let sessionName = '';
  try {
    const currentSession = await runProcess('tmux', ['display-message', '-p', '-t', paneId, '#S']);
    sessionName = safeString(currentSession.stdout).trim();
  } catch {
    sessionName = '';
  }
  return {
    paneTarget: paneId,
    reason,
    matched_session: sessionName || null,
  };
}

async function resolveCanonicalPaneFromPaneTarget(paneTarget: string, expectedCwd: string): Promise<PaneResolutionResult> {
  const traceId = tmuxInjectionTraceId(paneTarget);
  const cwd = process.cwd();
  await decisionTrace(cwd, 'tmux_injection.resolve_target_candidate', {
    trace_id: traceId,
    candidate_source: 'pane_target',
    target_type: 'pane',
    target_value: safeString(paneTarget).trim(),
    expected_cwd: safeString(expectedCwd).trim(),
    result: 'start',
  });
  const paneResult = await runProcess('tmux', ['display-message', '-p', '-t', paneTarget, '#{pane_id}']);
  const rawPaneTarget = safeString(paneTarget).trim();
  const paneId = safeString(paneResult.stdout).trim() || (/^%\d+$/.test(rawPaneTarget) ? rawPaneTarget : '');
  if (!paneId) {
    await decisionTrace(cwd, 'tmux_injection.resolve_target_rejected', {
      trace_id: traceId,
      candidate_source: 'pane_target',
      target_type: 'pane',
      target_value: safeString(paneTarget).trim(),
      reason: 'target_not_found',
      result: 'rejected',
    });
    return { paneTarget: null, reason: 'target_not_found' };
  }
  await decisionTrace(cwd, 'tmux_injection.resolve_target_candidate', {
    trace_id: traceId,
    candidate_source: 'pane_target',
    target_type: 'pane',
    target_value: safeString(paneTarget).trim(),
    pane_target: paneId,
    result: 'resolved',
  });

  let startCommand = '';
  try {
    const startResult = await runProcess('tmux', ['display-message', '-p', '-t', paneId, '#{pane_start_command}']);
    startCommand = safeString(startResult.stdout).trim();
  } catch {
    startCommand = '';
  }
  if (!startCommand || !isHudPaneStartCommand(startCommand)) {
    return finalizeResolvedPane(paneId, 'ok', expectedCwd);
  }
  await decisionTrace(cwd, 'tmux_injection.resolve_target_candidate', {
    trace_id: traceId,
    candidate_source: 'hud_pane_target',
    target_type: 'pane',
    target_value: paneId,
    pane_start_command: startCommand,
    result: 'hud_detected',
  });

  let sessionName = '';
  try {
    const sessionResult = await runProcess('tmux', ['display-message', '-p', '-t', paneId, '#S']);
    sessionName = safeString(sessionResult.stdout).trim();
  } catch {
    sessionName = '';
  }
  if (!sessionName) {
    await decisionTrace(cwd, 'tmux_injection.resolve_target_rejected', {
      trace_id: traceId,
      candidate_source: 'hud_pane_target',
      target_type: 'pane',
      target_value: safeString(paneTarget).trim(),
      reason: 'target_is_hud_pane',
      result: 'rejected',
    });
    return { paneTarget: null, reason: 'target_is_hud_pane' };
  }
  await decisionTrace(cwd, 'tmux_injection.resolve_target_candidate', {
    trace_id: traceId,
    candidate_source: 'hud_session_heal',
    target_type: 'session',
    target_value: sessionName,
    matched_session: sessionName,
    result: 'start',
  });

  const healedPaneId = await resolveSessionToPane(sessionName);
  if (!healedPaneId) {
    const rawCurrentPane = safeString(process.env.TMUX_PANE).trim();
    if (rawCurrentPane && rawCurrentPane !== paneId) {
      await decisionTrace(cwd, 'tmux_injection.resolve_target_candidate', {
        trace_id: traceId,
        candidate_source: 'tmux_pane_env_fallback',
        target_type: 'pane',
        target_value: rawCurrentPane,
        matched_session: sessionName,
        result: 'start',
      });
      try {
        const currentSessionResult = await runProcess('tmux', ['display-message', '-p', '-t', rawCurrentPane, '#S']);
        const currentSessionName = safeString(currentSessionResult.stdout).trim();
        if (currentSessionName && currentSessionName === sessionName) {
          const healedFromCurrentPane = await finalizeResolvedPane(rawCurrentPane, 'healed_hud_to_tmux_pane_env', expectedCwd);
          if (healedFromCurrentPane.paneTarget) {
            await decisionTrace(cwd, 'tmux_injection.resolve_target_candidate', {
              trace_id: traceId,
              candidate_source: 'tmux_pane_env_fallback',
              target_type: 'pane',
              target_value: rawCurrentPane,
              pane_target: healedFromCurrentPane.paneTarget,
              matched_session: sessionName,
              result: 'resolved',
            });
            return healedFromCurrentPane;
          }
        }
      } catch {
        // Fall through to target_is_hud_pane rejection.
      }
    }
    await decisionTrace(cwd, 'tmux_injection.resolve_target_rejected', {
      trace_id: traceId,
      candidate_source: 'hud_session_heal',
      target_type: 'session',
      target_value: sessionName,
      matched_session: sessionName,
      reason: 'target_is_hud_pane',
      result: 'rejected',
    });
    return { paneTarget: null, reason: 'target_is_hud_pane' };
  }
  await decisionTrace(cwd, 'tmux_injection.resolve_target_candidate', {
    trace_id: traceId,
    candidate_source: 'hud_session_heal',
    target_type: 'session',
    target_value: sessionName,
    pane_target: healedPaneId,
    matched_session: sessionName,
    result: 'resolved',
  });
  return finalizeResolvedPane(healedPaneId, 'healed_hud_pane_target', expectedCwd);
}

export async function resolveSessionToPane(sessionName: string): Promise<string | null> {
  const result = await runProcess('tmux', ['list-panes', '-t', sessionName, '-F', '#{pane_id}\t#{pane_active}\t#{pane_current_command}\t#{pane_start_command}']);
  const rows: TmuxSessionRow[] = result.stdout
    .split('\n')
    .map((line: string) => line.trim())
    .filter(Boolean)
    .map((line: string) => {
      const parts = line.includes('\t')
        ? line.split('\t')
        : line.split(/\s+/, 4);
      const [paneId = '', activeRaw = '0', currentCommand = '', startCommand = ''] = parts;
      return {
        paneId,
        active: activeRaw === '1',
        currentCommand: safeString(currentCommand).trim().toLowerCase(),
        startCommand: safeString(startCommand).trim(),
      };
    })
    .filter((row) => row.paneId.startsWith('%'));
  await decisionTrace(process.cwd(), 'tmux_injection.resolve_session_rows', {
    session_name: safeString(sessionName).trim(),
    row_count: rows.length,
    rows: rows.map((row) => ({
      pane_id: row.paneId,
      active: row.active,
      current_command: row.currentCommand,
      start_command: row.startCommand,
    })),
    result: rows.length > 0 ? 'observed' : 'empty',
  });
  if (rows.length === 0) return null;

  const nonHudRows = rows.filter((row) => !isHudPaneStartCommand(row.startCommand));
  const canonicalRows = nonHudRows.filter((row) => /\bcodex\b/i.test(row.startCommand));
  const activeCanonical = canonicalRows.find((row) => row.active);
  if (activeCanonical) return activeCanonical.paneId;
  if (canonicalRows[0]) return canonicalRows[0].paneId;

  const activeNonHud = nonHudRows.find((row) => row.active);
  if (activeNonHud) return activeNonHud.paneId;
  return nonHudRows[0]?.paneId || null;
}

export async function resolvePaneTarget(
  target: TmuxTargetConfig | null,
  fallbackPane: string,
  expectedCwd: string,
  modePane: string,
): Promise<PaneResolutionResult> {
  const traceId = tmuxInjectionTraceId(target);
  await decisionTrace(process.cwd(), 'tmux_injection.resolve_target_start', {
    trace_id: traceId,
    target,
    fallback_pane: safeString(fallbackPane).trim(),
    tmux_pane_env: safeString(process.env.TMUX_PANE).trim(),
    expected_cwd: safeString(expectedCwd).trim(),
    mode_pane: safeString(modePane).trim(),
    result: 'start',
  });
  const canonicalFallbackPane = safeString(fallbackPane).trim();
  if (canonicalFallbackPane) {
    try {
      const resolved = await finalizeResolvedPane(canonicalFallbackPane, 'fallback_current_pane', expectedCwd);
      await decisionTrace(process.cwd(), 'tmux_injection.resolve_target_result', {
        trace_id: traceId,
        pane_target: resolved.paneTarget,
        candidate_source: 'fallback_current_pane',
        reason: resolved.reason,
        matched_session: resolved.matched_session,
        result: resolved.paneTarget ? 'resolved' : 'skipped',
      });
      return resolved;
    } catch {
      // Fall through to mode/config probes
    }
  }

  const rawCurrentPane = safeString(process.env.TMUX_PANE).trim();
  if (rawCurrentPane && rawCurrentPane !== canonicalFallbackPane) {
    try {
      const resolved = await resolveCanonicalPaneFromPaneTarget(rawCurrentPane, expectedCwd);
      if (shouldReturnResolvedPane(resolved)) {
        const result = {
          ...resolved,
          reason: resolved.reason === 'ok' ? 'fallback_tmux_pane_env' : resolved.reason,
        };
        await decisionTrace(process.cwd(), 'tmux_injection.resolve_target_result', {
          trace_id: traceId,
          pane_target: result.paneTarget,
          candidate_source: 'fallback_tmux_pane_env',
          reason: result.reason,
          matched_session: result.matched_session,
          result: 'resolved',
        });
        return result;
      }
    } catch {
      // Fall through to mode/config probes
    }
  }

  if (modePane) {
    try {
      const resolved = await resolveCanonicalPaneFromPaneTarget(modePane, expectedCwd);
      if (shouldReturnResolvedPane(resolved)) {
        const result = {
          ...resolved,
          reason: resolved.reason === 'ok' ? 'fallback_mode_state_pane' : resolved.reason,
        };
        await decisionTrace(process.cwd(), 'tmux_injection.resolve_target_result', {
          trace_id: traceId,
          pane_target: result.paneTarget,
          candidate_source: 'fallback_mode_state_pane',
          reason: result.reason,
          matched_session: result.matched_session,
          result: 'resolved',
        });
        return result;
      }
    } catch {
      // Fall through to config probes
    }
  }

  if (!target) return { paneTarget: null, reason: 'invalid_target' };

  if (target.type === 'pane') {
    try {
      const resolved = await resolveCanonicalPaneFromPaneTarget(target.value, expectedCwd);
      if (shouldReturnResolvedPane(resolved)) {
        await decisionTrace(process.cwd(), 'tmux_injection.resolve_target_result', {
          trace_id: traceId,
          pane_target: resolved.paneTarget,
          candidate_source: 'explicit_pane_target',
          reason: resolved.reason,
          matched_session: resolved.matched_session,
          result: 'resolved',
        });
        return resolved;
      }
    } catch {
      // Fall through
    }
  } else {
    try {
      const paneId = await resolveSessionToPane(target.value);
      if (paneId) {
        const resolved = await finalizeResolvedPane(paneId, 'ok', expectedCwd);
        await decisionTrace(process.cwd(), 'tmux_injection.resolve_target_result', {
          trace_id: traceId,
          pane_target: resolved.paneTarget,
          candidate_source: 'session_target',
          reason: resolved.reason,
          matched_session: resolved.matched_session,
          result: 'resolved',
        });
        return resolved;
      }
    } catch {
      // Fall through
    }
  }

  const result = { paneTarget: null, reason: 'target_not_found' };
  await decisionTrace(process.cwd(), 'tmux_injection.resolve_target_result', {
    trace_id: traceId,
    pane_target: null,
    candidate_source: 'final',
    reason: result.reason,
    result: 'missing',
  });
  return result;
}

export async function handleTmuxInjection({
  payload,
  cwd,
  stateDir,
  logsDir,
}: HandleTmuxInjectionArgs): Promise<void> {
  const omxDir = join(cwd, '.omx');
  const configPath = join(omxDir, 'tmux-hook.json');
  const hookStatePath = join(stateDir, 'tmux-hook-state.json');
  const nowIso = new Date().toISOString();
  const now = Date.now();

  const rawConfig = await readJsonIfExists(configPath, null);
  const config = normalizeTmuxHookConfig(rawConfig);

  const turnId = safeString(payload['turn-id'] || payload.turn_id || '');
  const threadId = safeString(payload['thread-id'] || payload.thread_id || '');
  const sessionKey = threadId || 'unknown';
  const assistantMessage = safeString(payload['last-assistant-message'] || payload.last_assistant_message || '');

  const { normalizeInputMessages } = await import('./payload-parser.js');
  const inputMessages = normalizeInputMessages(payload);
  const sourceText = inputMessages.join('\n');
  const state: TmuxState = normalizeTmuxState(await readJsonIfExists(hookStatePath, null));
  state.recent_keys = pruneRecentKeys(state.recent_keys, now);

  const activeModes: string[] = [];
  const activeModeStates: Record<string, ActiveModeState> = {};
  const scannedStateDirs = new Set<string>();
  const payloadSessionId = safeString(payload.session_id || payload['session-id'] || '');
  const scanActiveModeStateDirs = async (dirs: string[], preserveExisting = false) => {
    for (const scopedDir of dirs) {
      const resolvedScopedDir = resolvePath(scopedDir);
      if (scannedStateDirs.has(resolvedScopedDir)) continue;
      scannedStateDirs.add(resolvedScopedDir);

      const files = await readdir(scopedDir).catch(() => []);
      for (const file of files) {
        if (!file.endsWith('-state.json') || file === 'tmux-hook-state.json') continue;
        const path = join(scopedDir, file);
        const parsed = JSON.parse(await readFile(path, 'utf-8'));
        if (parsed && parsed.active) {
          const modeName = file.replace('-state.json', '');
          activeModes.push(modeName);
          if (!preserveExisting || !activeModeStates[modeName]) {
            activeModeStates[modeName] = parsed as ActiveModeState;
          }
        }
      }
    }
  };
  try {
    const scopedDirs = await getScopedStateDirsForCurrentSession(stateDir, payloadSessionId);
    await scanActiveModeStateDirs(scopedDirs);

    if (!pickActiveMode(activeModes, config.allowed_modes) && !scannedStateDirs.has(resolvePath(stateDir))) {
      await scanActiveModeStateDirs([stateDir], true);
    }
  } catch {
    // Non-fatal
  }

  const mode = pickActiveMode(activeModes, config.allowed_modes);
  await decisionTrace(cwd, 'tmux_injection.mode_scan', {
    active_modes: activeModes,
    allowed_modes: config.allowed_modes,
    selected_mode: mode,
    result: mode ? 'selected' : 'none',
  });
  const modeState: ActiveModeState = mode ? (activeModeStates[mode] || {}) : {};
  const modePane = safeString(modeState.tmux_pane_id || '');
  const preGuard = evaluateInjectionGuards({
    config,
    mode,
    sourceText,
    assistantMessage,
    threadId,
    turnId,
    sessionKey,
    skipQuotaChecks: true,
    now,
    state,
  });

  const baseLog: Record<string, unknown> = {
    timestamp: nowIso,
    type: 'tmux_hook',
    mode,
    reason: preGuard.reason,
    turn_id: turnId,
    thread_id: threadId,
    target: config.target,
    dry_run: config.dry_run,
    sent: false,
  };

  if (!preGuard.allow) {
    state.last_reason = preGuard.reason;
    state.last_event_at = nowIso;
    await writeFile(hookStatePath, JSON.stringify(state, null, 2)).catch(() => {});
    if (config.enabled || config.log_level === 'debug') {
      await logTmuxHookEvent(logsDir, { ...baseLog, event: 'injection_skipped' });
    }
    await decisionTrace(cwd, 'tmux_injection.guard_result', {
      reason: preGuard.reason,
      pane_target: null,
      result: 'skipped',
    });
    return;
  }

  const { renderPrompt, injectLanguageReminder } = await import('./payload-parser.js');
  const prompt = injectLanguageReminder(renderPrompt(config.prompt_template, {
    mode: mode || 'unknown',
    threadId,
    turnId,
    timestamp: nowIso,
  }), sourceText);
  const fallbackPane = resolveCodexPane();
  const resolution = await resolvePaneTarget(config.target, fallbackPane, cwd, modePane);
  if (!resolution.paneTarget) {
    state.last_reason = resolution.reason;
    state.last_event_at = nowIso;
    await writeFile(hookStatePath, JSON.stringify(state, null, 2)).catch(() => {});
    await logTmuxHookEvent(logsDir, {
      ...baseLog,
      event: 'injection_skipped',
      reason: resolution.reason,
      pane_cwd: resolution.pane_cwd,
      expected_cwd: resolution.expected_cwd,
    });
    await decisionTrace(cwd, 'tmux_injection.resolve_target_result', {
      pane_target: null,
      reason: resolution.reason,
      pane_cwd: resolution.pane_cwd,
      expected_cwd: resolution.expected_cwd,
      result: 'missing',
    });
    return;
  }
  const paneTarget = resolution.paneTarget;

  // Final guard phase: pane is canonical identity for quota/cooldown.
  const guard = evaluateInjectionGuards({
    config,
    mode,
    sourceText,
    assistantMessage,
    threadId,
    turnId,
    paneKey: paneTarget,
    sessionKey,
    now,
    state,
  });
  if (!guard.allow) {
    state.last_reason = guard.reason;
    state.last_event_at = nowIso;
    await writeFile(hookStatePath, JSON.stringify(state, null, 2)).catch(() => {});
    await logTmuxHookEvent(logsDir, { ...baseLog, event: 'injection_skipped', reason: guard.reason });
    await decisionTrace(cwd, 'tmux_injection.guard_result', {
      pane_target: paneTarget,
      reason: guard.reason,
      result: 'skipped',
    });
    return;
  }

  // Pane-canonical healing: persist resolved pane target so routing stops depending on session names or stale pane ids.
  if (config.target && (config.target.type !== 'pane' || safeString(config.target.value).trim() !== paneTarget)) {
    try {
      const healed = {
        ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}),
        target: { type: 'pane', value: paneTarget },
      };
      await writeFile(configPath, JSON.stringify(healed, null, 2) + '\n');
      await logTmuxHookEvent(logsDir, {
        ...baseLog,
        event: 'target_healed',
        reason: 'migrated_to_pane_target',
        previous_target: config.target.value,
        healed_target: paneTarget,
      });
    } catch {
      // Non-fatal
    }
  }

  const argv = buildSendKeysArgv({
    paneTarget,
    prompt,
    dryRun: config.dry_run,
  });

  const updateStateForAttempt = (success: boolean, reason: string) => {
    if (guard.dedupeKey) state.recent_keys[guard.dedupeKey] = now;
    state.last_reason = reason;
    state.last_event_at = nowIso;
    if (success) {
      state.last_injection_ts = now;
      state.total_injections = (asNumber(state.total_injections) ?? 0) + 1;
      state.pane_counts = state.pane_counts && typeof state.pane_counts === 'object' ? state.pane_counts : {};
      state.pane_counts[paneTarget] = (asNumber(state.pane_counts[paneTarget]) ?? 0) + 1;
      state.last_target = paneTarget;
      state.last_prompt_preview = prompt.slice(0, 120);
    }
  };

  if (!argv) {
    updateStateForAttempt(false, 'send_failed');
    await writeFile(hookStatePath, JSON.stringify(state, null, 2)).catch(() => {});
    await logTmuxHookEvent(logsDir, {
      ...baseLog,
      event: 'injection_error',
      reason: 'send_failed',
      pane_target: paneTarget,
      error: 'missing_send_argv',
    });
    await decisionTrace(cwd, 'tmux_injection.send_result', {
      pane_target: paneTarget,
      reason: 'send_failed',
      error: 'missing_send_argv',
      result: 'error',
    });
    return;
  }

  // Shared pane-state guard: skip injection when the target pane is scrolling,
  // has returned to a shell, is still bootstrapping, or is visibly busy.
  try {
    const paneGuard = await evaluatePaneInjectionReadiness(paneTarget, {
      skipIfScrolling: config.skip_if_scrolling,
    });
    if (!paneGuard.ok) {
      const reason = mapPaneInjectionReadinessReason(paneGuard.reason);
      state.last_reason = reason;
      state.last_event_at = nowIso;
      await writeFile(hookStatePath, JSON.stringify(state, null, 2)).catch(() => {});
      await logTmuxHookEvent(logsDir, {
        ...baseLog,
        event: 'injection_skipped',
        reason,
        pane_target: paneTarget,
        pane_current_command: paneGuard.paneCurrentCommand || undefined,
        pane_capture_excerpt: paneGuard.paneCapture ? paneGuard.paneCapture.slice(-200) : undefined,
      });
      await decisionTrace(cwd, 'tmux_injection.guard_result', {
        pane_target: paneTarget,
        reason,
        pane_current_command: paneGuard.paneCurrentCommand || undefined,
        pane_capture_excerpt: paneGuard.paneCapture ? paneGuard.paneCapture.slice(-200) : undefined,
        result: 'skipped',
      });
      return;
    }
  } catch {
    // Non-fatal: if querying pane state fails, proceed with injection.
  }

  if (config.dry_run) {
    updateStateForAttempt(false, 'dry_run');
    await writeFile(hookStatePath, JSON.stringify(state, null, 2)).catch(() => {});
    await logTmuxHookEvent(logsDir, {
      ...baseLog,
      event: 'injection_dry_run',
      reason: 'dry_run',
      pane_target: paneTarget,
      argv,
    });
    await decisionTrace(cwd, 'tmux_injection.send_result', {
      pane_target: paneTarget,
      reason: 'dry_run',
      argv,
      result: 'dry_run',
    });
    return;
  }

  try {
    const sendResult = await sendPaneInput({
      paneTarget,
      prompt,
      submitKeyPresses: argv.submitArgv.length,
      submitDelayMs: 25,
    });
    if (!sendResult.ok) {
      throw new Error(sendResult.error || sendResult.reason);
    }
    updateStateForAttempt(true, 'injection_sent');
    await writeFile(hookStatePath, JSON.stringify(state, null, 2)).catch(() => {});
    await logTmuxHookEvent(logsDir, {
      ...baseLog,
      event: 'injection_sent',
      reason: 'ok',
      pane_target: paneTarget,
      sent: true,
      argv,
    });
    await decisionTrace(cwd, 'tmux_injection.send_result', {
      pane_target: paneTarget,
      reason: 'ok',
      argv,
      result: 'sent',
    });
  } catch (err) {
    updateStateForAttempt(false, 'send_failed');
    await writeFile(hookStatePath, JSON.stringify(state, null, 2)).catch(() => {});
    await logTmuxHookEvent(logsDir, {
      ...baseLog,
      event: 'injection_error',
      reason: 'send_failed',
      pane_target: paneTarget,
      error: err instanceof Error ? err.message : safeString(err),
    });
    await decisionTrace(cwd, 'tmux_injection.send_result', {
      pane_target: paneTarget,
      reason: 'send_failed',
      error: err instanceof Error ? err.message : safeString(err),
      result: 'error',
    });
  }
}
