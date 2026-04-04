export type BmadTrack = 'unknown' | 'quick-flow' | 'method-like' | 'enterprise-like';

export type BmadPhase =
  | 'absent'
  | 'planning'
  | 'solutioning'
  | 'implementation'
  | 'mixed';

export type BmadDriftSeverity = 'none' | 'soft' | 'medium' | 'hard';
export type BmadExecutionBackend = 'ralph' | 'team' | 'bmad-native';

export interface BmadDetectionResult {
  detected: boolean;
  detectionSignals: string[];
}

export interface BmadPathMetadata {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface BmadArtifactIndex {
  scannedAt: string;
  projectRoot: string;
  detected: boolean;
  detectionSignals: string[];
  artifactIndexVersion: string;
  outputRoot: string | null;
  projectContextPath: string | null;
  prdPaths: string[];
  uxPaths: string[];
  architecturePaths: string[];
  epicPaths: string[];
  storyPaths: string[];
  sprintStatusPaths: string[];
  implementationArtifactPaths: string[];
  pathMetadata: Record<string, BmadPathMetadata>;
}

export interface BmadProjection {
  detected: boolean;
  detectionSignals: string[];
  track: BmadTrack;
  phase: BmadPhase;
  planningReadiness: boolean;
  implementationReadiness: boolean;
  activeEpicRef: string | null;
  activeStoryRef: string | null;
  artifactIndexVersion: string;
  lastReconciledAt: string;
  driftStatus: BmadDriftSeverity;
}

export interface BmadPersistedState extends BmadProjection {}

export type BmadGap =
  | 'missing_prd'
  | 'missing_architecture'
  | 'missing_story_or_sprint'
  | 'ambiguous_active_story'
  | 'hard_drift';

export interface BmadReadinessResult {
  detected: boolean;
  phase: BmadPhase;
  readyForExecution: boolean;
  gaps: BmadGap[];
  gapSummary: string[];
  ambiguousActiveStory: boolean;
  writebackSupported: boolean;
  activeEpicPath: string | null;
  activeStoryPath: string | null;
}

export interface BmadAcceptanceCriteriaResult {
  storyPath: string | null;
  criteria: string[];
  source: 'frontmatter' | 'markdown-heading' | 'none';
}

export interface BmadExecutionContext {
  detected: boolean;
  outputRoot: string | null;
  projectContextPath: string | null;
  architecturePaths: string[];
  activeStoryPath: string | null;
  activeEpicPath: string | null;
  storyAcceptanceCriteria: string[];
  sprintStatusPath: string | null;
  implementationArtifactsRoot: string | null;
  contextBlockedByAmbiguity: boolean;
  writebackSupported: boolean;
  writebackBlockedByDrift: boolean;
}

export interface BmadWorkflowHandoff {
  source: 'ralplan' | 'ralph' | 'team' | 'autopilot' | 'omx-native';
  target: 'ralph' | 'team' | 'bmad-native';
  storyPath: string | null;
  epicPath: string | null;
  projectContextPath: string | null;
  architecturePaths: string[];
  acceptanceCriteria: string[];
  sprintStatusPath: string | null;
  implementationArtifactsRoot: string | null;
  driftStatus: BmadDriftSeverity;
  writebackSupported: boolean;
  contextBlockedByAmbiguity: boolean;
}

export interface BmadNativeExecutionRequest {
  cwd: string;
  task: string;
  handoff: BmadWorkflowHandoff;
  iteration: number;
}

export interface BmadNativeExecutionResult {
  status: 'completed' | 'failed' | 'cancelled' | 'unsupported';
  backend: BmadExecutionBackend;
  handoffPath?: string;
  artifactPaths?: string[];
  error?: string;
}

export type BmadWritebackStatus = 'applied' | 'skipped' | 'unsupported' | 'conflict';

export interface BmadWritebackResult {
  status: BmadWritebackStatus;
  target: 'story' | 'sprint-status' | 'implementation-artifact';
  path: string | null;
  reason?: string;
}

export interface BmadRetrospectiveHookResult {
  status: BmadWritebackStatus;
  target: 'story-hook' | 'epic-hook';
  path: string | null;
  reason?: string;
}

export interface BmadDriftRecoveryResult {
  attempted: boolean;
  allowedRetry: boolean;
  recovered: boolean;
  driftStatus: BmadDriftSeverity;
  activeStoryPath: string | null;
  sprintStatusPath: string | null;
  reason: string;
}

export interface BmadReconcileLogEntry {
  timestamp: string;
  artifactIndexVersion: string;
  driftStatus: BmadDriftSeverity;
  detected: boolean;
  phase: BmadPhase;
  planningReadiness: boolean;
  implementationReadiness: boolean;
}

export interface BmadDriftLogEntry {
  timestamp: string;
  driftStatus: Exclude<BmadDriftSeverity, 'none'>;
  artifactIndexVersion: string;
  detected: boolean;
  phase: BmadPhase;
}

export interface BmadReconcileResult {
  state: BmadPersistedState;
  artifactIndex: BmadArtifactIndex;
  reconcileLog: BmadReconcileLogEntry[];
  driftLog: BmadDriftLogEntry[];
}
