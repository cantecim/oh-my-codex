import {
  appendDebugJsonl,
  buildTraceId,
  collectDebugEnvSubset,
  isTestDebugEnabled,
  previewText,
  resolveCommandPath,
  resolveDebugTestId,
} from './debug-artifacts.js';

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function buildRuntimeTraceId(prefix: string, ...parts: Array<unknown>): string {
  return buildTraceId(prefix, ...parts);
}

export async function traceDecision(
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

export function createProcessTraceSession(
  command: string,
  args: string[],
  timeoutMs: number,
  traceContext: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
) {
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

export function previewRuntimeText(value: unknown, maxLength = 500): string {
  return previewText(value, maxLength);
}
