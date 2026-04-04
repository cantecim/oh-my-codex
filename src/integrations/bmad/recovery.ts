import type {
  BmadArtifactIndex,
  BmadDriftRecoveryResult,
  BmadPersistedState,
} from './contracts.js';
import type { BmadExecutionContext } from './contracts.js';
import { resolveNextBmadStory } from './campaign.js';

export async function attemptBmadDriftRecovery(
  projectRoot: string,
  params: {
    index: BmadArtifactIndex;
    state: BmadPersistedState;
    context: BmadExecutionContext;
    storyPath: string | null;
  },
): Promise<BmadDriftRecoveryResult> {
  const attempted = params.state.driftStatus === 'medium' || params.state.driftStatus === 'hard';
  if (!attempted) {
    return {
      attempted: false,
      allowedRetry: false,
      recovered: true,
      driftStatus: params.state.driftStatus,
      activeStoryPath: params.context.activeStoryPath,
      sprintStatusPath: params.context.sprintStatusPath,
      reason: 'no_recovery_needed',
    };
  }

  if (params.state.driftStatus === 'hard') {
    return {
      attempted: true,
      allowedRetry: false,
      recovered: false,
      driftStatus: params.state.driftStatus,
      activeStoryPath: params.context.activeStoryPath,
      sprintStatusPath: params.context.sprintStatusPath,
      reason: 'hard_drift_requires_manual_reconciliation',
    };
  }

  const resolved = await resolveNextBmadStory(projectRoot, {
    index: params.index,
    state: params.state,
    context: params.context,
  });

  const recovered =
    resolved.status === 'resolved'
    && params.storyPath !== null
    && resolved.storyPath === params.storyPath;

  return {
    attempted: true,
    allowedRetry: recovered,
    recovered,
    driftStatus: params.state.driftStatus,
    activeStoryPath: resolved.storyPath,
    sprintStatusPath: params.context.sprintStatusPath,
    reason: recovered
      ? 'same_story_rebound_after_medium_drift'
      : 'medium_drift_could_not_rebind_same_story',
  };
}
