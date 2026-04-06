#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ExtractTestDebugOptions {
  root: string;
  filter: string;
  latest: number | null;
  currentRun: boolean;
  currentRunWindowMs: number;
  help: boolean;
}

interface ArtifactDirMeta {
  name: string;
  dir: string;
  updatedAtMs: number;
  updatedAt: string | null;
}

interface SummarizeOptions {
  latest?: number | null;
  currentRun?: boolean;
  currentRunWindowMs?: number;
}

const DEFAULT_CURRENT_RUN_WINDOW_MS = 10 * 60 * 1000;

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asPositiveInteger(value: string, fallback: number | null): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toIsoOrNull(value: number): string | null {
  return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;
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

async function readMtimeMs(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

async function collectArtifactDirMetas(root: string, filter: string): Promise<ArtifactDirMeta[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const metas: ArtifactDirMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!includeFilter(entry.name, filter)) continue;
    const dir = join(root, entry.name);
    const files = await readdir(dir).catch(() => []);
    const filePaths = files.map((name) => join(dir, name));
    const mtimes = await Promise.all(filePaths.map((path) => readMtimeMs(path)));
    const ownDirMtime = await readMtimeMs(dir);
    const updatedAtMs = Math.max(ownDirMtime, ...mtimes, 0);
    metas.push({
      name: entry.name,
      dir,
      updatedAtMs,
      updatedAt: toIsoOrNull(updatedAtMs),
    });
  }
  return metas;
}

function selectArtifactDirMetas(
  metas: ArtifactDirMeta[],
  options: SummarizeOptions = {},
): {
  selected: ArtifactDirMeta[];
  selectionMode: 'all' | 'latest' | 'current_run';
  totalMatchingDirs: number;
  omittedHistoricalCount: number;
  newestArtifactUpdatedAt: string | null;
  oldestSelectedArtifactUpdatedAt: string | null;
  currentRunWindowMs: number | null;
} {
  const totalMatchingDirs = metas.length;
  const newestFirst = [...metas].sort((a, b) => b.updatedAtMs - a.updatedAtMs || a.name.localeCompare(b.name));
  const newestArtifactUpdatedAt = newestFirst[0]?.updatedAt ?? null;
  const latest = options.latest ?? null;
  const currentRun = options.currentRun ?? false;
  const currentRunWindowMs = options.currentRunWindowMs ?? DEFAULT_CURRENT_RUN_WINDOW_MS;

  let selectionMode: 'all' | 'latest' | 'current_run' = 'all';
  let selected = [...metas].sort((a, b) => a.name.localeCompare(b.name));

  if (currentRun && newestFirst.length > 0) {
    selectionMode = 'current_run';
    const newestMs = newestFirst[0].updatedAtMs;
    selected = newestFirst.filter((meta) => newestMs - meta.updatedAtMs <= currentRunWindowMs);
  } else if (latest !== null) {
    selectionMode = 'latest';
    selected = newestFirst.slice(0, latest);
  }

  const oldestSelectedArtifactUpdatedAt = selected.length > 0
    ? toIsoOrNull(Math.min(...selected.map((meta) => meta.updatedAtMs).filter((value) => Number.isFinite(value) && value > 0)))
    : null;

  return {
    selected,
    selectionMode,
    totalMatchingDirs,
    omittedHistoricalCount: Math.max(0, totalMatchingDirs - selected.length),
    newestArtifactUpdatedAt,
    oldestSelectedArtifactUpdatedAt,
    currentRunWindowMs: selectionMode === 'current_run' ? currentRunWindowMs : null,
  };
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

export async function summarizeArtifactDir(
  root: string,
  filter: string,
  options: SummarizeOptions = {},
): Promise<{
  summaries: Record<string, unknown>[];
  selection_mode: 'all' | 'latest' | 'current_run';
  total_matching_dirs: number;
  omitted_historical_count: number;
  newest_artifact_updated_at: string | null;
  oldest_selected_artifact_updated_at: string | null;
  current_run_window_ms: number | null;
}> {
  const metas = await collectArtifactDirMetas(root, filter);
  const selection = selectArtifactDirMetas(metas, options);
  const summaries: Record<string, unknown>[] = [];
  for (const meta of selection.selected) {
    const dir = meta.dir;
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
      const name = meta.name.toLowerCase();
      if (name.includes('dispatch')) return 'dispatch';
      if (name.includes('team-nudge')) return 'leader-nudge';
      if (name.includes('fallback')) return 'watcher';
      if (name.includes('tmux-heal')) return 'tmux-heal';
      return 'unknown';
    })();

    summaries.push({
      artifact_dir: dir,
      name: meta.name,
      family,
      artifact_updated_at: meta.updatedAt,
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
  return {
    summaries,
    selection_mode: selection.selectionMode,
    total_matching_dirs: selection.totalMatchingDirs,
    omitted_historical_count: selection.omittedHistoricalCount,
    newest_artifact_updated_at: selection.newestArtifactUpdatedAt,
    oldest_selected_artifact_updated_at: selection.oldestSelectedArtifactUpdatedAt,
    current_run_window_ms: selection.currentRunWindowMs,
  };
}

export function parseExtractTestDebugOptions(
  argv: readonly string[],
  cwd = process.cwd(),
): ExtractTestDebugOptions {
  const getValue = (name: string, fallback = ''): string => {
    const index = argv.indexOf(name);
    if (index < 0 || index + 1 >= argv.length) return fallback;
    return argv[index + 1] ?? fallback;
  };
  const rootArg = getValue('--root', '');
  const filter = getValue('--filter', '');
  const latest = asPositiveInteger(getValue('--latest', ''), null);
  const currentRunWindowMs = asPositiveInteger(getValue('--current-run-window-ms', ''), DEFAULT_CURRENT_RUN_WINDOW_MS) ?? DEFAULT_CURRENT_RUN_WINDOW_MS;
  return {
    root: resolve(rootArg || join(cwd, '.omx', 'test-artifacts')),
    filter,
    latest,
    currentRun: argv.includes('--current-run'),
    currentRunWindowMs,
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

function renderHelp(): string {
  return [
    'Usage: extract-test-debug [--root <dir>] [--filter <text>] [--latest <n>] [--current-run] [--current-run-window-ms <ms>]',
    '',
    'Options:',
    '  --root <dir>                  Artifact root. Defaults to <cwd>/.omx/test-artifacts.',
    '  --filter <text>              Case-insensitive artifact name filter.',
    '  --latest <n>                 Include only the latest N matching artifact directories.',
    '  --current-run                Include artifact directories updated within the current-run window of the newest match.',
    `  --current-run-window-ms <ms> Window used by --current-run. Default: ${DEFAULT_CURRENT_RUN_WINDOW_MS}.`,
    '  --help, -h                   Show this help text.',
    '',
    'Output:',
    '  selection_mode               all | latest | current_run',
    '  total_matching_dirs          Count before latest/current-run selection.',
    '  omitted_historical_count     Matching directories excluded by selection.',
  ].join('\n');
}

async function main(): Promise<void> {
  const options = parseExtractTestDebugOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${renderHelp()}\n`);
    return;
  }
  if (!existsSync(options.root)) {
    console.error(`extract-test-debug: artifact root not found: ${options.root}`);
    process.exit(1);
  }
  const summary = await summarizeArtifactDir(options.root, options.filter, {
    latest: options.latest,
    currentRun: options.currentRun,
    currentRunWindowMs: options.currentRunWindowMs,
  });
  const output = {
    root: options.root,
    filter: options.filter,
    count: summary.summaries.length,
    selection_mode: summary.selection_mode,
    total_matching_dirs: summary.total_matching_dirs,
    omitted_historical_count: summary.omitted_historical_count,
    newest_artifact_updated_at: summary.newest_artifact_updated_at,
    oldest_selected_artifact_updated_at: summary.oldest_selected_artifact_updated_at,
    current_run_window_ms: summary.current_run_window_ms,
    generated_at: new Date().toISOString(),
    summaries: summary.summaries,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`extract-test-debug: ${message}`);
    process.exit(1);
  });
}
