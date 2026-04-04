import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_BMAD_OUTPUT_ROOT = '_bmad-output';
const BMAD_CORE_CONFIG_PATH = '_bmad/core/config.yaml';

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function readBmadOutputRoot(projectRoot: string): string | null {
  const configPath = join(projectRoot, BMAD_CORE_CONFIG_PATH);
  if (!existsSync(configPath)) return null;
  try {
    const content = readFileSync(configPath, 'utf-8');
    const match = content.match(/^\s*output_folder\s*:\s*(.+?)\s*$/m);
    if (!match?.[1]) return null;
    const value = stripQuotes(match[1]);
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function resolveBmadOutputRoot(projectRoot: string): string {
  return readBmadOutputRoot(projectRoot) ?? DEFAULT_BMAD_OUTPUT_ROOT;
}
