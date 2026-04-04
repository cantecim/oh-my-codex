import type { BmadCampaignStopReason } from './campaign.js';
import type { BmadExecutionBackend, BmadPhase } from './contracts.js';

export interface AutopilotBmadStateFields {
  bmad_detected: boolean;
  bmad_phase?: BmadPhase;
  bmad_ready_for_execution?: boolean;
  bmad_recommendation?: string | null;
  bmad_campaign_active?: boolean;
  bmad_active_story_path?: string | null;
  bmad_active_epic_path?: string | null;
  bmad_remaining_story_paths?: string[];
  bmad_completed_story_paths?: string[];
  bmad_stop_reason?: BmadCampaignStopReason | null;
  bmad_backend?: BmadExecutionBackend | null;
  bmad_context_blocked_by_ambiguity?: boolean;
  bmad_writeback_blocked?: boolean;
  bmad_campaign_iteration?: number;
  bmad_execution_family?: 'omx-native' | 'bmad-native' | null;
  bmad_drift_recovery_attempted?: boolean;
  bmad_drift_recovery_succeeded?: boolean;
  bmad_drift_recovery_reason?: string | null;
  bmad_last_hook_artifact_paths?: string[];
}

export function buildAutopilotBmadStateFields(
  fields: AutopilotBmadStateFields,
): AutopilotBmadStateFields {
  return {
    bmad_detected: fields.bmad_detected,
    bmad_phase: fields.bmad_phase,
    bmad_ready_for_execution: fields.bmad_ready_for_execution,
    bmad_recommendation: fields.bmad_recommendation ?? null,
    bmad_campaign_active: fields.bmad_campaign_active,
    bmad_active_story_path: fields.bmad_active_story_path ?? null,
    bmad_active_epic_path: fields.bmad_active_epic_path ?? null,
    bmad_remaining_story_paths: fields.bmad_remaining_story_paths ?? [],
    bmad_completed_story_paths: fields.bmad_completed_story_paths ?? [],
    bmad_stop_reason: fields.bmad_stop_reason ?? null,
    bmad_backend: fields.bmad_backend ?? null,
    bmad_context_blocked_by_ambiguity: fields.bmad_context_blocked_by_ambiguity ?? false,
    bmad_writeback_blocked: fields.bmad_writeback_blocked ?? false,
    bmad_campaign_iteration: fields.bmad_campaign_iteration ?? 0,
    bmad_execution_family: fields.bmad_execution_family ?? null,
    bmad_drift_recovery_attempted: fields.bmad_drift_recovery_attempted ?? false,
    bmad_drift_recovery_succeeded: fields.bmad_drift_recovery_succeeded ?? false,
    bmad_drift_recovery_reason: fields.bmad_drift_recovery_reason ?? null,
    bmad_last_hook_artifact_paths: fields.bmad_last_hook_artifact_paths ?? [],
  };
}
