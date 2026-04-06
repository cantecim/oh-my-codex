import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readModeState } from '../../modes/base.js';
import { runRalplanConsensus } from '../runtime.js';

describe('ralplan runtime BMAD contract', () => {
  it('annotates ralplan state with BMAD readiness metadata when BMAD artifacts exist', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-bmad-'));
    const sessionId = 'sess-ralplan-bmad';
    try {
      await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'state', 'session.json'), JSON.stringify({ session_id: sessionId }));
      await mkdir(join(cwd, '_bmad-output', 'planning-artifacts', 'epics'), { recursive: true });
      await mkdir(join(cwd, '_bmad-output', 'implementation-artifacts'), { recursive: true });
      await writeFile(join(cwd, '_bmad-output', 'planning-artifacts', 'PRD.md'), '# PRD\n');
      await writeFile(join(cwd, '_bmad-output', 'planning-artifacts', 'architecture.md'), '# Architecture\n');
      await writeFile(join(cwd, '_bmad-output', 'planning-artifacts', 'epics', 'story-login.md'), '# Story\n');
      await writeFile(join(cwd, '_bmad-output', 'implementation-artifacts', 'sprint-status.yaml'), 'stories:\n');

      const result = await runRalplanConsensus({
        async draft() {
          const plansDir = join(cwd, '.omx', 'plans');
          await mkdir(plansDir, { recursive: true });
          const prdPath = join(plansDir, 'prd-bmad.md');
          await writeFile(prdPath, '# plan\n');
          await writeFile(join(plansDir, 'test-spec-bmad.md'), '# tests\n');
          return { summary: 'draft', planPath: prdPath };
        },
        async architectReview() {
          return { verdict: 'approve', summary: 'architect-ok' };
        },
        async criticReview() {
          return { verdict: 'approve', summary: 'critic-ok' };
        },
      }, { task: 'execute BMAD story', cwd });

      assert.equal(result.status, 'completed');
      const finalState = await readModeState('ralplan', cwd);
      assert.equal(finalState?.bmad_detected, true);
      assert.equal(finalState?.bmad_ready_for_execution, true);
      assert.equal(finalState?.bmad_active_story_path, '_bmad-output/planning-artifacts/epics/story-login.md');
      const bmadArtifacts = (result.artifacts as { bmad?: { readiness?: { gapSummary?: string[] } } }).bmad;
      assert.equal(Array.isArray(bmadArtifacts?.readiness?.gapSummary ?? []), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
