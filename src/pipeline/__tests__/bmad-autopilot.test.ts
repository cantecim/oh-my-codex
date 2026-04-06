import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordStoryCompletion } from '../../integrations/bmad/writeback.js';
import { buildBmadFixtureRefs, createBmadProject } from '../../test-support/bmad-fixture.js';
import {
  persistBmadActiveSelection,
  readPersistedBmadIntegrationState,
  reconcileBmadIntegrationState,
} from '../../integrations/bmad/reconcile.js';
import { runAutopilotWithRouting, runBmadAutopilotCampaign } from '../bmad-autopilot.js';
import type { PipelineStage } from '../types.js';

describe('BMAD autopilot routing', () => {
  it('preserves the generic autopilot pipeline path for non-BMAD repos', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-bmad-autopilot-'));
    try {
      let ran = false;
      const stages: PipelineStage[] = [{
        name: 'generic',
        async run() {
          ran = true;
          return {
            status: 'completed',
            artifacts: { ok: true },
            duration_ms: 0,
          };
        },
      }];

      const result = await runAutopilotWithRouting({
        task: 'plain repo task',
        cwd: root,
        stages,
      });

      assert.equal(ran, true);
      assert.equal(result.status, 'completed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns a planning recommendation for BMAD repos that are not execution-ready', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-bmad-autopilot-'));
    try {
      await createBmadProject(root, { includeArchitecture: false });
      const result = await runBmadAutopilotCampaign({
        task: 'implement the next BMAD story',
        cwd: root,
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.stopReason, 'planning_required');
      assert.equal(result.recommendation, 'create-architecture');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('BMAD autopilot campaign loop', () => {
  it('completes a single-story BMAD campaign through the Ralph backend', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-bmad-autopilot-'));
    try {
      const refs = buildBmadFixtureRefs();
      const storyPath = refs.storyPath;
      await createBmadProject(root);

      const result = await runBmadAutopilotCampaign({
        task: 'ship the current BMAD story',
        cwd: root,
        executors: {
          async ralph({ cwd, storyPath: selectedStory }) {
            const state = await readPersistedBmadIntegrationState(cwd);
            assert.equal(state?.activeStoryRef, selectedStory);
            await recordStoryCompletion(cwd, {
              storyPath: selectedStory,
              completedAt: new Date().toISOString(),
              mode: 'ralph',
              verificationSummary: 'verified',
            });
            return { status: 'completed' };
          },
        },
      });

      assert.equal(result.status, 'completed');
      assert.equal(result.stopReason, 'campaign_complete');
      assert.deepEqual(result.completedStoryPaths, [storyPath]);
      assert.deepEqual(result.remainingStoryPaths, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stops with ambiguity after one completed story when multiple unresolved stories remain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-bmad-autopilot-'));
    try {
      const refs = buildBmadFixtureRefs();
      const stories = [
        refs.storyPath,
        `${refs.outputRoot}/planning-artifacts/epics/story-profile.md`,
      ];
      await createBmadProject(root, { stories: stories.map((path) => ({ path })), sprintStatus: 'stories:\n' });
      await reconcileBmadIntegrationState(root);
      await persistBmadActiveSelection(root, {
        activeStoryRef: stories[0],
        activeEpicRef: refs.epicPath,
      });

      const result = await runBmadAutopilotCampaign({
        task: 'continue BMAD implementation',
        cwd: root,
        executors: {
          async ralph({ cwd, storyPath: selectedStory }) {
            await recordStoryCompletion(cwd, {
              storyPath: selectedStory,
              completedAt: new Date().toISOString(),
              mode: 'ralph',
              verificationSummary: 'verified',
            });
            if (selectedStory === stories[0]) {
              const extraStory = `${refs.outputRoot}/planning-artifacts/epics/story-security.md`;
              await writeFile(join(cwd, extraStory), '# Story\n');
            }
            return { status: 'completed' };
          },
        },
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.stopReason, 'ambiguous_active_story');
      assert.deepEqual(result.completedStoryPaths, [stories[0]]);
      assert.equal(result.remainingStoryPaths.length, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('supports explicit team backend selection through injected executors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-bmad-autopilot-'));
    try {
      const refs = buildBmadFixtureRefs();
      const storyPath = refs.storyPath;
      await createBmadProject(root);
      let teamInvoked = false;

      const result = await runBmadAutopilotCampaign({
        task: 'ship the current BMAD story',
        cwd: root,
        backendSelection: { teamStoryPaths: [storyPath] },
        executors: {
          async team({ cwd, storyPath: selectedStory }) {
            teamInvoked = true;
            await recordStoryCompletion(cwd, {
              storyPath: selectedStory,
              completedAt: new Date().toISOString(),
              mode: 'team',
              verificationSummary: 'verified',
            });
            return { status: 'completed' };
          },
        },
      });

      assert.equal(teamInvoked, true);
      assert.equal(result.status, 'completed');
      assert.equal(result.stopReason, 'campaign_complete');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const outputRoot of ['_bmad-output', 'docs']) {
    it(`completes a configured-root BMAD campaign through the Ralph backend (${outputRoot})`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'omx-bmad-autopilot-'));
      try {
        const refs = buildBmadFixtureRefs(outputRoot);
        const storyPath = refs.storyPath;
        await createBmadProject(root, { outputRoot: refs.outputRoot });

        const result = await runBmadAutopilotCampaign({
          task: `ship the ${outputRoot} BMAD story`,
          cwd: root,
          executors: {
            async ralph({ cwd, storyPath: selectedStory }) {
              await recordStoryCompletion(cwd, {
                storyPath: selectedStory,
                completedAt: new Date().toISOString(),
                mode: 'ralph',
                verificationSummary: 'verified',
              });
              return { status: 'completed' };
            },
          },
        });

        assert.equal(result.status, 'completed');
        assert.deepEqual(result.completedStoryPaths, [storyPath]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  it('supports explicit BMAD-native backend selection through the compatibility executor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-bmad-autopilot-'));
    try {
      const refs = buildBmadFixtureRefs();
      const storyPath = refs.storyPath;
      await createBmadProject(root);
      let nativeInvoked = false;

      const result = await runBmadAutopilotCampaign({
        task: 'ship the current BMAD story',
        cwd: root,
        backendSelection: {
          allowNativeExecution: true,
          nativeStoryPaths: [storyPath],
        },
        executors: {
          async native(request) {
            nativeInvoked = true;
            await recordStoryCompletion(request.cwd, {
              storyPath: request.handoff.storyPath,
              completedAt: new Date().toISOString(),
              mode: 'bmad-native',
              verificationSummary: 'verified natively',
            });
            return { status: 'completed', backend: 'bmad-native' };
          },
        },
      });

      assert.equal(nativeInvoked, true);
      assert.equal(result.status, 'completed');
      const stage = result.stageResults['bmad-story-1'];
      assert.equal((stage?.artifacts as Record<string, unknown>)?.backend, 'bmad-native');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes an epic retrospective hook when the epic is fully complete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-bmad-autopilot-'));
    try {
      const refs = buildBmadFixtureRefs();
      const epicPath = refs.epicPath;
      const storyPath = `${refs.outputRoot}/planning-artifacts/epics/story-epic-auth-login.md`;
      await createBmadProject(root, { stories: [{ path: storyPath }] });
      await writeFile(join(root, epicPath), '# Epic\n');

      const result = await runBmadAutopilotCampaign({
        task: 'ship the current BMAD story',
        cwd: root,
        executors: {
          async ralph({ cwd, storyPath: selectedStory }) {
            await recordStoryCompletion(cwd, {
              storyPath: selectedStory,
              completedAt: new Date().toISOString(),
              mode: 'ralph',
              verificationSummary: 'verified',
            });
            return { status: 'completed' };
          },
        },
      });

      assert.equal(result.status, 'completed');
      const hookPath = (result.artifacts.bmadCampaign as { hook_artifact_paths?: string[] }).hook_artifact_paths?.[0];
      assert.ok(hookPath);
      const content = await readFile(join(root, hookPath!), 'utf-8');
      assert.match(content, /Epic completed through ralph/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
