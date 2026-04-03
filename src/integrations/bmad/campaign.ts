import { basename } from 'node:path';
import type {
  BmadArtifactIndex,
  BmadExecutionContext,
  BmadPersistedState,
} from './contracts.js';
import { isBmadStoryComplete } from './progress.js';

export type BmadExecutionBackend = 'ralph' | 'team';

export type BmadCampaignStopReason =
  | 'planning_required'
  | 'ambiguous_active_story'
  | 'hard_drift'
  | 'story_not_completed_after_execution'
  | 'writeback_blocked'
  | 'backend_failed'
  | 'backend_unsupported'
  | 'campaign_complete'
  | 'cancelled';

export interface BmadBacklogItem {
  storyPath: string;
  epicPath: string | null;
  complete: boolean;
  mappedFromSprint: boolean;
}

export interface BmadCampaignState {
  active: boolean;
  iteration: number;
  completedStoryPaths: string[];
  remainingStoryPaths: string[];
  activeStoryPath: string | null;
  activeEpicPath: string | null;
  backend: BmadExecutionBackend | null;
  stopReason: BmadCampaignStopReason | null;
}

export interface BmadNextStoryResult {
  status: 'resolved' | 'complete' | 'ambiguous' | 'blocked';
  storyPath: string | null;
  epicPath: string | null;
  backend: BmadExecutionBackend | null;
  completedStoryPaths: string[];
  remainingStoryPaths: string[];
  stopReason?: BmadCampaignStopReason;
}

export interface BmadBackendSelectionOptions {
  teamStoryPaths?: readonly string[];
}

function inferEpicForStory(
  storyPath: string,
  index: Pick<BmadArtifactIndex, 'epicPaths'>,
  state: Pick<BmadPersistedState, 'activeStoryRef' | 'activeEpicRef'>,
): string | null {
  if (state.activeStoryRef === storyPath && state.activeEpicRef) {
    return state.activeEpicRef;
  }
  if (index.epicPaths.length === 1) {
    return index.epicPaths[0];
  }

  const storyBase = basename(storyPath).toLowerCase();
  const storyTokens = new Set(storyBase.split(/[^a-z0-9]+/).filter(Boolean));
  const candidates = index.epicPaths.filter((epicPath) => {
    const epicTokens = basename(epicPath)
      .toLowerCase()
      .replace(/^epic[-_.]*/, '')
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    return epicTokens.length > 0 && epicTokens.every((token) => storyTokens.has(token));
  });
  return candidates.length === 1 ? candidates[0] : null;
}

export function selectBmadExecutionBackend(
  storyPath: string,
  options: BmadBackendSelectionOptions = {},
): BmadExecutionBackend {
  return options.teamStoryPaths?.includes(storyPath) ? 'team' : 'ralph';
}

export async function buildBmadBacklog(
  projectRoot: string,
  params: {
    index: BmadArtifactIndex;
    state: BmadPersistedState;
    context: BmadExecutionContext;
  },
): Promise<BmadBacklogItem[]> {
  const backlog: BmadBacklogItem[] = [];
  for (const storyPath of params.index.storyPaths) {
    const status = await isBmadStoryComplete(projectRoot, {
      storyPath,
      sprintStatusPath: params.context.sprintStatusPath,
    });
    backlog.push({
      storyPath,
      epicPath: inferEpicForStory(storyPath, params.index, params.state),
      complete: status.complete,
      mappedFromSprint: status.matchedSprintEntry,
    });
  }
  return backlog;
}

export async function resolveNextBmadStory(
  projectRoot: string,
  params: {
    index: BmadArtifactIndex;
    state: BmadPersistedState;
    context: BmadExecutionContext;
    backendSelection?: BmadBackendSelectionOptions;
  },
): Promise<BmadNextStoryResult> {
  if (!params.state.detected) {
    return {
      status: 'blocked',
      storyPath: null,
      epicPath: null,
      backend: null,
      completedStoryPaths: [],
      remainingStoryPaths: [],
      stopReason: 'planning_required',
    };
  }
  if (params.state.driftStatus === 'hard') {
    return {
      status: 'blocked',
      storyPath: null,
      epicPath: null,
      backend: null,
      completedStoryPaths: [],
      remainingStoryPaths: [],
      stopReason: 'hard_drift',
    };
  }

  const backlog = await buildBmadBacklog(projectRoot, params);
  const completedStoryPaths = backlog.filter((item) => item.complete).map((item) => item.storyPath);
  const remaining = backlog.filter((item) => !item.complete);
  const remainingStoryPaths = remaining.map((item) => item.storyPath);

  if (remaining.length === 0) {
    return {
      status: 'complete',
      storyPath: null,
      epicPath: null,
      backend: null,
      completedStoryPaths,
      remainingStoryPaths,
      stopReason: 'campaign_complete',
    };
  }

  const activeMatch = params.context.activeStoryPath
    ? remaining.find((item) => item.storyPath === params.context.activeStoryPath) ?? null
    : null;
  if (activeMatch) {
    return {
      status: 'resolved',
      storyPath: activeMatch.storyPath,
      epicPath: activeMatch.epicPath,
      backend: selectBmadExecutionBackend(activeMatch.storyPath, params.backendSelection),
      completedStoryPaths,
      remainingStoryPaths,
    };
  }

  const sprintMapped = remaining.filter((item) => item.mappedFromSprint);
  if (sprintMapped.length > 0) {
    const next = sprintMapped[0];
    return {
      status: 'resolved',
      storyPath: next.storyPath,
      epicPath: next.epicPath,
      backend: selectBmadExecutionBackend(next.storyPath, params.backendSelection),
      completedStoryPaths,
      remainingStoryPaths,
    };
  }

  if (remaining.length === 1) {
    const next = remaining[0];
    return {
      status: 'resolved',
      storyPath: next.storyPath,
      epicPath: next.epicPath,
      backend: selectBmadExecutionBackend(next.storyPath, params.backendSelection),
      completedStoryPaths,
      remainingStoryPaths,
    };
  }

  return {
    status: 'ambiguous',
    storyPath: null,
    epicPath: null,
    backend: null,
    completedStoryPaths,
    remainingStoryPaths,
    stopReason: 'ambiguous_active_story',
  };
}
