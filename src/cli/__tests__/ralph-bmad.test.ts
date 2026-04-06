import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRalphAppendInstructions } from '../ralph.js';
import type { BmadExecutionContext } from '../../integrations/bmad/contracts.js';

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
});
