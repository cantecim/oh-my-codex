import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function sanitizeSegment(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return normalized || 'unknown';
}

function shortHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 10);
}

export function buildTraceId(prefix: string, ...parts: Array<unknown>): string {
  const normalizedPrefix = sanitizeSegment(prefix);
  const normalizedParts = parts
    .map((part) => sanitizeSegment(safeString(part)))
    .filter((part) => part !== 'unknown');
  return [normalizedPrefix, ...normalizedParts].join(':');
}

export function isTestDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = safeString(env.OMX_TEST_DEBUG).trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

export function resolveDebugArtifactsRoot(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  const configured = safeString(env.OMX_TEST_ARTIFACTS_DIR).trim();
  if (configured) return resolve(configured);
  return join(resolve(cwd), '.omx', 'test-artifacts');
}

export function resolveDebugTestId(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  const explicit = safeString(env.OMX_TEST_DEBUG_TEST_ID).trim();
  if (explicit) return sanitizeSegment(explicit);
  const base = sanitizeSegment(basename(resolve(cwd)));
  return `${base}-${shortHash(resolve(cwd))}`;
}

export function resolveDebugArtifactDir(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDebugArtifactsRoot(cwd, env), resolveDebugTestId(cwd, env));
}

export async function ensureDebugArtifactDir(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (!isTestDebugEnabled(env)) return null;
  const dir = resolveDebugArtifactDir(cwd, env);
  await mkdir(dir, { recursive: true });
  return dir;
}

export function previewText(value: unknown, maxLength = 500): string {
  const text = safeString(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

export async function writeDebugJson(
  cwd: string,
  name: string,
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const artifactDir = await ensureDebugArtifactDir(cwd, env);
  if (!artifactDir) return null;
  const path = join(artifactDir, name);
  await writeFile(path, JSON.stringify(value, null, 2));
  return path;
}

export async function appendDebugJsonl(
  cwd: string,
  name: string,
  value: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const artifactDir = await ensureDebugArtifactDir(cwd, env);
  if (!artifactDir) return null;
  const path = join(artifactDir, name);
  await appendFile(path, `${JSON.stringify({ timestamp: new Date().toISOString(), ...value })}\n`);
  return path;
}

export function collectDebugEnvSubset(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const subset: Record<string, string> = {};
  const keys = [
    'PATH',
    'HOME',
    'CODEX_HOME',
    'TMUX',
    'TMUX_PANE',
    'OMX_TEAM_WORKER',
    'OMX_TEAM_STATE_ROOT',
    'OMX_TEAM_LEADER_CWD',
    'OMX_TEST_DEBUG',
    'OMX_TEST_ARTIFACTS_DIR',
    'OMX_TEST_DEBUG_TEST_ID',
    'OMX_TEST_TRACE_ID',
    'OMX_TEST_TMUX_INVOCATION_ID',
    'OMX_TEST_TMUX_COMMAND_ROLE',
    'OMX_TEST_CAPTURE_FILE',
    'OMX_TEST_CAPTURE_SEQUENCE_FILE',
    'OMX_TEST_CAPTURE_COUNTER_FILE',
  ];
  for (const key of keys) {
    const value = env[key];
    if (typeof value === 'string') subset[key] = value;
  }
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('OMX_TEST_')) continue;
    if (typeof value === 'string') subset[key] = value;
  }
  return subset;
}

export function resolveCommandPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const trimmed = safeString(command).trim();
  if (!trimmed) return null;
  if (isAbsolute(trimmed)) return existsSync(trimmed) ? trimmed : null;
  if (trimmed.includes('/')) {
    const resolved = resolve(trimmed);
    return existsSync(resolved) ? resolved : null;
  }
  const pathValue = safeString(env.PATH);
  if (!pathValue) return null;
  const candidates: string[] = [];
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    candidates.push(join(dir, trimmed));
    if (process.platform === 'win32') {
      for (const ext of ['.exe', '.cmd', '.bat']) {
        candidates.push(join(dir, `${trimmed}${ext}`));
      }
    }
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
