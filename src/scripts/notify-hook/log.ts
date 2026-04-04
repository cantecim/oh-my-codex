/**
 * Structured event logging for notify-hook modules.
 */

import { appendFile } from 'fs/promises';
import { join } from 'path';

export async function logTmuxHookEvent(logsDir: string, event: Record<string, unknown>): Promise<void> {
  const file = join(logsDir, `tmux-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
  await appendFile(file, JSON.stringify(event) + '\n').catch(() => {});
}

export async function logNotifyHookEvent(logsDir: string, event: Record<string, unknown>): Promise<void> {
  const file = join(logsDir, `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
  await appendFile(file, JSON.stringify(event) + '\n').catch(() => {});
}
