import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  getBmadArtifactIndexPath,
  getBmadDriftLogPath,
  getBmadReconcileLogPath,
  getBmadStatePath,
  getIntegrationStateDir,
} from '../../state/paths.js';
import type {
  BmadArtifactIndex,
  BmadDriftLogEntry,
  BmadPersistedState,
  BmadReconcileLogEntry,
  BmadReconcileResult,
} from './contracts.js';
import { buildBmadArtifactIndex, detectBmadProject } from './discovery.js';
import { deriveBmadProjection } from './projection.js';

const MAX_LOG_ENTRIES = 50;

async function readJsonFile<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export async function readPersistedBmadIntegrationState(
  projectRoot: string,
): Promise<BmadPersistedState | null> {
  return readJsonFile<BmadPersistedState>(getBmadStatePath(projectRoot));
}

export async function readPersistedBmadArtifactIndex(
  projectRoot: string,
): Promise<BmadArtifactIndex | null> {
  return readJsonFile<BmadArtifactIndex>(getBmadArtifactIndexPath(projectRoot));
}

export async function writePersistedBmadIntegrationState(
  projectRoot: string,
  state: BmadPersistedState,
): Promise<void> {
  const integrationDir = getIntegrationStateDir(projectRoot);
  await mkdir(integrationDir, { recursive: true });
  await writeFile(getBmadStatePath(projectRoot), JSON.stringify(state, null, 2));
}

export async function persistBmadActiveSelection(
  projectRoot: string,
  selection: { activeStoryRef: string | null; activeEpicRef: string | null },
): Promise<BmadPersistedState | null> {
  const state = await readPersistedBmadIntegrationState(projectRoot);
  if (!state) return null;
  const nextState: BmadPersistedState = {
    ...state,
    activeStoryRef: selection.activeStoryRef,
    activeEpicRef: selection.activeEpicRef,
  };
  await writePersistedBmadIntegrationState(projectRoot, nextState);
  return nextState;
}

function trimLog<T>(entries: readonly T[]): T[] {
  return entries.slice(-MAX_LOG_ENTRIES);
}

export async function reconcileBmadIntegrationState(
  projectRoot: string,
  previousState?: BmadPersistedState | null,
): Promise<BmadReconcileResult> {
  const integrationDir = getIntegrationStateDir(projectRoot);
  await mkdir(integrationDir, { recursive: true });

  const storedState = previousState ?? await readJsonFile<BmadPersistedState>(getBmadStatePath(projectRoot));
  const storedIndex = await readJsonFile<BmadArtifactIndex>(getBmadArtifactIndexPath(projectRoot));
  const storedReconcileLog = await readJsonFile<BmadReconcileLogEntry[]>(getBmadReconcileLogPath(projectRoot));
  const storedDriftLog = await readJsonFile<BmadDriftLogEntry[]>(getBmadDriftLogPath(projectRoot));

  const detection = detectBmadProject(projectRoot);
  const artifactIndex = await buildBmadArtifactIndex(projectRoot);
  const projection = deriveBmadProjection(
    { ...artifactIndex, detected: detection.detected, detectionSignals: detection.detectionSignals },
    storedState,
    storedIndex,
  );

  const nextState: BmadPersistedState = {
    ...projection,
  };

  const reconcileEntry: BmadReconcileLogEntry = {
    timestamp: projection.lastReconciledAt,
    artifactIndexVersion: projection.artifactIndexVersion,
    driftStatus: projection.driftStatus,
    detected: projection.detected,
    phase: projection.phase,
    planningReadiness: projection.planningReadiness,
    implementationReadiness: projection.implementationReadiness,
  };

  const reconcileLog = trimLog([...(storedReconcileLog ?? []), reconcileEntry]);
  const driftLog = projection.driftStatus === 'none'
    ? (storedDriftLog ?? [])
    : trimLog([
      ...(storedDriftLog ?? []),
      {
        timestamp: projection.lastReconciledAt,
        driftStatus: projection.driftStatus,
        artifactIndexVersion: projection.artifactIndexVersion,
        detected: projection.detected,
        phase: projection.phase,
      } satisfies BmadDriftLogEntry,
    ]);

  await writeFile(getBmadStatePath(projectRoot), JSON.stringify(nextState, null, 2));
  await writeFile(getBmadArtifactIndexPath(projectRoot), JSON.stringify(artifactIndex, null, 2));
  await writeFile(getBmadReconcileLogPath(projectRoot), JSON.stringify(reconcileLog, null, 2));
  if (driftLog.length > 0) {
    await writeFile(getBmadDriftLogPath(projectRoot), JSON.stringify(driftLog, null, 2));
  }

  return {
    state: nextState,
    artifactIndex,
    reconcileLog,
    driftLog,
  };
}
