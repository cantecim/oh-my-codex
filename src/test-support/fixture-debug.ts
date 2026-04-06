import { resolve } from 'node:path';
import { appendDebugJsonl, isTestDebugEnabled, resolveDebugTestId, writeDebugJson, writeDebugFixtureManifest } from '../debug/test-debug.js';

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

export function isFixtureDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTestDebugEnabled(env);
}

export function buildFixtureDebugChildEnv(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (!isFixtureDebugEnabled(env)) return {};
  const debugEnv: Record<string, string> = {
    OMX_TEST_DEBUG: '1',
  };
  const explicitTestId = typeof env.OMX_TEST_DEBUG_TEST_ID === 'string' ? env.OMX_TEST_DEBUG_TEST_ID.trim() : '';
  debugEnv.OMX_TEST_DEBUG_TEST_ID = explicitTestId || resolveDebugTestId(cwd, env);
  if (typeof env.OMX_TEST_ARTIFACTS_DIR === 'string' && env.OMX_TEST_ARTIFACTS_DIR.trim() !== '') {
    debugEnv.OMX_TEST_ARTIFACTS_DIR = env.OMX_TEST_ARTIFACTS_DIR;
  }
  return debugEnv;
}

export async function writeFixtureArtifactManifest(
  cwd: string,
  manifest: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  return await writeDebugJson(cwd, 'test-manifest.json', {
    cwd: resolve(cwd),
    ...manifest,
  }, env);
}

export async function recordTempDirFixtureCreated(
  dir: string,
  prefix: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string> | null> {
  if (!isFixtureDebugEnabled(env)) return null;
  const envBefore = collectTrackedEnv(env);
  await writeDebugFixtureManifest(dir, {
    type: 'temp_dir_fixture',
    prefix,
  }, env);
  await writeDebugJson(dir, 'env-before.json', envBefore, env);
  await appendDebugJsonl(dir, 'lifecycle.jsonl', {
    type: 'temp_dir_created',
    prefix,
    cwd: dir,
  }, env);
  return envBefore;
}

export async function recordTempDirFixtureFinished(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!isFixtureDebugEnabled(env)) return;
  const envAfter = collectTrackedEnv(env);
  const restoredEnv = collectTrackedEnv(env);
  const envDiff = diffTrackedEnv(envAfter, restoredEnv);
  await writeDebugJson(dir, 'env-after.json', restoredEnv, env);
  await writeDebugJson(dir, 'env-diff.json', envDiff, env);
  await appendDebugJsonl(dir, 'lifecycle.jsonl', {
    type: 'temp_dir_cleanup_skipped_debug',
    cwd: dir,
  }, env);
  await appendDebugJsonl(dir, 'lifecycle.jsonl', {
    type: 'temp_dir_preserved',
    cwd: dir,
    artifact_dir: null,
  }, env);
}

export async function recordEnvMutation(
  cwd: string,
  beforeSnapshot: Record<string, string> | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!beforeSnapshot || !isFixtureDebugEnabled(env)) return;
  const afterSnapshot = collectTrackedEnv(env);
  const diff = diffTrackedEnv(beforeSnapshot, afterSnapshot);
  await writeDebugJson(cwd, 'env-before.json', beforeSnapshot, env).catch(() => {});
  await writeDebugJson(cwd, 'env-after.json', afterSnapshot, env).catch(() => {});
  await writeDebugJson(cwd, 'env-diff.json', diff, env).catch(() => {});
}
