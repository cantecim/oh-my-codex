import { readModeState, startMode, updateModeState } from '../modes/base.js';
import { detectBmadProject } from '../integrations/bmad/discovery.js';
import { deriveBmadReadiness } from '../integrations/bmad/readiness.js';
import { resolveBmadExecutionContext } from '../integrations/bmad/context.js';
import { buildBmadWorkflowHandoff } from '../integrations/bmad/handoff.js';
import { recordBmadEpicRetrospectiveHook } from '../integrations/bmad/hooks.js';
import { runBmadNativeExecution } from '../integrations/bmad/native-execution.js';
import { attemptBmadDriftRecovery } from '../integrations/bmad/recovery.js';
import {
  persistBmadActiveSelection,
  ensureBmadIntegrationState,
} from '../integrations/bmad/reconcile.js';
import {
  resolveNextBmadStory,
  type BmadBackendSelectionOptions,
  type BmadCampaignStopReason,
} from '../integrations/bmad/campaign.js';
import { buildAutopilotBmadStateFields } from '../integrations/bmad/autopilot-state.js';
import {
  inferEpicCompletion,
  inferEpicStoryPaths,
  isBmadStoryComplete,
} from '../integrations/bmad/progress.js';
import { ralphCommand } from '../cli/ralph.js';
import type {
  BmadExecutionBackend,
  BmadNativeExecutionRequest,
  BmadNativeExecutionResult,
} from '../integrations/bmad/contracts.js';
import type { PipelineConfig, PipelineResult, PipelineStage } from './types.js';
import { createAutopilotPipelineConfig, runPipeline } from './orchestrator.js';

export type BmadPlanningRecommendation =
  | 'create-prd'
  | 'create-architecture'
  | 'create-epics-and-stories'
  | 'manual-bmad-resolution';

export interface BmadAutopilotExecutorResult {
  status: 'completed' | 'failed' | 'cancelled' | 'unsupported';
  error?: string;
  artifacts?: Record<string, unknown>;
}

export interface BmadAutopilotExecutors {
  ralph?: (options: {
    cwd: string;
    task: string;
    storyPath: string;
    epicPath: string | null;
    iteration: number;
  }) => Promise<BmadAutopilotExecutorResult>;
  team?: (options: {
    cwd: string;
    task: string;
    storyPath: string;
    epicPath: string | null;
    iteration: number;
  }) => Promise<BmadAutopilotExecutorResult>;
  native?: (request: BmadNativeExecutionRequest) => Promise<BmadNativeExecutionResult>;
}

export interface RunBmadAutopilotCampaignOptions {
  task: string;
  cwd?: string;
  sessionId?: string;
  backendSelection?: BmadBackendSelectionOptions;
  executors?: BmadAutopilotExecutors;
  maxIterations?: number;
}

export interface BmadAutopilotCampaignResult extends PipelineResult {
  kind: 'bmad-campaign';
  stopReason: BmadCampaignStopReason | null;
  completedStoryPaths: string[];
  remainingStoryPaths: string[];
  recommendation?: BmadPlanningRecommendation;
}

export interface RunAutopilotWithRoutingOptions extends RunBmadAutopilotCampaignOptions {
  stages: PipelineStage[];
  maxRalphIterations?: number;
  workerCount?: number;
  agentType?: string;
  onStageTransition?: PipelineConfig['onStageTransition'];
}

function mapReadinessToRecommendation(gaps: readonly string[]): BmadPlanningRecommendation {
  if (gaps.includes('missing_prd')) return 'create-prd';
  if (gaps.includes('missing_architecture')) return 'create-architecture';
  if (gaps.includes('missing_story_or_sprint')) return 'create-epics-and-stories';
  return 'manual-bmad-resolution';
}

async function runDefaultRalphExecutor(options: {
  cwd: string;
  task: string;
}): Promise<BmadAutopilotExecutorResult> {
  const previousCwd = process.cwd();
  try {
    process.chdir(options.cwd);
    await ralphCommand([options.task]);
    const state = await readModeState('ralph', options.cwd);
    if (state?.current_phase === 'cancelled') {
      return { status: 'cancelled' };
    }
    if (state?.current_phase === 'failed') {
      return {
        status: 'failed',
        error: typeof state.error === 'string' ? state.error : 'ralph_failed',
      };
    }
    return { status: 'completed' };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    process.chdir(previousCwd);
  }
}

async function invokeBackend(
  backend: BmadExecutionBackend,
  options: {
    cwd: string;
    task: string;
    storyPath: string;
    epicPath: string | null;
    iteration: number;
    executors?: BmadAutopilotExecutors;
    handoff: ReturnType<typeof buildBmadWorkflowHandoff>;
  },
): Promise<BmadAutopilotExecutorResult> {
  if (backend === 'ralph') {
    const executor = options.executors?.ralph ?? (async () => runDefaultRalphExecutor({
      cwd: options.cwd,
      task: options.task,
    }));
    return executor({
      cwd: options.cwd,
      task: options.task,
      storyPath: options.storyPath,
      epicPath: options.epicPath,
      iteration: options.iteration,
    });
  }

  if (backend === 'team') {
    if (!options.executors?.team) {
      return {
        status: 'failed',
        error: 'team_backend_requires_explicit_executor',
      };
    }
    return options.executors.team({
      cwd: options.cwd,
      task: options.task,
      storyPath: options.storyPath,
      epicPath: options.epicPath,
      iteration: options.iteration,
    });
  }

  const nativeResult = await runBmadNativeExecution({
    cwd: options.cwd,
    task: options.task,
    handoff: options.handoff,
    iteration: options.iteration,
  }, options.executors?.native);
  return {
    status: nativeResult.status === 'unsupported' ? 'unsupported' : nativeResult.status,
    error: nativeResult.error,
    artifacts: {
      native_handoff_path: nativeResult.handoffPath ?? null,
      native_artifact_paths: nativeResult.artifactPaths ?? [],
    },
  };
}

export async function runBmadAutopilotCampaign(
  options: RunBmadAutopilotCampaignOptions,
): Promise<BmadAutopilotCampaignResult> {
  const cwd = options.cwd ?? process.cwd();
  const detected = detectBmadProject(cwd);
  const maxIterations = Math.max(1, options.maxIterations ?? 100);
  const startTime = Date.now();

  if (!detected.detected) {
    return {
      kind: 'bmad-campaign',
      status: 'failed',
      stageResults: {},
      duration_ms: Date.now() - startTime,
      artifacts: {},
      error: 'bmad_not_detected',
      stopReason: 'planning_required',
      completedStoryPaths: [],
      remainingStoryPaths: [],
    };
  }

  const reconciled = await ensureBmadIntegrationState(cwd);
  const readiness = deriveBmadReadiness(reconciled.artifactIndex, reconciled.state);
  const initialContext = await resolveBmadExecutionContext(cwd, reconciled.artifactIndex, reconciled.state);

  if (!readiness.readyForExecution) {
    const recommendation = mapReadinessToRecommendation(readiness.gaps);
    await startMode('autopilot', options.task, 1, cwd);
    await updateModeState('autopilot', {
      active: false,
      current_phase: 'planning-required',
      completed_at: new Date().toISOString(),
      ...buildAutopilotBmadStateFields({
        bmad_detected: true,
        bmad_phase: reconciled.state.phase,
        bmad_ready_for_execution: false,
        bmad_recommendation: recommendation,
        bmad_campaign_active: false,
        bmad_active_story_path: initialContext.activeStoryPath,
        bmad_active_epic_path: initialContext.activeEpicPath,
        bmad_remaining_story_paths: reconciled.artifactIndex.storyPaths,
        bmad_completed_story_paths: [],
        bmad_stop_reason: 'planning_required',
        bmad_context_blocked_by_ambiguity: initialContext.contextBlockedByAmbiguity,
        bmad_writeback_blocked: initialContext.writebackBlockedByDrift,
        bmad_campaign_iteration: 0,
        bmad_execution_family: null,
      }),
    }, cwd);

    return {
      kind: 'bmad-campaign',
      status: 'failed',
      stageResults: {},
      duration_ms: Date.now() - startTime,
      artifacts: {
        bmad: {
          readiness,
          recommendation,
        },
      },
      stopReason: 'planning_required',
      recommendation,
      completedStoryPaths: [],
      remainingStoryPaths: reconciled.artifactIndex.storyPaths,
    };
  }

  await startMode('autopilot', options.task, maxIterations, cwd);

  const stageResults: Record<string, { status: 'completed' | 'failed' | 'skipped'; artifacts: Record<string, unknown>; duration_ms: number; error?: string }> = {};
  const completedStoryPaths: string[] = [];
  const hookArtifactPaths: string[] = [];
  let remainingStoryPaths = [...reconciled.artifactIndex.storyPaths];
  let stopReason: BmadCampaignStopReason | null = null;

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const before = await ensureBmadIntegrationState(cwd);
    const beforeContext = await resolveBmadExecutionContext(cwd, before.artifactIndex, before.state);
    const nextStory = await resolveNextBmadStory(cwd, {
      index: before.artifactIndex,
      state: before.state,
      context: beforeContext,
      backendSelection: options.backendSelection,
    });

    completedStoryPaths.splice(0, completedStoryPaths.length, ...nextStory.completedStoryPaths);
    remainingStoryPaths = [...nextStory.remainingStoryPaths];

    if (nextStory.status === 'complete') {
      stopReason = 'campaign_complete';
      await updateModeState('autopilot', {
        active: false,
        current_phase: 'complete',
        completed_at: new Date().toISOString(),
        ...buildAutopilotBmadStateFields({
          bmad_detected: true,
          bmad_phase: before.state.phase,
          bmad_ready_for_execution: true,
          bmad_campaign_active: false,
          bmad_remaining_story_paths: [],
          bmad_completed_story_paths: completedStoryPaths,
          bmad_stop_reason: stopReason,
          bmad_context_blocked_by_ambiguity: beforeContext.contextBlockedByAmbiguity,
          bmad_writeback_blocked: beforeContext.writebackBlockedByDrift,
          bmad_campaign_iteration: iteration - 1,
          bmad_last_hook_artifact_paths: hookArtifactPaths,
        }),
      }, cwd);
      break;
    }

    if (nextStory.status !== 'resolved' || !nextStory.storyPath || !nextStory.backend) {
      stopReason = nextStory.stopReason ?? 'ambiguous_active_story';
      await updateModeState('autopilot', {
        active: false,
        current_phase: 'blocked',
        completed_at: new Date().toISOString(),
        ...buildAutopilotBmadStateFields({
          bmad_detected: true,
          bmad_phase: before.state.phase,
          bmad_ready_for_execution: true,
          bmad_campaign_active: false,
          bmad_remaining_story_paths: remainingStoryPaths,
          bmad_completed_story_paths: completedStoryPaths,
          bmad_stop_reason: stopReason,
          bmad_context_blocked_by_ambiguity: beforeContext.contextBlockedByAmbiguity || stopReason === 'ambiguous_active_story',
          bmad_writeback_blocked: beforeContext.writebackBlockedByDrift,
          bmad_campaign_iteration: iteration,
          bmad_last_hook_artifact_paths: hookArtifactPaths,
        }),
      }, cwd);
      break;
    }

    await persistBmadActiveSelection(cwd, {
      activeStoryRef: nextStory.storyPath,
      activeEpicRef: nextStory.epicPath,
    });
    await updateModeState('autopilot', {
      current_phase: 'bmad-campaign',
      iteration,
      ...buildAutopilotBmadStateFields({
        bmad_detected: true,
        bmad_phase: before.state.phase,
        bmad_ready_for_execution: true,
        bmad_campaign_active: true,
        bmad_active_story_path: nextStory.storyPath,
        bmad_active_epic_path: nextStory.epicPath,
        bmad_remaining_story_paths: remainingStoryPaths,
        bmad_completed_story_paths: completedStoryPaths,
        bmad_backend: nextStory.backend,
        bmad_context_blocked_by_ambiguity: beforeContext.contextBlockedByAmbiguity,
        bmad_writeback_blocked: beforeContext.writebackBlockedByDrift,
        bmad_campaign_iteration: iteration,
        bmad_execution_family: nextStory.backend === 'bmad-native' ? 'bmad-native' : 'omx-native',
        bmad_last_hook_artifact_paths: hookArtifactPaths,
      }),
    }, cwd);

    const stageKey = `bmad-story-${iteration}`;
    const handoff = buildBmadWorkflowHandoff({
      source: 'autopilot',
      target: nextStory.backend,
      context: beforeContext,
      driftStatus: before.state.driftStatus,
      storyPath: nextStory.storyPath,
      epicPath: nextStory.epicPath,
    });
    const execution = await invokeBackend(nextStory.backend, {
      cwd,
      task: options.task,
      storyPath: nextStory.storyPath,
      epicPath: nextStory.epicPath,
      iteration,
      executors: options.executors,
      handoff,
    });
    stageResults[stageKey] = {
      status: execution.status === 'completed' ? 'completed' : 'failed',
      artifacts: {
        story_path: nextStory.storyPath,
        epic_path: nextStory.epicPath,
        backend: nextStory.backend,
        completion_confirmed: false,
        writeback_blocked: beforeContext.writebackBlockedByDrift,
        drift_status: before.state.driftStatus,
        handoff,
        ...(execution.artifacts ?? {}),
      },
      duration_ms: 0,
      error: execution.error,
    };

    if (execution.status === 'cancelled') {
      stopReason = 'cancelled';
      await updateModeState('autopilot', {
        active: false,
        current_phase: 'cancelled',
        completed_at: new Date().toISOString(),
        ...buildAutopilotBmadStateFields({
          bmad_detected: true,
          bmad_phase: before.state.phase,
          bmad_ready_for_execution: true,
          bmad_campaign_active: false,
          bmad_active_story_path: nextStory.storyPath,
          bmad_active_epic_path: nextStory.epicPath,
          bmad_remaining_story_paths: remainingStoryPaths,
          bmad_completed_story_paths: completedStoryPaths,
          bmad_stop_reason: stopReason,
          bmad_backend: nextStory.backend,
          bmad_context_blocked_by_ambiguity: beforeContext.contextBlockedByAmbiguity,
          bmad_writeback_blocked: beforeContext.writebackBlockedByDrift,
          bmad_campaign_iteration: iteration,
          bmad_execution_family: nextStory.backend === 'bmad-native' ? 'bmad-native' : 'omx-native',
          bmad_last_hook_artifact_paths: hookArtifactPaths,
        }),
      }, cwd);
      break;
    }
    if (execution.status === 'failed' || execution.status === 'unsupported') {
      stopReason = execution.error === 'team_backend_requires_explicit_executor'
        || execution.error === 'bmad_native_executor_not_configured'
        ? 'backend_unsupported'
        : 'backend_failed';
      await updateModeState('autopilot', {
        active: false,
        current_phase: 'failed',
        completed_at: new Date().toISOString(),
        error: execution.error,
        ...buildAutopilotBmadStateFields({
          bmad_detected: true,
          bmad_phase: before.state.phase,
          bmad_ready_for_execution: true,
          bmad_campaign_active: false,
          bmad_active_story_path: nextStory.storyPath,
          bmad_active_epic_path: nextStory.epicPath,
          bmad_remaining_story_paths: remainingStoryPaths,
          bmad_completed_story_paths: completedStoryPaths,
          bmad_stop_reason: stopReason,
          bmad_backend: nextStory.backend,
          bmad_context_blocked_by_ambiguity: beforeContext.contextBlockedByAmbiguity,
          bmad_writeback_blocked: beforeContext.writebackBlockedByDrift,
          bmad_campaign_iteration: iteration,
          bmad_execution_family: nextStory.backend === 'bmad-native' ? 'bmad-native' : 'omx-native',
          bmad_last_hook_artifact_paths: hookArtifactPaths,
        }),
      }, cwd);
      break;
    }

    const after = await ensureBmadIntegrationState(cwd);
    const afterContext = await resolveBmadExecutionContext(cwd, after.artifactIndex, after.state);
    const completion = await isBmadStoryComplete(cwd, {
      storyPath: nextStory.storyPath,
      sprintStatusPath: afterContext.sprintStatusPath,
    });

    if (completion.complete) {
      stageResults[stageKey].artifacts.completion_confirmed = true;
      if (!completedStoryPaths.includes(nextStory.storyPath)) {
        completedStoryPaths.push(nextStory.storyPath);
      }
      if (nextStory.epicPath) {
        const epicStoryPaths = inferEpicStoryPaths(after.artifactIndex, nextStory.epicPath);
        const epicStatus = await inferEpicCompletion(cwd, {
          epicPath: nextStory.epicPath,
          epicStoryPaths,
          sprintStatusPath: afterContext.sprintStatusPath,
        });
        if (epicStatus === 'complete') {
          const hook = await recordBmadEpicRetrospectiveHook(cwd, {
            implementationArtifactsRoot: afterContext.implementationArtifactsRoot,
            epicPath: nextStory.epicPath,
            completedStoryPaths: epicStoryPaths,
            backend: nextStory.backend,
            summary: `Epic completed through ${nextStory.backend} after ${iteration} campaign iteration(s).`,
          });
          if (hook.path) {
            hookArtifactPaths.push(hook.path);
          }
        }
      }
      remainingStoryPaths = after.artifactIndex.storyPaths.filter((storyPath) => !completedStoryPaths.includes(storyPath));
      continue;
    }

    const recovery = await attemptBmadDriftRecovery(cwd, {
      index: after.artifactIndex,
      state: after.state,
      context: afterContext,
      storyPath: nextStory.storyPath,
    });
    const nextAfter = await resolveNextBmadStory(cwd, {
      index: after.artifactIndex,
      state: after.state,
      context: afterContext,
      backendSelection: options.backendSelection,
    });
    const canRetryOnce =
      before.state.driftStatus === 'soft'
      && after.artifactIndex.artifactIndexVersion !== before.artifactIndex.artifactIndexVersion
      && nextAfter.status === 'resolved'
      && nextAfter.storyPath === nextStory.storyPath;
    const canRecoverRetry = recovery.allowedRetry && afterContext.writebackBlockedByDrift !== true;
    if (canRetryOnce || canRecoverRetry) {
      const retry = await invokeBackend(nextStory.backend, {
        cwd,
        task: options.task,
        storyPath: nextStory.storyPath,
        epicPath: nextStory.epicPath,
        iteration,
        executors: options.executors,
        handoff: buildBmadWorkflowHandoff({
          source: 'autopilot',
          target: nextStory.backend,
          context: afterContext,
          driftStatus: after.state.driftStatus,
          storyPath: nextStory.storyPath,
          epicPath: nextStory.epicPath,
        }),
      });
      if (retry.status === 'completed') {
        const afterRetry = await ensureBmadIntegrationState(cwd);
        const retryContext = await resolveBmadExecutionContext(cwd, afterRetry.artifactIndex, afterRetry.state);
        const confirmed = await isBmadStoryComplete(cwd, {
          storyPath: nextStory.storyPath,
          sprintStatusPath: retryContext.sprintStatusPath,
        });
        if (confirmed.complete) {
          stageResults[stageKey].artifacts.completion_confirmed = true;
          if (!completedStoryPaths.includes(nextStory.storyPath)) {
            completedStoryPaths.push(nextStory.storyPath);
          }
          remainingStoryPaths = afterRetry.artifactIndex.storyPaths.filter((storyPath) => !completedStoryPaths.includes(storyPath));
          continue;
        }
      }
    }

    stopReason = after.state.driftStatus === 'hard'
      ? 'hard_drift'
      : afterContext.writebackBlockedByDrift
        ? 'writeback_blocked'
        : 'story_not_completed_after_execution';
    await updateModeState('autopilot', {
      active: false,
      current_phase: 'blocked',
      completed_at: new Date().toISOString(),
      ...buildAutopilotBmadStateFields({
        bmad_detected: true,
        bmad_phase: after.state.phase,
        bmad_ready_for_execution: true,
        bmad_campaign_active: false,
        bmad_active_story_path: nextStory.storyPath,
        bmad_active_epic_path: nextStory.epicPath,
        bmad_remaining_story_paths: remainingStoryPaths,
        bmad_completed_story_paths: completedStoryPaths,
        bmad_stop_reason: stopReason,
        bmad_backend: nextStory.backend,
        bmad_context_blocked_by_ambiguity: afterContext.contextBlockedByAmbiguity,
        bmad_writeback_blocked: afterContext.writebackBlockedByDrift,
        bmad_campaign_iteration: iteration,
        bmad_execution_family: nextStory.backend === 'bmad-native' ? 'bmad-native' : 'omx-native',
        bmad_drift_recovery_attempted: recovery.attempted,
        bmad_drift_recovery_succeeded: recovery.recovered,
        bmad_drift_recovery_reason: recovery.reason,
        bmad_last_hook_artifact_paths: hookArtifactPaths,
      }),
    }, cwd);
    break;
  }

  await persistBmadActiveSelection(cwd, { activeStoryRef: null, activeEpicRef: null });

  const status = stopReason === 'campaign_complete'
    ? 'completed'
    : stopReason === 'cancelled'
      ? 'cancelled'
      : stopReason === 'backend_failed' || stopReason === 'backend_unsupported'
        ? 'failed'
        : 'failed';

  return {
    kind: 'bmad-campaign',
    status,
    stageResults,
    duration_ms: Date.now() - startTime,
    artifacts: {
      bmadCampaign: {
        completed_stories: completedStoryPaths,
        remaining_stories: remainingStoryPaths,
        stop_reason: stopReason,
        total_iterations: Object.keys(stageResults).length,
        backlog_exhausted: remainingStoryPaths.length === 0,
        hook_artifact_paths: hookArtifactPaths,
      },
    },
    stopReason,
    completedStoryPaths,
    remainingStoryPaths,
    ...(status === 'failed' && stopReason ? { error: stopReason } : {}),
  };
}

export async function runAutopilotWithRouting(
  options: RunAutopilotWithRoutingOptions,
): Promise<PipelineResult | BmadAutopilotCampaignResult> {
  const cwd = options.cwd ?? process.cwd();
  if (!detectBmadProject(cwd).detected) {
    return runPipeline(createAutopilotPipelineConfig(options.task, {
      cwd,
      sessionId: options.sessionId,
      stages: options.stages,
      maxRalphIterations: options.maxRalphIterations,
      workerCount: options.workerCount,
      agentType: options.agentType,
      onStageTransition: options.onStageTransition,
    }));
  }

  return runBmadAutopilotCampaign(options);
}
