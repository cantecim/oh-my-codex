import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import type { BmadArtifactIndex, BmadDetectionResult, BmadPathMetadata, BmadTrack } from './contracts.js';

const BMAD_STRONG_SIGNALS = [
  '_bmad',
  '_bmad-output',
  '_bmad-output/project-context.md',
  '_bmad-output/planning-artifacts',
  '_bmad-output/implementation-artifacts',
] as const;

const PRD_PATTERN = /(?:^|[-_.])prd(?:[-_.]|$)|^prd\.md$/i;
const UX_PATTERN = /(?:^|[-_.])ux(?:[-_.](?:design|spec))?(?:[-_.]|$)|ux-design|ux-spec/i;
const ARCHITECTURE_PATTERN = /(?:^|[-_.])architecture(?:[-_.]|$)|^architecture\.md$/i;
const EPIC_PATTERN = /^epic(?:[-_.]|\d|$)/i;
const STORY_PATTERN = /(?:^|[-_.])story(?:[-_.]|\d|$)/i;
const SPRINT_STATUS_PATTERN = /^sprint-status\.(?:ya?ml|json)$/i;
const SPRINT_PLANNING_PATTERN = /^sprint-planning(?:[-_.].+)?\.(?:md|ya?ml|json)$/i;

function normalizedRelativePath(projectRoot: string, fullPath: string): string {
  return relative(projectRoot, fullPath).split(sep).join('/');
}

async function walkFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const queue = [root];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

function detectSignals(projectRoot: string): string[] {
  return BMAD_STRONG_SIGNALS.filter((signal) => existsSync(join(projectRoot, signal)));
}

function classifyTrack(index: Pick<BmadArtifactIndex, 'architecturePaths' | 'prdPaths' | 'uxPaths' | 'epicPaths'>): BmadTrack {
  const hasPlanning = index.prdPaths.length > 0 || index.uxPaths.length > 0;
  const hasArchitecture = index.architecturePaths.length > 0;
  const hasEpics = index.epicPaths.length > 0;
  const hasEnterpriseHints = index.architecturePaths.some((path) => /security|devops|compliance/i.test(path));

  if (hasEnterpriseHints) return 'enterprise-like';
  if (hasArchitecture || hasPlanning || hasEpics) return 'method-like';
  return 'unknown';
}

async function collectPathMetadata(paths: readonly string[], projectRoot: string): Promise<Record<string, BmadPathMetadata>> {
  const metadata: Record<string, BmadPathMetadata> = {};
  for (const fullPath of paths) {
    try {
      const info = await stat(fullPath);
      const relPath = normalizedRelativePath(projectRoot, fullPath);
      metadata[relPath] = {
        path: relPath,
        mtimeMs: info.mtimeMs,
        size: info.size,
      };
    } catch {
      // Ignore files that disappear during discovery.
    }
  }
  return metadata;
}

function buildIndexVersion(pathMetadata: Record<string, BmadPathMetadata>, detectionSignals: readonly string[]): string {
  const hash = createHash('sha1');
  hash.update(JSON.stringify({
    detectionSignals: [...detectionSignals].sort(),
    pathMetadata: Object.values(pathMetadata).sort((a, b) => a.path.localeCompare(b.path)),
  }));
  return hash.digest('hex');
}

export function detectBmadProject(projectRoot: string): BmadDetectionResult {
  const detectionSignals = detectSignals(projectRoot);
  return {
    detected: detectionSignals.length > 0,
    detectionSignals,
  };
}

export async function buildBmadArtifactIndex(projectRoot: string): Promise<BmadArtifactIndex> {
  const detection = detectBmadProject(projectRoot);
  const planningRoot = join(projectRoot, '_bmad-output', 'planning-artifacts');
  const implementationRoot = join(projectRoot, '_bmad-output', 'implementation-artifacts');
  const projectContextPath = join(projectRoot, '_bmad-output', 'project-context.md');

  const planningFiles = await walkFiles(planningRoot);
  const implementationFiles = await walkFiles(implementationRoot);
  const allKnownFiles = [...planningFiles, ...implementationFiles, ...(existsSync(projectContextPath) ? [projectContextPath] : [])];

  const prdPaths: string[] = [];
  const uxPaths: string[] = [];
  const architecturePaths: string[] = [];
  const epicPaths: string[] = [];
  const storyPaths: string[] = [];
  const sprintStatusPaths: string[] = [];

  for (const fullPath of planningFiles) {
    const relPath = normalizedRelativePath(projectRoot, fullPath);
    const fileName = basename(fullPath);

    if (PRD_PATTERN.test(fileName)) prdPaths.push(relPath);
    if (UX_PATTERN.test(fileName)) uxPaths.push(relPath);
    if (ARCHITECTURE_PATTERN.test(fileName)) architecturePaths.push(relPath);
    if (EPIC_PATTERN.test(fileName)) epicPaths.push(relPath);
    if (STORY_PATTERN.test(fileName)) storyPaths.push(relPath);
  }

  for (const fullPath of implementationFiles) {
    const relPath = normalizedRelativePath(projectRoot, fullPath);
    const fileName = basename(fullPath);
    if (SPRINT_STATUS_PATTERN.test(fileName) || SPRINT_PLANNING_PATTERN.test(fileName)) sprintStatusPaths.push(relPath);
  }

  const implementationArtifactPaths = implementationFiles.map((path) => normalizedRelativePath(projectRoot, path));
  const pathMetadata = await collectPathMetadata(allKnownFiles, projectRoot);
  const artifactIndexVersion = buildIndexVersion(pathMetadata, detection.detectionSignals);

  return {
    scannedAt: new Date().toISOString(),
    projectRoot,
    detected: detection.detected,
    detectionSignals: detection.detectionSignals,
    artifactIndexVersion,
    projectContextPath: existsSync(projectContextPath)
      ? normalizedRelativePath(projectRoot, projectContextPath)
      : null,
    prdPaths: [...new Set(prdPaths)].sort((a, b) => a.localeCompare(b)),
    uxPaths: [...new Set(uxPaths)].sort((a, b) => a.localeCompare(b)),
    architecturePaths: [...new Set(architecturePaths)].sort((a, b) => a.localeCompare(b)),
    epicPaths: [...new Set(epicPaths)].sort((a, b) => a.localeCompare(b)),
    storyPaths: [...new Set(storyPaths)].sort((a, b) => a.localeCompare(b)),
    sprintStatusPaths: [...new Set(sprintStatusPaths)].sort((a, b) => a.localeCompare(b)),
    implementationArtifactPaths: [...new Set(implementationArtifactPaths)].sort((a, b) => a.localeCompare(b)),
    pathMetadata,
  };
}

export function inferBmadTrack(index: Pick<BmadArtifactIndex, 'architecturePaths' | 'prdPaths' | 'uxPaths' | 'epicPaths'>): BmadTrack {
  return classifyTrack(index);
}
