import type {
  BmadArtifactIndex,
  BmadGap,
  BmadPersistedState,
  BmadReadinessResult,
} from './contracts.js';

function summarizeGap(gap: BmadGap): string {
  switch (gap) {
    case 'missing_prd':
      return 'Missing BMAD PRD artifact.';
    case 'missing_architecture':
      return 'Missing BMAD architecture artifact.';
    case 'missing_story_or_sprint':
      return 'Missing BMAD story or sprint tracking artifact.';
    case 'ambiguous_active_story':
      return 'Active BMAD story is ambiguous.';
    case 'hard_drift':
      return 'BMAD integration is in hard drift and cannot safely hand off execution.';
  }
}

export function deriveBmadReadiness(
  index: BmadArtifactIndex,
  state: BmadPersistedState,
): BmadReadinessResult {
  if (!state.detected) {
    return {
      detected: false,
      phase: state.phase,
      readyForExecution: false,
      gaps: [],
      gapSummary: [],
      ambiguousActiveStory: false,
      writebackSupported: false,
      activeEpicPath: null,
      activeStoryPath: null,
    };
  }

  const gaps: BmadGap[] = [];
  if (index.prdPaths.length === 0) gaps.push('missing_prd');
  if (index.architecturePaths.length === 0) gaps.push('missing_architecture');
  if (index.storyPaths.length === 0 && index.sprintStatusPaths.length === 0) {
    gaps.push('missing_story_or_sprint');
  }
  const ambiguousActiveStory = state.activeStoryRef == null && index.storyPaths.length > 1;
  if (ambiguousActiveStory) gaps.push('ambiguous_active_story');
  if (state.driftStatus === 'hard') gaps.push('hard_drift');

  return {
    detected: true,
    phase: state.phase,
    readyForExecution: gaps.length === 0,
    gaps,
    gapSummary: gaps.map(summarizeGap),
    ambiguousActiveStory,
    writebackSupported: state.driftStatus === 'none' || state.driftStatus === 'soft',
    activeEpicPath: state.activeEpicRef ?? (index.epicPaths.length === 1 ? index.epicPaths[0] : null),
    activeStoryPath: state.activeStoryRef ?? (index.storyPaths.length === 1 ? index.storyPaths[0] : null),
  };
}
