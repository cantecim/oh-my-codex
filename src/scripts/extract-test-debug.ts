#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

function argValue(name: string, fallback = ''): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readJsonl(path: string): Promise<Record<string, unknown>[]> {
  try {
    const content = await readFile(path, 'utf-8');
    return content.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function includeFilter(name: string, filter: string): boolean {
  const normalized = filter.trim().toLowerCase();
  if (!normalized) return true;
  return name.toLowerCase().includes(normalized);
}

function isFailureLikeDecision(entry: Record<string, unknown>): boolean {
  const reason = safeString(entry.reason).trim();
  const event = safeString(entry.event).trim();
  const result = safeString(entry.result).trim();
  if (result === 'failed' || result === 'error' || result === 'missing' || result === 'rejected') return true;
  if (result === 'skipped' && reason !== '') return true;
  if (result === 'not_alive' || result === 'timeout') return true;
  const combined = `${event} ${reason}`.toLowerCase();
  return (
    combined.includes('target_not_found')
    || combined.includes('pane_cwd_mismatch')
    || combined.includes('pane_has_active_task')
    || combined.includes('tmux_send_keys_unconfirmed')
    || combined.includes('dispatch_drain_failed')
    || combined.includes('worker_panes_alive')
  );
}

function buildEffectiveFailureBranch(
  processTrace: Record<string, unknown>[],
  decisionTrace: Record<string, unknown>[],
  sendKeysSeen: boolean,
): Record<string, unknown> | null {
  const reversedDecisionTrace = [...decisionTrace].reverse();
  const terminalDecision = reversedDecisionTrace.find((entry) => {
    const event = safeString(entry.event).trim();
    return event === 'tmux_injection.resolve_target_result' || event === 'tmux_injection.guard_result';
  });
  if (terminalDecision && isFailureLikeDecision(terminalDecision)) return terminalDecision;

  const candidateRejection = reversedDecisionTrace.find((entry) => {
    const event = safeString(entry.event).trim();
    return event === 'tmux_injection.resolve_target_rejected' || event === 'tmux_injection.resolve_target_candidate';
  });
  if (candidateRejection && isFailureLikeDecision(candidateRejection)) return candidateRejection;

  if (!sendKeysSeen) {
    const timeoutEntry = processTrace.find((entry) => safeString(entry.status).trim() === 'timeout');
    if (timeoutEntry) {
      return {
        source: 'process_trace',
        timestamp: timeoutEntry.timestamp ?? null,
        cwd: timeoutEntry.cwd ?? null,
        command: timeoutEntry.command ?? null,
        argv: timeoutEntry.argv ?? null,
        invocation_id: timeoutEntry.invocation_id ?? null,
        command_role: timeoutEntry.command_role ?? null,
        reason: 'process_timeout',
        result: 'timeout',
      };
    }
  }
  return reversedDecisionTrace.find((entry) => isFailureLikeDecision(entry)) || null;
}

async function summarizeArtifactDir(root: string, filter: string): Promise<Record<string, unknown>[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const summaries: Record<string, unknown>[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!includeFilter(entry.name, filter)) continue;
    const dir = join(root, entry.name);
    const files = await readdir(dir).catch(() => []);
    const manifest = await readJson(join(dir, 'manifest.json'));
    const paths = await readJson(join(dir, 'paths.json'));
    const testManifest = await readJson(join(dir, 'test-manifest.json'));
    const envBefore = await readJson(join(dir, 'env-before.json'));
    const envAfter = await readJson(join(dir, 'env-after.json'));
    const envDiff = await readJson(join(dir, 'env-diff.json'));
    const lifecycle = await readJsonl(join(dir, 'lifecycle.jsonl'));
    const processTrace = await readJsonl(join(dir, 'process-runner.jsonl'));
    const decisionTrace = await readJsonl(join(dir, 'decision-trace.jsonl'));
    const tmuxMeta = await readJsonl(join(dir, 'tmux.log.meta.jsonl'));
    const preservedDir = safeString(paths?.cwd || manifest?.cwd).trim();
    const tmuxLogPath = preservedDir ? join(preservedDir, 'tmux.log') : join(dir, 'tmux.log');
    const tmuxLogExists = existsSync(tmuxLogPath);
    const tmuxLog = tmuxLogExists ? await readFile(tmuxLogPath, 'utf-8').catch(() => '') : '';
    const sendKeysSeen = /send-keys\b/.test(tmuxLog)
      || processTrace.some((entry) => safeString(entry.command) === 'tmux' && safeString((entry.argv as string[] | undefined)?.[0]) === 'send-keys')
      || tmuxMeta.some((entry) => safeString(entry.cmd) === 'send-keys' || safeString(entry.branch) === 'send-keys');
    const tmuxCalled = tmuxMeta.length > 0 || tmuxLog.length > 0 || processTrace.some((entry) => safeString(entry.command) === 'tmux');
    const lastDecision = decisionTrace.at(-1) ?? null;
    const cleanupRemovedArtifacts = lifecycle.some((entry) => safeString(entry.type) === 'temp_dir_cleanup_finished');
    const resolvedTmux = processTrace
      .map((entry) => safeString(entry.resolved_command))
      .find((value) => value.includes('tmux')) || null;
    const fakeTmuxPath = safeString(testManifest?.fake_tmux_path).trim();
    const tmuxMetaExitCodes = tmuxMeta
      .map((entry) => Number(entry.exit_code))
      .filter((value) => Number.isFinite(value));
    const childTraceMissing = tmuxLogExists && processTrace.length === 0 && decisionTrace.length === 0;
    const foundationRegressionSuspected = !tmuxCalled && fakeTmuxPath !== '';
    const fakeTmuxParseErrorSuspected = tmuxMetaExitCodes.some((code) => code !== 0);
    const artifactPreserved = lifecycle.some((entry) => safeString(entry.type) === 'temp_dir_preserved');
    const traceIds = Array.from(new Set(
      [
        ...decisionTrace.map((entry) => safeString(entry.trace_id)),
        ...processTrace.map((entry) => safeString(entry.trace_id)),
      ].filter(Boolean),
    ));
    const invocationIds = Array.from(new Set(
      [
        ...processTrace.map((entry) => safeString(entry.invocation_id)),
        ...tmuxMeta.map((entry) => safeString(entry.invocation_id)),
      ].filter(Boolean),
    ));
    const commandRolesSeen = Array.from(new Set(
      [
        ...processTrace.map((entry) => safeString(entry.command_role)),
        ...tmuxMeta.map((entry) => safeString(entry.command_role)),
      ].filter(Boolean),
    ));
    const processInvocationIds = new Set(processTrace.map((entry) => safeString(entry.invocation_id)).filter(Boolean));
    const tmuxInvocationIds = new Set(tmuxMeta.map((entry) => safeString(entry.invocation_id)).filter(Boolean));
    const unmatchedTmuxInvocations = [...tmuxInvocationIds].filter((id) => !processInvocationIds.has(id)).length;
    const unmatchedProcessInvocations = [...processInvocationIds].filter((id) => !tmuxInvocationIds.has(id)).length;
    const envDiffKeys = envDiff ? Object.keys(envDiff) : [];
    const envDriftDetected = envDiffKeys.length > 0;
    const pathHeadBefore = safeString(envBefore?.PATH).split(':').filter(Boolean).slice(0, 3);
    const pathHeadAfter = safeString(envAfter?.PATH).split(':').filter(Boolean).slice(0, 3);
    const lastEvent = lastDecision ? safeString(lastDecision.event) : '';
    const firstWrongBranch = decisionTrace.find((entry) => isFailureLikeDecision(entry)) || null;
    const effectiveFailureBranch = buildEffectiveFailureBranch(processTrace, decisionTrace, sendKeysSeen);
    const family = (() => {
      const name = entry.name.toLowerCase();
      if (name.includes('dispatch')) return 'dispatch';
      if (name.includes('team-nudge')) return 'leader-nudge';
      if (name.includes('fallback')) return 'watcher';
      if (name.includes('tmux-heal')) return 'tmux-heal';
      return 'unknown';
    })();

    summaries.push({
      artifact_dir: dir,
      name: entry.name,
      family,
      manifest,
      paths,
      test_manifest: testManifest,
      env_before: envBefore,
      env_after: envAfter,
      env_diff: envDiff,
      files: files.sort(),
      trace_ids: traceIds,
      invocation_ids: invocationIds,
      command_roles_seen: commandRolesSeen,
      tmux_called: tmuxCalled,
      tmux_log_created: tmuxLogExists,
      tmux_log_path: tmuxLogPath,
      send_keys_seen: sendKeysSeen,
      cleanup_removed_artifacts: cleanupRemovedArtifacts,
      selected_tmux_binary_path: resolvedTmux,
      process_trace_events: processTrace.length,
      decision_trace_events: decisionTrace.length,
      tmux_meta_events: tmuxMeta.length,
      foundation_regression_suspected: foundationRegressionSuspected,
      child_trace_missing: childTraceMissing,
      fake_tmux_parse_error_suspected: fakeTmuxParseErrorSuspected,
      artifact_preserved: artifactPreserved,
      env_drift_detected: envDriftDetected,
      env_diff_keys: envDiffKeys,
      path_head_before: pathHeadBefore,
      path_head_after: pathHeadAfter,
      unmatched_tmux_invocations: unmatchedTmuxInvocations,
      unmatched_process_invocations: unmatchedProcessInvocations,
      last_event: lastEvent,
      first_wrong_branch: firstWrongBranch,
      effective_failure_branch: effectiveFailureBranch,
      last_decision_reason: lastDecision ? safeString(lastDecision.reason || lastDecision.event) : '',
      last_decision: lastDecision,
    });
  }
  return summaries.sort((a, b) => safeString(a.name).localeCompare(safeString(b.name)));
}

async function main(): Promise<void> {
  const rootArg = argValue('--root', '');
  const filter = argValue('--filter', '');
  const root = resolve(rootArg || join(process.cwd(), '.omx', 'test-artifacts'));
  if (!existsSync(root)) {
    console.error(`extract-test-debug: artifact root not found: ${root}`);
    process.exit(1);
  }
  const summaries = await summarizeArtifactDir(root, filter);
  const output = {
    root,
    filter,
    count: summaries.length,
    generated_at: new Date().toISOString(),
    summaries,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`extract-test-debug: ${message}`);
  process.exit(1);
});
