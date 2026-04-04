import type { BmadRetrospectiveHookResult, BmadWritebackStatus } from './contracts.js';
import { recordImplementationArtifactSummary } from './writeback.js';

function slugFromPath(path: string | null): string {
  return (path ?? 'unknown')
    .split('/')
    .pop()
    ?.replace(/\.[^.]+$/u, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'unknown';
}

export async function recordBmadStoryHook(
  projectRoot: string,
  params: {
    implementationArtifactsRoot: string | null;
    storyPath: string | null;
    epicPath: string | null;
    backend: 'ralph' | 'team' | 'bmad-native';
    verificationSummary: string;
    reviewOutcomeSummary?: string;
    changedFiles?: string[];
  },
): Promise<BmadRetrospectiveHookResult> {
  const result = await recordImplementationArtifactSummary(projectRoot, {
    implementationArtifactsRoot: params.implementationArtifactsRoot,
    storyPath: params.storyPath,
    epicPath: params.epicPath,
    verificationSummary: params.verificationSummary,
    reviewOutcomeSummary: params.reviewOutcomeSummary,
    changedFiles: params.changedFiles,
    kind: 'story-hook',
    backend: params.backend,
  });
  return {
    status: result.status as BmadWritebackStatus,
    target: 'story-hook',
    path: result.path,
    reason: result.reason,
  };
}

export async function recordBmadEpicRetrospectiveHook(
  projectRoot: string,
  params: {
    implementationArtifactsRoot: string | null;
    epicPath: string | null;
    completedStoryPaths: readonly string[];
    backend: 'ralph' | 'team' | 'bmad-native';
    summary: string;
  },
): Promise<BmadRetrospectiveHookResult> {
  if (!params.implementationArtifactsRoot) {
    return {
      status: 'skipped',
      target: 'epic-hook',
      path: null,
      reason: 'no_implementation_artifacts_root',
    };
  }

  const result = await recordImplementationArtifactSummary(projectRoot, {
    implementationArtifactsRoot: params.implementationArtifactsRoot,
    storyPath: params.completedStoryPaths.at(-1) ?? null,
    epicPath: params.epicPath,
    verificationSummary: params.summary,
    reviewOutcomeSummary: `Completed stories: ${params.completedStoryPaths.join(', ') || 'none'}`,
    kind: 'retrospective',
    backend: params.backend,
    fileNameOverride: `omx-retrospective-${slugFromPath(params.epicPath)}.md`,
  });

  return {
    status: result.status as BmadWritebackStatus,
    target: 'epic-hook',
    path: result.path,
    reason: result.reason,
  };
}
