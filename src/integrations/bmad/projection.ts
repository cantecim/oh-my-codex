import type { BmadArtifactIndex, BmadDriftSeverity, BmadPersistedState, BmadPhase, BmadProjection } from './contracts.js';
import { inferBmadTrack } from './discovery.js';

function inferPhase(index: BmadArtifactIndex): BmadPhase {
  if (!index.detected) return 'absent';

  const hasPrdOrUx = index.prdPaths.length > 0 || index.uxPaths.length > 0;
  const hasArchitecture = index.architecturePaths.length > 0;
  const hasImplementationUnits = index.storyPaths.length > 0 || index.sprintStatusPaths.length > 0;
  const hasImplementationArtifacts = index.implementationArtifactPaths.length > 0;

  if (hasImplementationUnits) return 'implementation';
  if (hasArchitecture && !hasImplementationArtifacts) return 'solutioning';
  if (hasPrdOrUx && !hasArchitecture) return 'planning';
  if (!hasPrdOrUx && !hasArchitecture && !hasImplementationUnits && !hasImplementationArtifacts) return 'mixed';
  return 'mixed';
}

function inferActiveRef(paths: readonly string[]): string | null {
  return paths.length === 1 ? paths[0] : null;
}

function preserveActiveRef(
  paths: readonly string[],
  previousRef: string | null | undefined,
): string | null {
  if (previousRef && paths.includes(previousRef)) {
    return previousRef;
  }
  return inferActiveRef(paths);
}

export function classifyBmadDrift(
  index: BmadArtifactIndex,
  previousState?: Pick<BmadPersistedState, 'detected' | 'artifactIndexVersion'> | null,
  previousIndex?: Pick<BmadArtifactIndex, 'detected' | 'projectContextPath' | 'prdPaths' | 'architecturePaths' | 'storyPaths' | 'sprintStatusPaths'> | null,
): BmadDriftSeverity {
  if (!previousState && !previousIndex) return 'none';

  const previouslyDetected = previousState?.detected ?? previousIndex?.detected ?? false;
  if (previouslyDetected && !index.detected) return 'hard';
  if (!index.detected) return 'none';

  if (previousState?.artifactIndexVersion === index.artifactIndexVersion) return 'none';

  const previousPrimaryPaths = new Set<string>([
    ...(previousIndex?.projectContextPath ? [previousIndex.projectContextPath] : []),
    ...(previousIndex?.prdPaths ?? []),
    ...(previousIndex?.architecturePaths ?? []),
    ...(previousIndex?.storyPaths ?? []),
    ...(previousIndex?.sprintStatusPaths ?? []),
  ]);

  const currentPrimaryPaths = new Set<string>([
    ...(index.projectContextPath ? [index.projectContextPath] : []),
    ...index.prdPaths,
    ...index.architecturePaths,
    ...index.storyPaths,
    ...index.sprintStatusPaths,
  ]);

  for (const path of previousPrimaryPaths) {
    if (!currentPrimaryPaths.has(path)) {
      return 'medium';
    }
  }

  return 'soft';
}

export function deriveBmadProjection(
  index: BmadArtifactIndex,
  previousState?: BmadPersistedState | null,
  previousIndex?: BmadArtifactIndex | null,
): BmadProjection {
  const planningReadiness = index.prdPaths.length > 0;
  const implementationReadiness = index.architecturePaths.length > 0
    && (index.storyPaths.length > 0 || index.sprintStatusPaths.length > 0);
  const driftStatus = classifyBmadDrift(index, previousState, previousIndex);

  return {
    detected: index.detected,
    detectionSignals: [...index.detectionSignals],
    track: inferBmadTrack(index),
    phase: inferPhase(index),
    planningReadiness,
    implementationReadiness,
    activeEpicRef: preserveActiveRef(index.epicPaths, previousState?.activeEpicRef),
    activeStoryRef: preserveActiveRef(index.storyPaths, previousState?.activeStoryRef),
    artifactIndexVersion: index.artifactIndexVersion,
    lastReconciledAt: new Date().toISOString(),
    driftStatus,
  };
}
