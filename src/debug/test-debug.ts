import { resolve } from 'node:path';
import {
  appendDebugJsonl,
  buildTraceId,
  collectDebugEnvSubset,
  ensureDebugArtifactDir,
  isTestDebugEnabled,
  previewText,
  resolveCommandPath,
  resolveDebugArtifactDir,
  resolveDebugArtifactsRoot,
  resolveDebugTestId,
  writeDebugJson,
} from './debug-artifacts.js';

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export {
  appendDebugJsonl,
  buildTraceId,
  collectDebugEnvSubset,
  ensureDebugArtifactDir,
  isTestDebugEnabled,
  previewText,
  resolveCommandPath,
  resolveDebugArtifactDir,
  resolveDebugArtifactsRoot,
  resolveDebugTestId,
  writeDebugJson,
};

export interface RuntimeProcessTraceSession {
  debugEnabled: boolean;
  commandRole: string;
  invocationId: string;
  childEnv: NodeJS.ProcessEnv;
  append: (cwd: string, startedAt: number, payload: Record<string, unknown>) => Promise<void>;
}

export async function writeDebugFixtureManifest(
  cwd: string,
  {
    type,
    prefix,
    createdAt,
  }: {
    type: string;
    prefix: string;
    createdAt?: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const debugArtifactDir = await ensureDebugArtifactDir(cwd, env);
  if (!debugArtifactDir) return;
  await writeDebugJson(cwd, 'manifest.json', {
    type,
    prefix,
    cwd: resolve(cwd),
    debug_artifact_dir: debugArtifactDir,
    test_id: resolveDebugTestId(cwd, env),
    created_at: createdAt || new Date().toISOString(),
  }, env);
  await writeDebugJson(cwd, 'env.json', collectDebugEnvSubset(env), env);
  await writeDebugJson(cwd, 'paths.json', {
    cwd: resolve(cwd),
    debug_artifact_dir: debugArtifactDir,
  }, env);
}

export async function appendRuntimeDecisionTrace(
  cwd: string,
  moduleName: string,
  event: string,
  payload: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (!isTestDebugEnabled(env)) return null;
  const traceId = safeString(payload.trace_id).trim()
    || buildTraceId(moduleName, resolveDebugTestId(cwd, env), event);
  return await appendDebugJsonl(cwd, 'decision-trace.jsonl', {
    module: moduleName,
    event,
    cwd,
    test_id: resolveDebugTestId(cwd, env),
    trace_id: traceId,
    ...payload,
  }, env);
}

export function createRuntimeProcessTraceSession(
  command: string,
  args: string[],
  timeoutMs: number,
  traceContext: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
): RuntimeProcessTraceSession {
  const debugEnabled = isTestDebugEnabled(env);
  const commandRole = debugEnabled && typeof traceContext.command_role === 'string' ? traceContext.command_role : '';
  const invocationId = debugEnabled
    ? (typeof traceContext.invocation_id === 'string' && traceContext.invocation_id.trim() !== ''
      ? traceContext.invocation_id
      : buildTraceId('tmux-invocation', String(process.pid), String(Date.now()), command, args.join('-')))
    : '';
  const childEnv = debugEnabled
    ? {
      ...env,
      ...(invocationId ? { OMX_TEST_TMUX_INVOCATION_ID: invocationId } : {}),
      ...(commandRole ? { OMX_TEST_TMUX_COMMAND_ROLE: commandRole } : {}),
    }
    : env;

  return {
    debugEnabled,
    commandRole,
    invocationId,
    childEnv,
    async append(cwd: string, startedAt: number, payload: Record<string, unknown>): Promise<void> {
      if (!debugEnabled) return;
      await appendDebugJsonl(cwd, 'process-runner.jsonl', {
        cwd,
        command,
        resolved_command: resolveCommandPath(command, env) || command,
        argv: args,
        ...(invocationId ? { invocation_id: invocationId } : {}),
        ...(commandRole ? { command_role: commandRole } : {}),
        timeout_ms: timeoutMs,
        env: collectDebugEnvSubset(env),
        duration_ms: Date.now() - startedAt,
        ...traceContext,
        ...payload,
      }, env).catch(() => {});
    },
  };
}
