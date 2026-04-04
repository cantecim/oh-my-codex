/**
 * Subprocess helper for notify-hook modules.
 */

import { spawn } from 'child_process';
import { createProcessTraceSession, previewRuntimeText } from '../../debug/runtime-trace.js';

export function runProcess(command: string, args: string[], timeoutMs = 3000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return runProcessWithTrace(command, args, timeoutMs);
}

export function runProcessWithTrace(
  command: string,
  args: string[],
  timeoutMs = 3000,
  traceContext: Record<string, unknown> = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const cwd = process.cwd();
    const traceSession = createProcessTraceSession(command, args, timeoutMs, traceContext, process.env);
    const childEnv = traceSession.childEnv;
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
    let stdout = '';
    let stderr = '';
    let finished = false;

    const trace = async (payload: Record<string, unknown>) => {
      await traceSession.append(cwd, startedAt, payload);
    };

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill('SIGTERM');
      void trace({
        status: 'timeout',
        stdout_preview: previewRuntimeText(stdout),
        stderr_preview: previewRuntimeText(stderr),
        error: `timeout after ${timeoutMs}ms`,
      });
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: any) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: any) => {
      stderr += chunk.toString();
    });
    child.on('error', (err: any) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      void trace({
        status: 'error',
        stdout_preview: previewRuntimeText(stdout),
        stderr_preview: previewRuntimeText(stderr),
        error: err instanceof Error ? err.message : String(err),
      });
      reject(err);
    });
    child.on('close', (code: any) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      void trace({
        status: code === 0 ? 'ok' : 'nonzero',
        code,
        stdout_preview: previewRuntimeText(stdout),
        stderr_preview: previewRuntimeText(stderr),
      });
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        reject(new Error(stderr.trim() || `${command} exited ${code}`));
      }
    });
  });
}
