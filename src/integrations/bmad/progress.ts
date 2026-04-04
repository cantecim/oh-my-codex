import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { BmadArtifactIndex } from './contracts.js';

const STORY_COMPLETION_MARKER = '<!-- OMX:BMAD:STORY-COMPLETION:START -->';
const COMPLETED_STATUSES = new Set(['complete', 'completed', 'done']);

function storySlug(storyPath: string): string {
  const stem = basename(storyPath, extname(storyPath));
  return stem.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'story';
}

async function readSprintStoryStatus(
  projectRoot: string,
  sprintStatusPath: string | null,
  storyPath: string,
): Promise<{ matched: boolean; status: string | null }> {
  if (!sprintStatusPath) {
    return { matched: false, status: null };
  }
  const fullPath = join(projectRoot, sprintStatusPath);
  if (!existsSync(fullPath)) {
    return { matched: false, status: null };
  }

  const slug = storySlug(storyPath);
  const content = await readFile(fullPath, 'utf-8');
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes(slug) && !lines[i].includes(storyPath) && !lines[i].includes(basename(storyPath))) {
      continue;
    }
    for (let j = i + 1; j < Math.min(lines.length, i + 8); j += 1) {
      const statusMatch = lines[j].match(/^(\s*status\s*:\s*)([A-Za-z0-9_-]+)(\s*)$/);
      if (statusMatch) {
        return { matched: true, status: statusMatch[2].toLowerCase() };
      }
      if (/^\s*-\s+/.test(lines[j]) || /^[A-Za-z0-9_-]+\s*:/.test(lines[j])) break;
    }
  }
  return { matched: false, status: null };
}

export async function hasOmxStoryCompletion(
  projectRoot: string,
  storyPath: string | null,
): Promise<boolean> {
  if (!storyPath) return false;
  const fullPath = join(projectRoot, storyPath);
  if (!existsSync(fullPath)) return false;
  const content = await readFile(fullPath, 'utf-8');
  return content.includes(STORY_COMPLETION_MARKER);
}

export async function isBmadStoryComplete(
  projectRoot: string,
  params: { storyPath: string; sprintStatusPath: string | null },
): Promise<{ complete: boolean; matchedSprintEntry: boolean; source: 'story-block' | 'sprint-status' | 'none' }> {
  if (await hasOmxStoryCompletion(projectRoot, params.storyPath)) {
    return { complete: true, matchedSprintEntry: false, source: 'story-block' };
  }

  const sprint = await readSprintStoryStatus(projectRoot, params.sprintStatusPath, params.storyPath);
  if (sprint.matched && sprint.status && COMPLETED_STATUSES.has(sprint.status)) {
    return { complete: true, matchedSprintEntry: true, source: 'sprint-status' };
  }

  return { complete: false, matchedSprintEntry: sprint.matched, source: 'none' };
}

export async function collectCompletedStoryPaths(
  projectRoot: string,
  params: { storyPaths: readonly string[]; sprintStatusPath: string | null },
): Promise<string[]> {
  const completed: string[] = [];
  for (const storyPath of params.storyPaths) {
    const status = await isBmadStoryComplete(projectRoot, {
      storyPath,
      sprintStatusPath: params.sprintStatusPath,
    });
    if (status.complete) completed.push(storyPath);
  }
  return completed;
}

export async function inferEpicCompletion(
  projectRoot: string,
  params: {
    epicPath: string | null;
    epicStoryPaths: readonly string[];
    sprintStatusPath: string | null;
  },
): Promise<'complete' | 'incomplete' | 'unknown'> {
  if (!params.epicPath || params.epicStoryPaths.length === 0) {
    return 'unknown';
  }

  let hasIncomplete = false;
  for (const storyPath of params.epicStoryPaths) {
    const status = await isBmadStoryComplete(projectRoot, {
      storyPath,
      sprintStatusPath: params.sprintStatusPath,
    });
    if (!status.complete) {
      hasIncomplete = true;
      break;
    }
  }

  return hasIncomplete ? 'incomplete' : 'complete';
}

export function inferEpicStoryPaths(
  index: Pick<BmadArtifactIndex, 'storyPaths'>,
  epicPath: string | null,
): string[] {
  if (!epicPath) return [];
  const epicTokens = basename(epicPath)
    .toLowerCase()
    .replace(/^epic[-_.]*/u, '')
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  if (epicTokens.length === 0) return [];
  return index.storyPaths.filter((storyPath) => {
    const storyTokens = basename(storyPath)
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter(Boolean);
    return epicTokens.every((token) => storyTokens.includes(token));
  });
}
