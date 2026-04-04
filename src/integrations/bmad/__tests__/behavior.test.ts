import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BmadArtifactIndex, BmadPersistedState } from '../contracts.js';
import { deriveBmadReadiness } from '../readiness.js';
import { resolveBmadExecutionContext } from '../context.js';
import {
  recordImplementationArtifactSummary,
  recordSprintStatusUpdate,
  recordStoryCompletion,
} from '../writeback.js';
import { recordBmadEpicRetrospectiveHook, recordBmadStoryHook } from '../hooks.js';

function baseIndex(root: string): BmadArtifactIndex {
  return {
    scannedAt: new Date().toISOString(),
    projectRoot: root,
    detected: true,
    detectionSignals: ['_bmad-output'],
    artifactIndexVersion: 'v1',
    projectContextPath: '_bmad-output/project-context.md',
    prdPaths: ['_bmad-output/planning-artifacts/PRD.md'],
    uxPaths: [],
    architecturePaths: ['_bmad-output/planning-artifacts/architecture.md'],
    epicPaths: ['_bmad-output/planning-artifacts/epics/epic-1.md'],
    storyPaths: ['_bmad-output/planning-artifacts/epics/story-1.md'],
    sprintStatusPaths: ['_bmad-output/implementation-artifacts/sprint-status.yaml'],
    implementationArtifactPaths: ['_bmad-output/implementation-artifacts/sprint-status.yaml'],
    pathMetadata: {},
  };
}

function baseState(): BmadPersistedState {
  return {
    detected: true,
    detectionSignals: ['_bmad-output'],
    track: 'method-like',
    phase: 'implementation',
    planningReadiness: true,
    implementationReadiness: true,
    activeEpicRef: '_bmad-output/planning-artifacts/epics/epic-1.md',
    activeStoryRef: '_bmad-output/planning-artifacts/epics/story-1.md',
    artifactIndexVersion: 'v1',
    lastReconciledAt: new Date().toISOString(),
    driftStatus: 'none',
  };
}

async function writeProjectFile(root: string, relativePath: string, contents: string): Promise<void> {
  await mkdir(dirname(join(root, relativePath)), { recursive: true });
  await writeFile(join(root, relativePath), contents, 'utf-8');
}

describe('BMAD readiness and execution context', () => {
  it('marks ambiguous active story as not ready for execution', () => {
    const index = {
      ...baseIndex('/repo'),
      storyPaths: [
        '_bmad-output/planning-artifacts/epics/story-1.md',
        '_bmad-output/planning-artifacts/epics/story-2.md',
      ],
    };
    const state = {
      ...baseState(),
      activeStoryRef: null,
    };
    const readiness = deriveBmadReadiness(index, state);
    assert.equal(readiness.readyForExecution, false);
    assert.equal(readiness.ambiguousActiveStory, true);
    assert.ok(readiness.gaps.includes('ambiguous_active_story'));
  });

  it('blocks writeback in execution context when drift is medium', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-bmad-context-'));
    try {
      await mkdir(join(root, '_bmad-output', 'implementation-artifacts'), { recursive: true });
      const context = await resolveBmadExecutionContext(root, baseIndex(root), {
        ...baseState(),
        driftStatus: 'medium',
      });
      assert.equal(context.writebackBlockedByDrift, true);
      assert.equal(context.writebackSupported, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('extracts acceptance criteria from a story markdown heading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-bmad-context-'));
    try {
      await writeProjectFile(
        root,
        '_bmad-output/planning-artifacts/epics/story-1.md',
        '# Story\n\n## Acceptance Criteria\n- user can log in\n- errors are shown\n',
      );
      await mkdir(join(root, '_bmad-output', 'implementation-artifacts'), { recursive: true });
      const context = await resolveBmadExecutionContext(root, baseIndex(root), baseState());
      assert.deepEqual(context.storyAcceptanceCriteria, ['user can log in', 'errors are shown']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('BMAD writeback helpers', () => {
  it('writes story completion blocks idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-bmad-writeback-'));
    try {
      await writeProjectFile(root, '_bmad-output/planning-artifacts/epics/story-1.md', '# Story\n');
      await recordStoryCompletion(root, {
        storyPath: '_bmad-output/planning-artifacts/epics/story-1.md',
        completedAt: '2026-04-03T00:00:00.000Z',
        mode: 'ralph',
        verificationSummary: 'tests passed',
        implementationArtifactPaths: ['_bmad-output/implementation-artifacts/omx-story-run-story-1.md'],
      });
      await recordStoryCompletion(root, {
        storyPath: '_bmad-output/planning-artifacts/epics/story-1.md',
        completedAt: '2026-04-03T00:00:00.000Z',
        mode: 'ralph',
        verificationSummary: 'tests passed',
        implementationArtifactPaths: ['_bmad-output/implementation-artifacts/omx-story-run-story-1.md'],
      });
      const content = await readFile(join(root, '_bmad-output/planning-artifacts/epics/story-1.md'), 'utf-8');
      assert.equal((content.match(/OMX Completion Summary/g) || []).length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns unsupported for sprint updates without conservative story mapping', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-bmad-writeback-'));
    try {
      await writeProjectFile(root, '_bmad-output/implementation-artifacts/sprint-status.yaml', 'stories:\n  - id: other-story\n    status: pending\n');
      const result = await recordSprintStatusUpdate(root, {
        sprintStatusPath: '_bmad-output/implementation-artifacts/sprint-status.yaml',
        storyPath: '_bmad-output/planning-artifacts/epics/story-1.md',
        status: 'completed',
      });
      assert.equal(result.status, 'unsupported');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('creates deterministic implementation artifact summaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-bmad-writeback-'));
    try {
      const result = await recordImplementationArtifactSummary(root, {
        implementationArtifactsRoot: '_bmad-output/implementation-artifacts',
        storyPath: '_bmad-output/planning-artifacts/epics/story-login.md',
        epicPath: '_bmad-output/planning-artifacts/epics/epic-auth.md',
        verificationSummary: 'tests passed',
        kind: 'verification',
      });
      assert.equal(result.status, 'applied');
      assert.equal(result.path, '_bmad-output/implementation-artifacts/omx-verification-story-login.md');
      const content = await readFile(join(root, result.path!), 'utf-8');
      assert.match(content, /# OMX Implementation Summary/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('includes backend provenance in implementation artifact summaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-bmad-writeback-'));
    try {
      const result = await recordImplementationArtifactSummary(root, {
        implementationArtifactsRoot: '_bmad-output/implementation-artifacts',
        storyPath: '_bmad-output/planning-artifacts/epics/story-login.md',
        epicPath: '_bmad-output/planning-artifacts/epics/epic-auth.md',
        verificationSummary: 'tests passed',
        backend: 'bmad-native',
      });
      const content = await readFile(join(root, result.path!), 'utf-8');
      assert.match(content, /- Backend: bmad-native/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes implementation-side story and epic hook artifacts only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-bmad-hooks-'));
    try {
      const storyHook = await recordBmadStoryHook(root, {
        implementationArtifactsRoot: '_bmad-output/implementation-artifacts',
        storyPath: '_bmad-output/planning-artifacts/epics/story-login.md',
        epicPath: '_bmad-output/planning-artifacts/epics/epic-auth.md',
        backend: 'ralph',
        verificationSummary: 'ok',
      });
      const epicHook = await recordBmadEpicRetrospectiveHook(root, {
        implementationArtifactsRoot: '_bmad-output/implementation-artifacts',
        epicPath: '_bmad-output/planning-artifacts/epics/epic-auth.md',
        completedStoryPaths: ['_bmad-output/planning-artifacts/epics/story-login.md'],
        backend: 'ralph',
        summary: 'epic done',
      });
      assert.equal(storyHook.status, 'applied');
      assert.equal(epicHook.status, 'applied');
      assert.match(storyHook.path!, /omx-story-hook-story-login\.md$/);
      assert.match(epicHook.path!, /omx-retrospective-epic-auth\.md$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
