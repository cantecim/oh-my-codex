import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildRalphAppendInstructions } from '../ralph.js';
import { ralphCommand } from '../ralph.js';
import type { BmadExecutionContext } from '../../integrations/bmad/contracts.js';
import { getBmadArtifactIndexPath, getBmadStatePath } from '../../state/paths.js';

const outputRoot = '_bmad-output';

const bmadContext: BmadExecutionContext = {
  detected: true,
  outputRoot,
  projectContextPath: `${outputRoot}/project-context.md`,
  architecturePaths: [`${outputRoot}/planning-artifacts/architecture.md`],
  activeStoryPath: `${outputRoot}/planning-artifacts/epics/story-login.md`,
  activeEpicPath: `${outputRoot}/planning-artifacts/epics/epic-auth.md`,
  storyAcceptanceCriteria: ['user can log in', 'errors are shown'],
  sprintStatusPath: `${outputRoot}/implementation-artifacts/sprint-status.yaml`,
  implementationArtifactsRoot: `${outputRoot}/implementation-artifacts`,
  contextBlockedByAmbiguity: false,
  writebackSupported: true,
  writebackBlockedByDrift: false,
};

describe('ralph BMAD contract', () => {
  it('includes BMAD story context and bounded writeback guidance when available', () => {
    const instructions = buildRalphAppendInstructions('Implement BMAD story', {
      changedFilesPath: '.omx/ralph/changed-files.txt',
      noDeslop: false,
      approvedHint: null,
      bmadContext,
    });
    assert.match(instructions, /BMAD execution context/i);
    assert.match(instructions, /active story: _bmad-output\/planning-artifacts\/epics\/story-login\.md/i);
    assert.match(instructions, /Acceptance criteria: user can log in \| errors are shown/i);
    assert.match(instructions, /bounded BMAD writeback/i);
    assert.match(instructions, /Do not modify PRD, UX, architecture, or project-context/i);
  });

  it('writes canonical BMAD integration state during a BMAD-aware ralph launch', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralph-bmad-'));
    const previousSkipHudLaunch = process.env.OMX_TEST_SKIP_HUD_LAUNCH;
    try {
      await mkdir(join(cwd, outputRoot, 'planning-artifacts', 'epics'), { recursive: true });
      await mkdir(join(cwd, outputRoot, 'implementation-artifacts'), { recursive: true });
      await writeFile(join(cwd, outputRoot, 'planning-artifacts', 'PRD.md'), '# PRD\n');
      await writeFile(join(cwd, outputRoot, 'planning-artifacts', 'architecture.md'), '# Architecture\n');
      await writeFile(join(cwd, outputRoot, 'planning-artifacts', 'epics', 'story-login.md'), '# Story\n');
      await writeFile(join(cwd, outputRoot, 'implementation-artifacts', 'sprint-status.yaml'), 'stories:\n');

      mock.method(process, 'cwd', () => cwd);
      process.env.OMX_TEST_SKIP_HUD_LAUNCH = '1';

      await ralphCommand(['Implement BMAD story']);

      const canonicalState = JSON.parse(await readFile(getBmadStatePath(cwd), 'utf-8')) as {
        phase?: string;
        activeStoryRef?: string | null;
      };
      const artifactIndex = JSON.parse(await readFile(getBmadArtifactIndexPath(cwd), 'utf-8')) as {
        outputRoot?: string | null;
      };
      const ralphState = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'ralph-state.json'), 'utf-8')) as {
        bmad_phase?: string;
        bmad_story_path?: string | null;
      };

      assert.equal(canonicalState.phase, 'implementation');
      assert.equal(canonicalState.activeStoryRef, `${outputRoot}/planning-artifacts/epics/story-login.md`);
      assert.equal(artifactIndex.outputRoot, outputRoot);
      assert.equal(ralphState.bmad_phase, canonicalState.phase);
      assert.equal(ralphState.bmad_story_path, canonicalState.activeStoryRef);
    } finally {
      if (typeof previousSkipHudLaunch === 'string') {
        process.env.OMX_TEST_SKIP_HUD_LAUNCH = previousSkipHudLaunch;
      } else {
        delete process.env.OMX_TEST_SKIP_HUD_LAUNCH;
      }
      mock.restoreAll();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
