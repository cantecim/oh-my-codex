import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBmadProject } from '../../../test-support/bmad-fixture.js';
import { buildBmadArtifactIndex } from '../discovery.js';
import { deriveBmadProjection } from '../projection.js';
import { deriveBmadReadiness } from '../readiness.js';
import { resolveBmadExecutionContext } from '../context.js';
import { resolveNextBmadStory } from '../campaign.js';
import { recordImplementationArtifactSummary, recordStoryCompletion } from '../writeback.js';

for (const outputRoot of ['_bmad-output', 'docs']) {
  describe(`BMAD real-drive validation (${outputRoot})`, () => {
    it('resolves planning and implementation artifacts as the BMAD source of truth', async () => {
      const root = await mkdtemp(join(tmpdir(), 'omx-bmad-real-drive-'));
      try {
        const analyticsStory = `${outputRoot}/planning-artifacts/epics/3-5-instrument-wizard-progression-and-abandonment-events.md`;
        const completedStory = `${outputRoot}/planning-artifacts/epics/3-2-implement-progressive-personalization-steps.md`;
        const epicPath = `${outputRoot}/planning-artifacts/epics/epic-growth.md`;
        const sprintStatusPath = `${outputRoot}/implementation-artifacts/sprint-status.yaml`;

        await createBmadProject(root, {
          outputRoot,
          epicPath,
          stories: [
            {
              path: completedStory,
              content: '# Story\n\n## Acceptance Criteria\n- personalization steps persist\n',
            },
            {
              path: analyticsStory,
              content: '# Story\n\n## Acceptance Criteria\n- wizard progression tracked\n- abandonment tracked\n',
            },
          ],
          sprintStatus: [
            'stories:',
            '  - id: 3-2-implement-progressive-personalization-steps',
            '    status: completed',
            '  - id: 3-5-instrument-wizard-progression-and-abandonment-events',
            '    status: ready-for-dev',
            '',
          ].join('\n'),
          projectContextContents: '# Project Context\n\nKidooverse website BMAD context.\n',
        });
        await recordStoryCompletion(root, {
          storyPath: completedStory,
          completedAt: '2026-04-06T00:00:00.000Z',
          mode: 'ralph',
          verificationSummary: 'verified',
        });

        const index = await buildBmadArtifactIndex(root);
        assert.equal(index.outputRoot, outputRoot);
        assert.equal(index.projectContextPath, `${outputRoot}/project-context.md`);
        assert.deepEqual(index.sprintStatusPaths, [sprintStatusPath]);

        const projection = deriveBmadProjection(index);
        assert.equal(projection.phase, 'implementation');

        const blockedReadiness = deriveBmadReadiness(index, projection);
        assert.equal(blockedReadiness.readyForExecution, false);
        assert.ok(blockedReadiness.gaps.includes('ambiguous_active_story'));

        const selectedState = {
          ...projection,
          activeEpicRef: epicPath,
          activeStoryRef: analyticsStory,
        };
        const readiness = deriveBmadReadiness(index, selectedState);
        assert.equal(readiness.readyForExecution, true);

        const context = await resolveBmadExecutionContext(root, index, selectedState);
        assert.equal(context.projectContextPath, `${outputRoot}/project-context.md`);
        assert.equal(context.implementationArtifactsRoot, `${outputRoot}/implementation-artifacts`);
        assert.equal(context.sprintStatusPath, sprintStatusPath);
        assert.equal(context.contextBlockedByAmbiguity, false);

        const nextStory = await resolveNextBmadStory(root, {
          index,
          state: selectedState,
          context,
        });

        assert.equal(nextStory.status, 'resolved');
        assert.equal(nextStory.storyPath, analyticsStory);
        assert.deepEqual(nextStory.completedStoryPaths, [completedStory]);
        assert.ok(nextStory.remainingStoryPaths.includes(analyticsStory));

        const writeback = await recordImplementationArtifactSummary(root, {
          implementationArtifactsRoot: context.implementationArtifactsRoot,
          storyPath: nextStory.storyPath,
          epicPath,
          verificationSummary: 'artifact truth verified',
          kind: 'verification',
        });

        assert.equal(writeback.status, 'applied');
        assert.equal(writeback.path, `${outputRoot}/implementation-artifacts/omx-verification-3-5-instrument-wizard-progression-and-abandonment-events.md`);
        const artifactContent = await readFile(join(root, writeback.path!), 'utf-8');
        assert.match(
          artifactContent,
          new RegExp(`Story: ${outputRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/planning-artifacts/epics/3-5-instrument-wizard-progression-and-abandonment-events\\.md`),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
}
