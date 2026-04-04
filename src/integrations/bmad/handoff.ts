import type {
  BmadDriftSeverity,
  BmadExecutionContext,
  BmadWorkflowHandoff,
} from './contracts.js';

export function buildBmadWorkflowHandoff(params: {
  source: BmadWorkflowHandoff['source'];
  target: BmadWorkflowHandoff['target'];
  context: BmadExecutionContext;
  driftStatus: BmadDriftSeverity;
  storyPath?: string | null;
  epicPath?: string | null;
}): BmadWorkflowHandoff {
  return {
    source: params.source,
    target: params.target,
    storyPath: params.storyPath ?? params.context.activeStoryPath,
    epicPath: params.epicPath ?? params.context.activeEpicPath,
    projectContextPath: params.context.projectContextPath,
    architecturePaths: [...params.context.architecturePaths],
    acceptanceCriteria: [...params.context.storyAcceptanceCriteria],
    sprintStatusPath: params.context.sprintStatusPath,
    implementationArtifactsRoot: params.context.implementationArtifactsRoot,
    driftStatus: params.driftStatus,
    writebackSupported: params.context.writebackSupported,
    contextBlockedByAmbiguity: params.context.contextBlockedByAmbiguity,
  };
}

export function renderBmadWorkflowHandoff(handoff: BmadWorkflowHandoff): string {
  return [
    '# OMX BMAD Workflow Handoff',
    '',
    `- Source: ${handoff.source}`,
    `- Target: ${handoff.target}`,
    `- Story: ${handoff.storyPath ?? 'none'}`,
    `- Epic: ${handoff.epicPath ?? 'none'}`,
    `- Project context: ${handoff.projectContextPath ?? 'none'}`,
    `- Architecture: ${handoff.architecturePaths.length > 0 ? handoff.architecturePaths.join(', ') : 'none'}`,
    `- Sprint status: ${handoff.sprintStatusPath ?? 'none'}`,
    `- Implementation artifacts root: ${handoff.implementationArtifactsRoot ?? 'none'}`,
    `- Drift status: ${handoff.driftStatus}`,
    `- Writeback supported: ${handoff.writebackSupported ? 'yes' : 'no'}`,
    `- Context ambiguity: ${handoff.contextBlockedByAmbiguity ? 'present' : 'none'}`,
    `- Acceptance criteria: ${handoff.acceptanceCriteria.length > 0 ? handoff.acceptanceCriteria.join(' | ') : 'none extracted'}`,
    '',
  ].join('\n');
}
