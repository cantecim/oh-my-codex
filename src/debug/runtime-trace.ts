import {
  appendRuntimeDecisionTrace,
  buildTraceId,
  createRuntimeProcessTraceSession,
  previewText,
} from './test-debug.js';

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
  return await appendRuntimeDecisionTrace(cwd, moduleName, event, payload, env);
}

export function createProcessTraceSession(
  command: string,
  args: string[],
  timeoutMs: number,
  traceContext: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
) {
  return createRuntimeProcessTraceSession(command, args, timeoutMs, traceContext, env);
}

export function previewRuntimeText(value: unknown, maxLength = 500): string {
  return previewText(value, maxLength);
}
