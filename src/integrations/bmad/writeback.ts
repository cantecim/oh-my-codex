import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { BmadWritebackResult } from './contracts.js';

const STORY_BLOCK_START = '<!-- OMX:BMAD:STORY-COMPLETION:START -->';
const STORY_BLOCK_END = '<!-- OMX:BMAD:STORY-COMPLETION:END -->';

function storySlug(storyPath: string): string {
  const stem = basename(storyPath, extname(storyPath));
  return stem.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'story';
}

function replaceDelimitedBlock(content: string, start: string, end: string, nextBlock: string): string {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const before = content.slice(0, startIndex).trimEnd();
    const after = content.slice(endIndex + end.length).trimStart();
    return `${before}${before ? '\n\n' : ''}${nextBlock}${after ? `\n\n${after}` : ''}\n`;
  }
  return `${content.trimEnd()}${content.trimEnd() ? '\n\n' : ''}${nextBlock}\n`;
}

function buildStoryCompletionBlock(params: {
  completedAt: string;
  mode: 'ralph' | 'team';
  verificationSummary: string;
  implementationArtifactPaths: string[];
  reviewOutcomeSummary?: string;
}): string {
  const lines = [
    STORY_BLOCK_START,
    '## OMX Completion Summary',
    `- Completed at: ${params.completedAt}`,
    `- Executed by: ${params.mode}`,
    `- Verification: ${params.verificationSummary}`,
  ];
  if (params.reviewOutcomeSummary) {
    lines.push(`- Review: ${params.reviewOutcomeSummary}`);
  }
  if (params.implementationArtifactPaths.length > 0) {
    lines.push(`- Implementation artifacts: ${params.implementationArtifactPaths.join(', ')}`);
  }
  lines.push(STORY_BLOCK_END);
  return lines.join('\n');
}

function buildImplementationArtifactContents(params: {
  storyPath: string | null;
  epicPath: string | null;
  verificationSummary: string;
  reviewOutcomeSummary?: string;
  changedFiles?: string[];
}): string {
  const lines = [
    '# OMX Implementation Summary',
    '',
    `- Story: ${params.storyPath ?? 'none'}`,
    `- Epic: ${params.epicPath ?? 'none'}`,
    `- Verification: ${params.verificationSummary}`,
  ];
  if (params.reviewOutcomeSummary) {
    lines.push(`- Review: ${params.reviewOutcomeSummary}`);
  }
  if ((params.changedFiles?.length ?? 0) > 0) {
    lines.push(`- Changed files: ${(params.changedFiles ?? []).join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function recordStoryProgress(
  projectRoot: string,
  storyPath: string | null,
  summary: string,
): Promise<BmadWritebackResult> {
  if (!storyPath) {
    return { status: 'skipped', target: 'story', path: null, reason: 'no_story_path' };
  }
  const fullPath = join(projectRoot, storyPath);
  if (!existsSync(fullPath)) {
    return { status: 'skipped', target: 'story', path: storyPath, reason: 'story_missing' };
  }
  const content = await readFile(fullPath, 'utf-8');
  const block = `${STORY_BLOCK_START}\n## OMX Progress Summary\n- Status: in_progress\n- Summary: ${summary}\n${STORY_BLOCK_END}`;
  await writeFile(fullPath, replaceDelimitedBlock(content, STORY_BLOCK_START, STORY_BLOCK_END, block), 'utf-8');
  return { status: 'applied', target: 'story', path: storyPath };
}

export async function recordStoryCompletion(
  projectRoot: string,
  params: {
    storyPath: string | null;
    completedAt: string;
    mode: 'ralph' | 'team';
    verificationSummary: string;
    implementationArtifactPaths?: string[];
    reviewOutcomeSummary?: string;
  },
): Promise<BmadWritebackResult> {
  if (!params.storyPath) {
    return { status: 'skipped', target: 'story', path: null, reason: 'no_story_path' };
  }
  const fullPath = join(projectRoot, params.storyPath);
  if (!existsSync(fullPath)) {
    return { status: 'skipped', target: 'story', path: params.storyPath, reason: 'story_missing' };
  }
  const content = await readFile(fullPath, 'utf-8');
  const block = buildStoryCompletionBlock({
    completedAt: params.completedAt,
    mode: params.mode,
    verificationSummary: params.verificationSummary,
    implementationArtifactPaths: params.implementationArtifactPaths ?? [],
    reviewOutcomeSummary: params.reviewOutcomeSummary,
  });
  await writeFile(fullPath, replaceDelimitedBlock(content, STORY_BLOCK_START, STORY_BLOCK_END, block), 'utf-8');
  return { status: 'applied', target: 'story', path: params.storyPath };
}

export async function recordSprintStatusUpdate(
  projectRoot: string,
  params: {
    sprintStatusPath: string | null;
    storyPath: string | null;
    status: string;
  },
): Promise<BmadWritebackResult> {
  if (!params.sprintStatusPath) {
    return { status: 'skipped', target: 'sprint-status', path: null, reason: 'no_sprint_status' };
  }
  if (!params.storyPath) {
    return { status: 'unsupported', target: 'sprint-status', path: params.sprintStatusPath, reason: 'no_story_for_mapping' };
  }
  if (!/\.ya?ml$/i.test(params.sprintStatusPath)) {
    return { status: 'unsupported', target: 'sprint-status', path: params.sprintStatusPath, reason: 'unsupported_sprint_format' };
  }
  const fullPath = join(projectRoot, params.sprintStatusPath);
  if (!existsSync(fullPath)) {
    return { status: 'skipped', target: 'sprint-status', path: params.sprintStatusPath, reason: 'sprint_status_missing' };
  }

  const content = await readFile(fullPath, 'utf-8');
  const slug = storySlug(params.storyPath);
  const lines = content.split(/\r?\n/);
  let matchedBlock = false;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(slug) && !lines[i].includes(params.storyPath) && !lines[i].includes(basename(params.storyPath))) {
      continue;
    }
    for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
      const statusMatch = lines[j].match(/^(\s*status\s*:\s*)([A-Za-z0-9_-]+)(\s*)$/);
      if (statusMatch) {
        lines[j] = `${statusMatch[1]}${params.status}${statusMatch[3]}`;
        matchedBlock = true;
        break;
      }
      if (/^\s*-\s+/.test(lines[j]) || /^[A-Za-z0-9_-]+\s*:/.test(lines[j])) break;
    }
    if (matchedBlock) break;
  }

  if (!matchedBlock) {
    return { status: 'unsupported', target: 'sprint-status', path: params.sprintStatusPath, reason: 'no_conservative_story_mapping' };
  }

  await writeFile(fullPath, `${lines.join('\n')}\n`, 'utf-8');
  return { status: 'applied', target: 'sprint-status', path: params.sprintStatusPath };
}

export async function recordImplementationArtifactSummary(
  projectRoot: string,
  params: {
    implementationArtifactsRoot: string | null;
    storyPath: string | null;
    epicPath: string | null;
    verificationSummary: string;
    reviewOutcomeSummary?: string;
    changedFiles?: string[];
    kind?: 'story-run' | 'verification';
  },
): Promise<BmadWritebackResult> {
  if (!params.implementationArtifactsRoot) {
    return { status: 'skipped', target: 'implementation-artifact', path: null, reason: 'no_implementation_artifacts_root' };
  }
  if (!params.storyPath) {
    return { status: 'skipped', target: 'implementation-artifact', path: null, reason: 'no_story_path' };
  }
  const storyRef = params.storyPath;
  const slug = storySlug(storyRef);
  const kind = params.kind ?? 'story-run';
  const fileName = kind === 'verification'
    ? `omx-verification-${slug}.md`
    : `omx-story-run-${slug}.md`;
  const relativePath = join(params.implementationArtifactsRoot, fileName).replace(/\\/g, '/');
  const fullPath = join(projectRoot, relativePath);
  await mkdir(join(projectRoot, params.implementationArtifactsRoot), { recursive: true });
  await writeFile(fullPath, buildImplementationArtifactContents({
    storyPath: params.storyPath,
    epicPath: params.epicPath,
    verificationSummary: params.verificationSummary,
    reviewOutcomeSummary: params.reviewOutcomeSummary,
    changedFiles: params.changedFiles,
  }), 'utf-8');
  return { status: 'applied', target: 'implementation-artifact', path: relativePath };
}
