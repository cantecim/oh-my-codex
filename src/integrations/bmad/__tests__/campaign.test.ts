import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BmadArtifactIndex, BmadExecutionContext, BmadPersistedState } from '../contracts.js';
import { resolveNextBmadStory } from '../campaign.js';
import { recordStoryCompletion } from '../writeback.js';

function makeIndex(projectRoot: string, overrides: Partial<BmadArtifactIndex> = {}): BmadArtifactIndex {
  return {
    scannedAt: new Date().toISOString(),
    projectRoot,
    detected: true,
    detectionSignals: ['_bmad-output'],
    artifactIndexVersion: 'v1',
    outputRoot: '_bmad-output',
    projectContextPath: '_bmad-output/project-context.md',
    prdPaths: ['_bmad-output/planning-artifacts/PRD.md'],
    uxPaths: [],
    architecturePaths: ['_bmad-output/planning-artifacts/architecture.md'],
    epicPaths: ['_bmad-output/planning-artifacts/epics/epic-auth.md'],
    storyPaths: ['_bmad-output/planning-artifacts/epics/story-login.md'],
    sprintStatusPaths: ['_bmad-output/implementation-artifacts/sprint-status.yaml'],
    implementationArtifactPaths: ['_bmad-output/implementation-artifacts/sprint-status.yaml'],
    pathMetadata: {},
    ...overrides,
  };
}

function makeState(overrides: Partial<BmadPersistedState> = {}): BmadPersistedState {
  return {
    detected: true,
    detectionSignals: ['_bmad-output'],
    track: 'method-like',
    phase: 'implementation',
    planningReadiness: true,
    implementationReadiness: true,
    activeEpicRef: null,
    activeStoryRef: null,
    artifactIndexVersion: 'v1',
    lastReconciledAt: new Date().toISOString(),
    driftStatus: 'none',
    ...overrides,
  };
}

function makeContext(overrides: Partial<BmadExecutionContext> = {}): BmadExecutionContext {
  return {
    detected: true,
    outputRoot: '_bmad-output',
    projectContextPath: '_bmad-output/project-context.md',
    architecturePaths: ['_bmad-output/planning-artifacts/architecture.md'],
    activeStoryPath: null,
    activeEpicPath: null,
    storyAcceptanceCriteria: [],
    sprintStatusPath: '_bmad-output/implementation-artifacts/sprint-status.yaml',
    implementationArtifactsRoot: '_bmad-output/implementation-artifacts',
    contextBlockedByAmbiguity: false,
    writebackSupported: true,
    writebackBlockedByDrift: false,
    ...overrides,
  };
}

async function createProjectFiles(root: string, storyPaths: string[], sprintStatus = 'stories:\n'): Promise<void> {
  await mkdir(join(root, '_bmad-output', 'planning-artifacts', 'epics'), { recursive: true });
  await mkdir(join(root, '_bmad-output', 'implementation-artifacts'), { recursive: true });
  await writeFile(join(root, '_bmad-output', 'planning-artifacts', 'PRD.md'), '# PRD\n');
  await writeFile(join(root, '_bmad-output', 'planning-artifacts', 'architecture.md'), '# Architecture\n');
  await writeFile(join(root, '_bmad-output', 'project-context.md'), '# Context\n');
  await writeFile(join(root, '_bmad-output', 'planning-artifacts', 'epics', 'epic-auth.md'), '# Epic\n');
  for (const storyPath of storyPaths) {
    await writeFile(join(root, storyPath), '# Story\n');
  }
  await writeFile(join(root, '_bmad-output', 'implementation-artifacts', 'sprint-status.yaml'), sprintStatus);
}

describe('BMAD campaign resolution', () => {
  it('resolves the unique execution-ready story', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-bmad-campaign-'));
    try {
      await createProjectFiles(root, ['_bmad-output/planning-artifacts/epics/story-login.md']);
      const result = await resolveNextBmadStory(root, {
        index: makeIndex(root),
        state: makeState(),
        context: makeContext(),
      });

      assert.equal(result.status, 'resolved');
      assert.equal(result.storyPath, '_bmad-output/planning-artifacts/epics/story-login.md');
      assert.equal(result.backend, 'ralph');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns ambiguity when multiple stories remain without a conservative signal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-bmad-campaign-'));
    try {
      const stories = [
        '_bmad-output/planning-artifacts/epics/story-login.md',
        '_bmad-output/planning-artifacts/epics/story-profile.md',
      ];
      await createProjectFiles(root, stories);
      const result = await resolveNextBmadStory(root, {
        index: makeIndex(root, { storyPaths: stories }),
        state: makeState(),
        context: makeContext({ sprintStatusPath: null }),
      });

      assert.equal(result.status, 'ambiguous');
      assert.equal(result.stopReason, 'ambiguous_active_story');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips completed stories and picks the next incomplete sprint-mapped story', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-bmad-campaign-'));
    try {
      const stories = [
        '_bmad-output/planning-artifacts/epics/story-login.md',
        '_bmad-output/planning-artifacts/epics/story-profile.md',
      ];
      await createProjectFiles(
        root,
        stories,
        [
          'stories:',
          '  - id: story-login',
          '    status: completed',
          '  - id: story-profile',
          '    status: pending',
          '',
        ].join('\n'),
      );
      await recordStoryCompletion(root, {
        storyPath: stories[0],
        completedAt: new Date().toISOString(),
        mode: 'ralph',
        verificationSummary: 'ok',
      });

      const result = await resolveNextBmadStory(root, {
        index: makeIndex(root, { storyPaths: stories }),
        state: makeState(),
        context: makeContext(),
      });

      assert.equal(result.status, 'resolved');
      assert.equal(result.storyPath, stories[1]);
      assert.deepEqual(result.completedStoryPaths, [stories[0]]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns complete when no incomplete stories remain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-bmad-campaign-'));
    try {
      const story = '_bmad-output/planning-artifacts/epics/story-login.md';
      await createProjectFiles(root, [story]);
      await recordStoryCompletion(root, {
        storyPath: story,
        completedAt: new Date().toISOString(),
        mode: 'ralph',
        verificationSummary: 'ok',
      });

      const result = await resolveNextBmadStory(root, {
        index: makeIndex(root),
        state: makeState(),
        context: makeContext(),
      });

      assert.equal(result.status, 'complete');
      assert.equal(result.stopReason, 'campaign_complete');
      assert.deepEqual(result.remainingStoryPaths, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('supports explicit BMAD-native backend selection only when allowed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-bmad-campaign-'));
    try {
      const story = '_bmad-output/planning-artifacts/epics/story-login.md';
      await createProjectFiles(root, [story]);
      const result = await resolveNextBmadStory(root, {
        index: makeIndex(root),
        state: makeState(),
        context: makeContext(),
        backendSelection: {
          allowNativeExecution: true,
          nativeStoryPaths: [story],
        },
      });

      assert.equal(result.status, 'resolved');
      assert.equal(result.backend, 'bmad-native');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
