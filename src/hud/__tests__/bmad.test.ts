import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderHud } from '../render.js';
import { readAutopilotState } from '../state.js';
import type { HudRenderContext } from '../types.js';

function emptyCtx(): HudRenderContext {
  return {
    version: null,
    gitBranch: null,
    ralph: null,
    ultrawork: null,
    autopilot: null,
    ralplan: null,
    deepInterview: null,
    autoresearch: null,
    ultraqa: null,
    team: null,
    metrics: null,
    hudNotify: null,
    session: null,
  };
}

async function writeModeState(cwd: string, mode: string, state: unknown): Promise<void> {
  const stateDir = join(cwd, '.omx', 'state');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, `${mode}-state.json`), JSON.stringify(state));
}

describe.skip('HUD BMAD contract', () => {
  it('renders BMAD campaign autopilot with the active story slug', () => {
    const ctx = {
      ...emptyCtx(),
      autopilot: {
        active: true,
        current_phase: 'bmad-campaign',
        bmad_detected: true,
        bmad_active_story_path: '_bmad-output/planning-artifacts/epics/story-login.md',
      },
    };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes('autopilot:bmad-campaign:story-login'));
  });

  it('renders blocked BMAD autopilot state with ambiguity suffix', () => {
    const ctx = {
      ...emptyCtx(),
      autopilot: {
        active: false,
        current_phase: 'blocked',
        bmad_detected: true,
        bmad_context_blocked_by_ambiguity: true,
      },
    };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes('autopilot:blocked:ambig'));
  });

  it('renders blocked BMAD autopilot state with drift suffix when writeback is blocked', () => {
    const ctx = {
      ...emptyCtx(),
      autopilot: {
        active: false,
        current_phase: 'blocked',
        bmad_detected: true,
        bmad_writeback_blocked: true,
      },
    };
    const result = renderHud(ctx, 'focused');
    assert.ok(result.includes('autopilot:blocked:drift'));
  });

  it('surfaces inactive planning-required autopilot BMAD state for HUD visibility', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hud-autopilot-bmad-'));
    try {
      await writeModeState(cwd, 'autopilot', {
        active: false,
        current_phase: 'planning-required',
        bmad_detected: true,
        bmad_recommendation: 'create-architecture',
      });

      const state = await readAutopilotState(cwd);
      assert.deepEqual(state, {
        active: false,
        current_phase: 'planning-required',
        bmad_detected: true,
        bmad_recommendation: 'create-architecture',
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('hides inactive non-BMAD autopilot terminal state from HUD', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hud-autopilot-inactive-'));
    try {
      await writeModeState(cwd, 'autopilot', {
        active: false,
        current_phase: 'complete',
      });

      assert.equal(await readAutopilotState(cwd), null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
