import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  BmadArtifactIndex,
  BmadExecutionContext,
  BmadPersistedState,
} from './contracts.js';
import { parseBmadAcceptanceCriteria } from './acceptance.js';

function resolveUniquePath(paths: readonly string[]): string | null {
  return paths.length === 1 ? paths[0] : null;
}

function resolveActiveStoryPath(index: BmadArtifactIndex, state: BmadPersistedState): { path: string | null; ambiguous: boolean } {
  if (state.activeStoryRef) {
    return { path: state.activeStoryRef, ambiguous: false };
  }
  if (index.storyPaths.length === 1) {
    return { path: index.storyPaths[0], ambiguous: false };
  }
  return { path: null, ambiguous: index.storyPaths.length > 1 };
}

export async function resolveBmadExecutionContext(
  projectRoot: string,
  index: BmadArtifactIndex,
  state: BmadPersistedState,
): Promise<BmadExecutionContext> {
  if (!state.detected) {
    const writebackBlockedByDrift = state.driftStatus === 'medium' || state.driftStatus === 'hard';
    return {
      detected: false,
      outputRoot: index.outputRoot,
      projectContextPath: null,
      architecturePaths: [],
      activeStoryPath: null,
      activeEpicPath: null,
      storyAcceptanceCriteria: [],
      sprintStatusPath: null,
      implementationArtifactsRoot: null,
      contextBlockedByAmbiguity: false,
      writebackSupported: false,
      writebackBlockedByDrift,
    };
  }

  const activeStory = resolveActiveStoryPath(index, state);
  const sprintStatusPath = resolveUniquePath(index.sprintStatusPaths);
  const implementationArtifactsRoot = index.outputRoot && existsSync(join(projectRoot, index.outputRoot, 'implementation-artifacts'))
    ? `${index.outputRoot}/implementation-artifacts`
    : null;
  const acceptance = await parseBmadAcceptanceCriteria(projectRoot, activeStory.path);
  const writebackBlockedByDrift = state.driftStatus === 'medium' || state.driftStatus === 'hard';

  return {
    detected: true,
    outputRoot: index.outputRoot,
    projectContextPath: index.projectContextPath,
    architecturePaths: [...index.architecturePaths],
    activeStoryPath: activeStory.path,
    activeEpicPath: state.activeEpicRef ?? resolveUniquePath(index.epicPaths),
    storyAcceptanceCriteria: acceptance.criteria,
    sprintStatusPath,
    implementationArtifactsRoot,
    contextBlockedByAmbiguity: activeStory.ambiguous,
    writebackSupported: !writebackBlockedByDrift,
    writebackBlockedByDrift,
  };
}

export function renderBmadTeamContextBlock(context: BmadExecutionContext): string {
  if (!context.detected) return '';

  const lines = [
    '<bmad_team_context>',
    'BMAD-aware team context is active for this run.',
    `- project-context: ${context.projectContextPath ?? 'none'}`,
    `- architecture: ${context.architecturePaths.length > 0 ? context.architecturePaths.join(', ') : 'none'}`,
    `- active story: ${context.activeStoryPath ?? 'ambiguous-or-none'}`,
    `- active epic: ${context.activeEpicPath ?? 'none'}`,
    `- sprint status: ${context.sprintStatusPath ?? 'none'}`,
    `- implementation artifacts root: ${context.implementationArtifactsRoot ?? 'none'}`,
    `- context ambiguity: ${context.contextBlockedByAmbiguity ? 'present' : 'none'}`,
    `- acceptance criteria: ${context.storyAcceptanceCriteria.length > 0 ? context.storyAcceptanceCriteria.join(' | ') : 'none extracted'}`,
    '</bmad_team_context>',
  ];
  return lines.join('\n');
}
