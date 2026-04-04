import { appendDebugJsonl, isTestDebugEnabled, writeDebugJson, writeDebugFixtureManifest } from '../debug/test-debug.js';

const ENV_TRACE_KEYS = [
  'PATH',
  'HOME',
  'CODEX_HOME',
  'TMUX',
  'TMUX_PANE',
  'OMX_TEST_CAPTURE_FILE',
  'OMX_TEST_CAPTURE_SEQUENCE_FILE',
  'OMX_TEST_CAPTURE_COUNTER_FILE',
  'OMX_TEST_DEBUG',
  'OMX_TEST_ARTIFACTS_DIR',
  'OMX_TEST_DEBUG_TEST_ID',
  'OMX_TEST_TRACE_ID',
  'OMX_TEST_TMUX_INVOCATION_ID',
  'OMX_TEST_TMUX_COMMAND_ROLE',
  'OMX_TEAM_WORKER',
  'OMX_TEAM_STATE_ROOT',
  'OMX_TEAM_LEADER_CWD',
];

export function collectTrackedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const key of ENV_TRACE_KEYS) {
    const value = env[key];
    if (typeof value === 'string') snapshot[key] = value;
  }
  return snapshot;
}

export function diffTrackedEnv(
  before: Record<string, string>,
  after: Record<string, string>,
): Record<string, { before?: string; after?: string }> {
  const diff: Record<string, { before?: string; after?: string }> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const prev = before[key];
    const next = after[key];
    if (prev === next) continue;
    diff[key] = {};
    if (prev !== undefined) diff[key].before = prev;
    if (next !== undefined) diff[key].after = next;
  }
  return diff;
}

export async function recordTempDirFixtureCreated(dir: string, prefix: string): Promise<Record<string, string> | null> {
  if (!isTestDebugEnabled()) return null;
  const envBefore = collectTrackedEnv();
  await writeDebugFixtureManifest(dir, {
    type: 'temp_dir_fixture',
    prefix,
  });
  await writeDebugJson(dir, 'env-before.json', envBefore);
  await appendDebugJsonl(dir, 'lifecycle.jsonl', {
    type: 'temp_dir_created',
    prefix,
    cwd: dir,
  });
  return envBefore;
}

export async function recordTempDirFixtureFinished(dir: string): Promise<void> {
  if (!isTestDebugEnabled()) return;
  const envAfter = collectTrackedEnv();
  const restoredEnv = collectTrackedEnv();
  const envDiff = diffTrackedEnv(envAfter, restoredEnv);
  await writeDebugJson(dir, 'env-after.json', restoredEnv);
  await writeDebugJson(dir, 'env-diff.json', envDiff);
  await appendDebugJsonl(dir, 'lifecycle.jsonl', {
    type: 'temp_dir_cleanup_skipped_debug',
    cwd: dir,
  });
  await appendDebugJsonl(dir, 'lifecycle.jsonl', {
    type: 'temp_dir_preserved',
    cwd: dir,
    artifact_dir: null,
  });
}

export async function recordEnvMutation(cwd: string, beforeSnapshot: Record<string, string> | null): Promise<void> {
  if (!beforeSnapshot || !isTestDebugEnabled()) return;
  const afterSnapshot = collectTrackedEnv();
  const diff = diffTrackedEnv(beforeSnapshot, afterSnapshot);
  await writeDebugJson(cwd, 'env-before.json', beforeSnapshot).catch(() => {});
  await writeDebugJson(cwd, 'env-after.json', afterSnapshot).catch(() => {});
  await writeDebugJson(cwd, 'env-diff.json', diff).catch(() => {});
}
