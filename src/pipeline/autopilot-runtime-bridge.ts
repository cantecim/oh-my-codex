import { createRalphVerifyStage } from './stages/ralph-verify.js';
import { createRalplanStage } from './stages/ralplan.js';
import { createTeamExecStage } from './stages/team-exec.js';
import {
  runAutopilotWithRouting,
  type BmadAutopilotCampaignResult,
  type RunAutopilotWithRoutingOptions,
} from './bmad-autopilot.js';
import type { PipelineResult, PipelineStage } from './types.js';

export interface CreateDefaultAutopilotStagesOptions {
  maxRalphIterations?: number;
  workerCount?: number;
  agentType?: string;
}

export interface RunAutopilotSkillRuntimeBridgeOptions
  extends Omit<RunAutopilotWithRoutingOptions, 'stages'> {
  stageOptions?: CreateDefaultAutopilotStagesOptions;
}

export function createDefaultAutopilotStages(
  options: CreateDefaultAutopilotStagesOptions = {},
): PipelineStage[] {
  return [
    createRalplanStage(),
    createTeamExecStage({
      workerCount: options.workerCount,
      agentType: options.agentType,
    }),
    createRalphVerifyStage({
      maxIterations: options.maxRalphIterations,
    }),
  ];
}

/**
 * Canonical skill/runtime bridge entrypoint for autopilot.
 *
 * This is the user-facing OMX runtime surface for autopilot behavior:
 * - non-BMAD repos use the standard stage-linear autopilot pipeline
 * - BMAD repos route through BMAD-aware gating/campaign execution first
 */
export async function runAutopilotSkillRuntimeBridge(
  options: RunAutopilotSkillRuntimeBridgeOptions,
): Promise<PipelineResult | BmadAutopilotCampaignResult> {
  const stages = createDefaultAutopilotStages(options.stageOptions);
  return runAutopilotWithRouting({
    ...options,
    stages,
    maxRalphIterations: options.maxRalphIterations ?? options.stageOptions?.maxRalphIterations,
    workerCount: options.workerCount ?? options.stageOptions?.workerCount,
    agentType: options.agentType ?? options.stageOptions?.agentType,
  });
}
