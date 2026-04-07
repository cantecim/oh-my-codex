import { existsSync, readFileSync } from 'node:fs';
import { join, normalize, relative, resolve, sep } from 'node:path';

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

function normalizeRelativeOutputRoot(projectRoot: string, value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;

  if (trimmed === '{project-root}') {
    return '.';
  }

  const placeholderPrefix = '{project-root}/';
  if (trimmed.startsWith(placeholderPrefix)) {
    return trimmed.slice(placeholderPrefix.length).replace(/\\/g, '/');
  }

  const placeholderPrefixWindows = '{project-root}\\';
  if (trimmed.startsWith(placeholderPrefixWindows)) {
    return trimmed.slice(placeholderPrefixWindows.length).replace(/\\/g, '/');
  }

  const normalized = normalize(trimmed);
  const resolvedCandidate = resolve(projectRoot, normalized);
  const relativeCandidate = relative(projectRoot, resolvedCandidate);

  if (relativeCandidate === '') {
    return '.';
  }

  if (
    relativeCandidate !== '..'
    && !relativeCandidate.startsWith(`..${sep}`)
    && relativeCandidate !== normalized
  ) {
    return relativeCandidate.split(sep).join('/');
  }

  return normalized.replace(/\\/g, '/');
}

export function readBmadOutputRoot(projectRoot: string): string | null {
  const configPath = join(projectRoot, BMAD_CORE_CONFIG_PATH);
  if (!existsSync(configPath)) return null;
  try {
    const content = readFileSync(configPath, 'utf-8');
    const match = content.match(/^\s*output_folder\s*:\s*(.+?)\s*$/m);
    if (!match?.[1]) return null;
    const value = stripQuotes(match[1]);
    return normalizeRelativeOutputRoot(projectRoot, value);
  } catch {
    return null;
  }
}

export function resolveBmadOutputRoot(projectRoot: string): string {
  return readBmadOutputRoot(projectRoot) ?? DEFAULT_BMAD_OUTPUT_ROOT;
}
