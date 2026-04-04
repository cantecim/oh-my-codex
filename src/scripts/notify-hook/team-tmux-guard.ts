import { safeString } from './utils.js';
import { runProcessWithTrace } from './process-runner.js';
import { traceDecision } from '../../debug/runtime-trace.js';
import {
  buildCapturePaneArgv,
  buildPaneInModeArgv,
  buildPaneCurrentCommandArgv,
  buildSendKeysArgv,
  isPaneRunningShell,
  paneHasActiveTask,
  paneLooksReady,
  resolveCodexPane,
  type SendKeysArgv,
} from '../tmux-hook-engine.js';

export interface PaneInjectionReadinessResult {
  ok: boolean;
  sent: boolean;
  reason: string;
  paneTarget: string;
  paneCurrentCommand: string;
  paneCapture: string;
}

export interface SendPaneInputResult {
  ok: boolean;
  sent: boolean;
  reason: string;
  paneTarget: string;
  argv?: SendKeysArgv;
  error?: string;
}

interface PaneInjectionReadinessOptions {
  skipIfScrolling?: boolean;
  captureLines?: number;
  requireRunningAgent?: boolean;
  requireReady?: boolean;
  requireIdle?: boolean;
  preferCanonicalBypass?: boolean;
}

interface SendPaneInputOptions {
  paneTarget: string;
  prompt: string;
  submitKeyPresses?: number;
  submitDelayMs?: number;
  typePrompt?: boolean;
}

export function mapPaneInjectionReadinessReason(reason: unknown): string {
  return reason === 'pane_running_shell' ? 'agent_not_running' : safeString(reason);
}

async function decisionTrace(event: string, payload: Record<string, unknown> = {}): Promise<void> {
  await traceDecision(process.cwd(), 'team-tmux-guard', event, payload).catch(() => {});
}

export async function evaluatePaneInjectionReadiness(paneTarget: string, {
  skipIfScrolling = false,
  captureLines = 80,
  requireRunningAgent = true,
  requireReady = true,
  requireIdle = true,
  preferCanonicalBypass = true,
}: PaneInjectionReadinessOptions = {}): Promise<PaneInjectionReadinessResult> {
  const target = safeString(paneTarget).trim();
  await decisionTrace('pane_guard.readiness_start', {
    pane_target: target,
    skip_if_scrolling: skipIfScrolling,
    capture_lines: captureLines,
    require_running_agent: requireRunningAgent,
    require_ready: requireReady,
    require_idle: requireIdle,
    result: 'start',
  });
  if (!target) {
    const result = {
      ok: false,
      sent: false,
      reason: 'missing_pane_target',
      paneTarget: '',
      paneCurrentCommand: '',
      paneCapture: '',
    };
    await decisionTrace('pane_guard.readiness_result', {
      pane_target: target,
      reason: result.reason,
      result: 'skipped',
    });
    return result;
  }

  // Canonical bypass: if resolveCodexPane confirms this is a codex pane
  // (via pane_start_command), skip all readiness guards. The pane IS running
  // codex even though tmux may report cmd=sh (shell wrapper).
  try {
    if (preferCanonicalBypass && resolveCodexPane() === target) {
      const result = {
        ok: true,
        sent: false,
        reason: 'ok',
        paneTarget: target,
        paneCurrentCommand: 'codex',
        paneCapture: '',
      };
      await decisionTrace('pane_guard.readiness_result', {
        pane_target: target,
        reason: 'resolved_codex_pane',
        result: 'ok',
      });
      return result;
    }
  } catch {
    // Non-fatal: fall through to normal readiness checks
  }

  if (skipIfScrolling) {
    try {
      const modeResult = await runProcessWithTrace('tmux', buildPaneInModeArgv(target), 1000, {
        command_role: 'readiness_mode_probe',
      });
      if (safeString(modeResult.stdout).trim() === '1') {
        return {
          ok: false,
          sent: false,
          reason: 'scroll_active',
          paneTarget: target,
          paneCurrentCommand: '',
          paneCapture: '',
        };
      }
    } catch {
      // Non-fatal: continue with remaining preflight checks.
    }
  }

  let paneCurrentCommand = '';
  let paneRunningShell = false;
  let initialPaneInMode = '';
  try {
    if (skipIfScrolling) {
      try {
        const modeResult = await runProcessWithTrace('tmux', buildPaneInModeArgv(target), 1000, {
          command_role: 'readiness_mode_probe',
        });
        initialPaneInMode = safeString(modeResult.stdout).trim();
        if (initialPaneInMode === '1') {
          return {
            ok: false,
            sent: false,
            reason: 'scroll_active',
            paneTarget: target,
            paneCurrentCommand: '',
            paneCapture: '',
          };
        }
      } catch {
        // Non-fatal: continue with remaining preflight checks.
      }
    }
    const result = await runProcessWithTrace('tmux', buildPaneCurrentCommandArgv(target), 1000, {
      command_role: 'readiness_command_probe',
    });
    paneCurrentCommand = safeString(result.stdout).trim();
    paneRunningShell = requireRunningAgent && isPaneRunningShell(paneCurrentCommand);
    await decisionTrace('pane_guard.current_command', {
      pane_target: target,
      pane_current_command: paneCurrentCommand,
      pane_running_shell: paneRunningShell,
      result: 'observed',
    });
  } catch {
    paneCurrentCommand = '';
  }

  try {
    if (skipIfScrolling && initialPaneInMode !== '1') {
      try {
        const modeRetry = await runProcessWithTrace('tmux', buildPaneInModeArgv(target), 1000, {
          command_role: 'readiness_mode_probe',
        });
        if (safeString(modeRetry.stdout).trim() === '1') {
          return {
            ok: false,
            sent: false,
            reason: 'scroll_active',
            paneTarget: target,
            paneCurrentCommand,
            paneCapture: '',
          };
        }
      } catch {
        // Non-fatal: continue to capture checks.
      }
    }
    const capture = await runProcessWithTrace('tmux', buildCapturePaneArgv(target, captureLines), 1000, {
      command_role: 'readiness_capture',
    });
    const paneCapture = safeString(capture.stdout);
    await decisionTrace('pane_guard.capture_result', {
      pane_target: target,
      pane_current_command: paneCurrentCommand,
      pane_capture_excerpt: paneCapture ? paneCapture.slice(-200) : '',
      result: 'observed',
    });
    if (paneCapture.trim() !== '') {
      const paneShowsLiveAgent = paneLooksReady(paneCapture) || paneHasActiveTask(paneCapture);
      if (paneRunningShell && !paneShowsLiveAgent) {
        const result = {
          ok: false,
          sent: false,
          reason: 'pane_running_shell',
          paneTarget: target,
          paneCurrentCommand,
          paneCapture,
        };
        await decisionTrace('pane_guard.readiness_result', {
          pane_target: target,
          pane_current_command: paneCurrentCommand,
          reason: result.reason,
          result: 'skipped',
        });
        return result;
      }
      if (requireIdle && paneHasActiveTask(paneCapture)) {
        const result = {
          ok: false,
          sent: false,
          reason: 'pane_has_active_task',
          paneTarget: target,
          paneCurrentCommand,
          paneCapture,
        };
        await decisionTrace('pane_guard.readiness_result', {
          pane_target: target,
          pane_current_command: paneCurrentCommand,
          reason: result.reason,
          result: 'skipped',
        });
        return result;
      }
      if (requireReady && !paneLooksReady(paneCapture)) {
        const result = {
          ok: false,
          sent: false,
          reason: 'pane_not_ready',
          paneTarget: target,
          paneCurrentCommand,
          paneCapture,
        };
        await decisionTrace('pane_guard.readiness_result', {
          pane_target: target,
          pane_current_command: paneCurrentCommand,
          reason: result.reason,
          result: 'skipped',
        });
        return result;
      }
    }
    if (paneRunningShell && paneCapture.trim() === '') {
      const result = {
        ok: false,
        sent: false,
        reason: 'pane_running_shell',
        paneTarget: target,
        paneCurrentCommand,
        paneCapture,
      };
      await decisionTrace('pane_guard.readiness_result', {
        pane_target: target,
        pane_current_command: paneCurrentCommand,
        reason: result.reason,
        result: 'skipped',
      });
      return result;
    }
    const result = {
      ok: true,
      sent: false,
      reason: 'ok',
      paneTarget: target,
      paneCurrentCommand,
      paneCapture,
    };
    await decisionTrace('pane_guard.readiness_result', {
      pane_target: target,
      pane_current_command: paneCurrentCommand,
      reason: result.reason,
      result: 'ok',
    });
    return result;
  } catch {
    if (paneRunningShell) {
      const result = {
        ok: false,
        sent: false,
        reason: 'pane_running_shell',
        paneTarget: target,
        paneCurrentCommand,
        paneCapture: '',
      };
      await decisionTrace('pane_guard.readiness_result', {
        pane_target: target,
        pane_current_command: paneCurrentCommand,
        reason: result.reason,
        result: 'skipped',
      });
      return result;
    }
    const result = {
      ok: true,
      sent: false,
      reason: 'ok',
      paneTarget: target,
      paneCurrentCommand,
      paneCapture: '',
    };
    await decisionTrace('pane_guard.readiness_result', {
      pane_target: target,
      pane_current_command: paneCurrentCommand,
      reason: result.reason,
      result: 'ok',
    });
    return result;
  }
}

export async function sendPaneInput({
  paneTarget,
  prompt,
  submitKeyPresses = 2,
  submitDelayMs = 0,
  typePrompt = true,
}: SendPaneInputOptions): Promise<SendPaneInputResult> {
  const target = safeString(paneTarget).trim();
  await decisionTrace('pane_guard.send_start', {
    pane_target: target,
    submit_key_presses: submitKeyPresses,
    submit_delay_ms: submitDelayMs,
    type_prompt: typePrompt,
    prompt_preview: safeString(prompt).slice(0, 120),
    result: 'start',
  });
  if (!target) {
    const result = { ok: false, sent: false, reason: 'missing_pane_target', paneTarget: '' };
    await decisionTrace('pane_guard.send_result', {
      pane_target: target,
      reason: result.reason,
      result: 'error',
    });
    return result;
  }

  const normalizedSubmitKeyPresses = Number.isFinite(submitKeyPresses)
    ? Math.max(0, Math.floor(submitKeyPresses))
    : 2;
  const literalPrompt = safeString(prompt);
  const argv = normalizedSubmitKeyPresses === 0
    ? {
      typeArgv: ['send-keys', '-t', target, '-l', literalPrompt],
      submitArgv: [] as string[][],
    }
    : buildSendKeysArgv({
      paneTarget: target,
      prompt: literalPrompt,
      dryRun: false,
      submitKeyPresses: normalizedSubmitKeyPresses,
    });
  if (!argv) {
    const result = { ok: false, sent: false, reason: 'send_failed', paneTarget: target };
    await decisionTrace('pane_guard.send_result', {
      pane_target: target,
      reason: result.reason,
      result: 'error',
    });
    return result;
  }

  try {
    if (typePrompt) {
      await runProcessWithTrace('tmux', argv.typeArgv, 3000, {
        command_role: 'send_literal',
      });
    }
    for (const submit of argv.submitArgv) {
      if (submitDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, submitDelayMs));
      }
      await runProcessWithTrace('tmux', submit, 3000, {
        command_role: 'submit_keypress',
      });
    }
    const result = { ok: true, sent: true, reason: 'sent', paneTarget: target, argv };
    await decisionTrace('pane_guard.send_result', {
      pane_target: target,
      reason: result.reason,
      argv,
      result: 'ok',
    });
    return result;
  } catch (error) {
    const result = {
      ok: false,
      sent: false,
      reason: 'send_failed',
      paneTarget: target,
      argv,
      error: error instanceof Error ? error.message : safeString(error),
    };
    await decisionTrace('pane_guard.send_result', {
      pane_target: target,
      reason: result.reason,
      argv,
      error: result.error,
      result: 'error',
    });
    return result;
  }
}

export async function checkPaneReadyForTeamSendKeys(paneTarget: string): Promise<PaneInjectionReadinessResult> {
  return evaluatePaneInjectionReadiness(paneTarget);
}
