import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAutopilotSkillRuntimeBridge } from '../autopilot-runtime-bridge.js';
import { recordStoryCompletion } from '../../integrations/bmad/writeback.js';
import { buildBmadFixtureRefs, createBmadProject } from '../../test-support/bmad-fixture.js';
import { persistBmadActiveSelection, reconcileBmadIntegrationState } from '../../integrations/bmad/reconcile.js';

describe('autopilot skill/runtime bridge', () => {
  it('uses the generic autopilot pipeline on non-BMAD repositories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-autopilot-bridge-'));
    try {
      const result = await runAutopilotSkillRuntimeBridge({
        task: 'build feature x',
        cwd: root,
      });

      assert.equal(result.status, 'completed');
      assert.deepEqual(Object.keys(result.stageResults), ['ralplan', 'team-exec', 'ralph-verify']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns planning-required state and recommendation for incomplete BMAD repos', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-autopilot-bridge-'));
    try {
      await createBmadProject(root, { includeArchitecture: false });

      const result = await runAutopilotSkillRuntimeBridge({
        task: 'continue BMAD implementation',
        cwd: root,
      });

      assert.equal(result.status, 'failed');
      assert.equal('recommendation' in result ? result.recommendation : undefined, 'create-architecture');

      const rawState = JSON.parse(await readFile(join(root, '.omx', 'state', 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(rawState.active, false);
      assert.equal(rawState.current_phase, 'planning-required');
      assert.equal(rawState.bmad_detected, true);
      assert.equal(rawState.bmad_recommendation, 'create-architecture');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('enters BMAD campaign mode on execution-ready repositories through the bridge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-autopilot-bridge-'));
    try {
      const refs = buildBmadFixtureRefs();
      const storyPath = refs.storyPath;
      await createBmadProject(root);

      const result = await runAutopilotSkillRuntimeBridge({
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
      assert.equal('kind' in result ? result.kind : undefined, 'bmad-campaign');
      assert.deepEqual('completedStoryPaths' in result ? result.completedStoryPaths : [], [storyPath]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const outputRoot of ['_bmad-output', 'docs']) {
    it(`uses the configured BMAD output_folder for campaign execution and writeback artifacts (${outputRoot})`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'omx-autopilot-bridge-'));
      try {
        const refs = buildBmadFixtureRefs(outputRoot);
        const storyPath = refs.storyPath;
        await createBmadProject(root, { outputRoot });

        const result = await runAutopilotSkillRuntimeBridge({
          task: `ship the configured ${outputRoot} BMAD story`,
          cwd: root,
          executors: {
            async ralph({ cwd, storyPath: selectedStory }) {
              const hookPath = join(cwd, outputRoot, 'implementation-artifacts', 'omx-story-hook-story-login.md');
              await recordStoryCompletion(cwd, {
                storyPath: selectedStory,
                completedAt: new Date().toISOString(),
                mode: 'ralph',
                verificationSummary: 'verified',
                implementationArtifactPaths: [`${outputRoot}/implementation-artifacts/omx-story-hook-story-login.md`],
              });
              await writeFile(hookPath, '# OMX Implementation Summary\n');
              return { status: 'completed' };
            },
          },
        });

        assert.equal(result.status, 'completed');
        assert.deepEqual('completedStoryPaths' in result ? result.completedStoryPaths : [], [storyPath]);
        const hookContent = await readFile(join(root, outputRoot, 'implementation-artifacts', 'omx-story-hook-story-login.md'), 'utf-8');
        assert.match(hookContent, /# OMX Implementation Summary/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  it('stops on ambiguous BMAD story resolution without guessing through the bridge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-autopilot-bridge-'));
    try {
      const refs = buildBmadFixtureRefs();
      const stories = [
        refs.storyPath,
        `${refs.outputRoot}/planning-artifacts/epics/story-profile.md`,
      ];
      await createBmadProject(root, { stories: stories.map((path) => ({ path })) });
      await reconcileBmadIntegrationState(root);
      await persistBmadActiveSelection(root, {
        activeStoryRef: stories[0],
        activeEpicRef: refs.epicPath,
      });

      const result = await runAutopilotSkillRuntimeBridge({
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
            await writeFile(join(cwd, refs.outputRoot, 'planning-artifacts', 'epics', 'story-security.md'), '# Story\n');
            return { status: 'completed' };
          },
        },
      });

      assert.equal(result.status, 'failed');
      assert.equal('stopReason' in result ? result.stopReason : undefined, 'ambiguous_active_story');

      const rawState = JSON.parse(await readFile(join(root, '.omx', 'state', 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(rawState.current_phase, 'blocked');
      assert.equal(rawState.bmad_context_blocked_by_ambiguity, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stops in a degraded blocked state when hard BMAD drift occurs through the bridge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-autopilot-bridge-'));
    try {
      const refs = buildBmadFixtureRefs();
      const storyPath = refs.storyPath;
      await createBmadProject(root);

      const result = await runAutopilotSkillRuntimeBridge({
        task: 'ship the current BMAD story',
        cwd: root,
        executors: {
          async ralph({ cwd }) {
            await rm(join(cwd, refs.outputRoot), { recursive: true, force: true });
            return { status: 'completed' };
          },
        },
      });

      assert.equal(result.status, 'failed');
      assert.equal('stopReason' in result ? result.stopReason : undefined, 'writeback_blocked');

      const rawState = JSON.parse(await readFile(join(root, '.omx', 'state', 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(rawState.current_phase, 'blocked');
      assert.equal(rawState.bmad_stop_reason, 'writeback_blocked');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
