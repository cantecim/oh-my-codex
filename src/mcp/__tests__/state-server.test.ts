import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildChildEnv } from '../../test-support/shared-harness.js';
import { buildBmadFixtureRefs, createBmadProject } from '../../test-support/bmad-fixture.js';
import { getBmadArtifactIndexPath, getBmadStatePath } from '../../state/paths.js';

async function loadStateServerModule() {
  return import(`../state-server.js?disableAutoStart=1&ts=${Date.now()}`);
}

async function createFakeTmuxBin(wd: string): Promise<string> {
  const fakeBin = join(wd, 'bin');
  await mkdir(fakeBin, { recursive: true });
  const tmuxPath = join(fakeBin, 'tmux');
  await writeFile(
    tmuxPath,
    `#!/usr/bin/env bash
set -eu
cmd="\${1:-}"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  target=""
  format=""
  while (($#)); do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  if [[ -z "$target" && "$format" == "#{pane_id}" ]]; then
    echo "%777"
    exit 0
  fi
  if [[ -z "$target" && "$format" == "#S" ]]; then
    echo "maintainer-default"
    exit 0
  fi
  if [[ "$target" == "%777" && "$format" == "#{pane_id}" ]]; then
    echo "%777"
    exit 0
  fi
  if [[ "$target" == "%777" && "$format" == "#S" ]]; then
    echo "maintainer-default"
    exit 0
  fi
fi
if [[ "$cmd" == "list-sessions" ]]; then
  echo "maintainer-default"
  exit 0
fi
exit 1
`,
  );
  await chmod(tmuxPath, 0o755);
  return fakeBin;
}

describe('state-server directory initialization', () => {
  it('creates .omx/state for state tools without setup', async () => {
    const { handleStateToolCallWithEnv } = await loadStateServerModule();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-test-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const tmuxHookConfig = join(wd, '.omx', 'tmux-hook.json');
      assert.equal(existsSync(stateDir), false);
      assert.equal(existsSync(tmuxHookConfig), false);

      const response = await handleStateToolCallWithEnv({
        params: {
          name: 'state_list_active',
          arguments: { workingDirectory: wd },
        },
      }, buildChildEnv(wd, { OMX_STATE_SERVER_DISABLE_AUTO_START: '1' }));

      assert.equal(existsSync(stateDir), true);
      assert.equal(existsSync(tmuxHookConfig), true);
      assert.deepEqual(
        JSON.parse(response.content[0]?.text || '{}'),
        { active_modes: [] },
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('bootstraps state-tool tmux-hook from the current tmux pane when available', async () => {
    const { handleStateToolCallWithEnv } = await loadStateServerModule();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-test-live-'));
    try {
      const tmuxHookConfig = join(wd, '.omx', 'tmux-hook.json');
      const fakeBin = await createFakeTmuxBin(wd);

      const response = await handleStateToolCallWithEnv({
        params: {
          name: 'state_list_active',
          arguments: { workingDirectory: wd },
        },
      }, buildChildEnv(wd, {
        OMX_STATE_SERVER_DISABLE_AUTO_START: '1',
        TMUX: '/tmp/maintainer-default,123,0',
        TMUX_PANE: '%777',
        PATH: `${fakeBin}:${process.env.PATH || ''}`,
      }));
      assert.deepEqual(JSON.parse(response.content[0]?.text || '{}'), { active_modes: [] });

      const tmuxConfig = JSON.parse(await readFile(tmuxHookConfig, 'utf-8')) as {
        target?: { type?: string; value?: string };
      };
      assert.deepEqual(tmuxConfig.target, { type: 'pane', value: '%777' });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('writes and reads deep-interview state', async () => {
    const { handleStateToolCallWithEnv } = await loadStateServerModule();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-test-'));
    try {
      const testEnv = buildChildEnv(wd, { OMX_STATE_SERVER_DISABLE_AUTO_START: '1' });
      const writeResponse = await handleStateToolCallWithEnv({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'deep-interview',
            active: true,
            current_phase: 'deep-interview',
            state: {
              current_focus: 'intent',
              threshold: 0.2,
            },
          },
        },
      }, testEnv);

      assert.equal(writeResponse.isError, undefined);
      assert.deepEqual(
        JSON.parse(writeResponse.content[0]?.text || '{}'),
        {
          success: true,
          mode: 'deep-interview',
          path: join(wd, '.omx', 'state', 'deep-interview-state.json'),
        },
      );

      const readResponse = await handleStateToolCallWithEnv({
        params: {
          name: 'state_read',
          arguments: {
            workingDirectory: wd,
            mode: 'deep-interview',
          },
        },
      }, testEnv);

      assert.equal(readResponse.isError, undefined);
      const readBody = JSON.parse(readResponse.content[0]?.text || '{}') as Record<string, unknown>;
      assert.equal(readBody.active, true);
      assert.equal(readBody.current_phase, 'deep-interview');
      assert.equal(readBody.current_focus, 'intent');
      assert.equal(readBody.threshold, 0.2);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('creates session-scoped state directory when session_id is provided', async () => {
    const { handleStateToolCallWithEnv } = await loadStateServerModule();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-test-'));
    try {
      const sessionDir = join(wd, '.omx', 'state', 'sessions', 'sess1');
      assert.equal(existsSync(sessionDir), false);

      const response = await handleStateToolCallWithEnv({
        params: {
          name: 'state_get_status',
          arguments: { workingDirectory: wd, session_id: 'sess1' },
        },
      }, buildChildEnv(wd, { OMX_STATE_SERVER_DISABLE_AUTO_START: '1' }));

      assert.equal(existsSync(sessionDir), true);
      assert.deepEqual(
        JSON.parse(response.content[0]?.text || '{}'),
        { statuses: {} },
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('serializes concurrent state_write calls per mode file and preserves merged fields', async () => {
    const { handleStateToolCallWithEnv } = await loadStateServerModule();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-test-'));
    try {
      const testEnv = buildChildEnv(wd, { OMX_STATE_SERVER_DISABLE_AUTO_START: '1' });
      const writes = Array.from({ length: 16 }, (_, i) => handleStateToolCallWithEnv({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'team',
            state: { [`k${i}`]: i },
          },
        },
      }, testEnv));

      const responses = await Promise.all(writes);
      for (const response of responses) {
        assert.equal(response.isError, undefined);
      }

      const filePath = join(wd, '.omx', 'state', 'team-state.json');
      const state = JSON.parse(await readFile(filePath, 'utf-8')) as Record<string, unknown>;
      for (let i = 0; i < 16; i++) {
        assert.equal(state[`k${i}`], i);
      }
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('reconciles canonical BMAD state before BMAD-aware autopilot state writes', async () => {
    const { handleStateToolCallWithEnv } = await loadStateServerModule();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-bmad-'));
    try {
      const refs = buildBmadFixtureRefs('docs');
      await createBmadProject(wd, { outputRoot: 'docs' });
      const testEnv = buildChildEnv(wd, { OMX_STATE_SERVER_DISABLE_AUTO_START: '1' });

      const response = await handleStateToolCallWithEnv({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'autopilot',
            active: true,
            current_phase: 'bmad-campaign',
            state: {
              bmad_detected: true,
              bmad_ready_for_execution: false,
              bmad_active_story_path: refs.storyPath,
              bmad_active_epic_path: refs.epicPath,
              bmad_context_blocked_by_ambiguity: true,
            },
          },
        },
      }, testEnv);

      assert.equal(response.isError, undefined);

      const canonicalState = JSON.parse(await readFile(getBmadStatePath(wd), 'utf-8')) as {
        phase?: string;
        activeStoryRef?: string | null;
        activeEpicRef?: string | null;
      };
      const artifactIndex = JSON.parse(await readFile(getBmadArtifactIndexPath(wd), 'utf-8')) as {
        outputRoot?: string | null;
      };
      const autopilotState = JSON.parse(await readFile(join(wd, '.omx', 'state', 'autopilot-state.json'), 'utf-8')) as {
        bmad_detected?: boolean;
        bmad_phase?: string;
        bmad_ready_for_execution?: boolean;
        bmad_active_story_path?: string | null;
        bmad_active_epic_path?: string | null;
        bmad_context_blocked_by_ambiguity?: boolean;
      };

      assert.equal(canonicalState.phase, 'implementation');
      assert.equal(canonicalState.activeStoryRef, refs.storyPath);
      assert.equal(canonicalState.activeEpicRef, refs.epicPath);
      assert.equal(artifactIndex.outputRoot, 'docs');
      assert.equal(autopilotState.bmad_detected, true);
      assert.equal(autopilotState.bmad_phase, canonicalState.phase);
      assert.equal(autopilotState.bmad_ready_for_execution, true);
      assert.equal(autopilotState.bmad_active_story_path, canonicalState.activeStoryRef);
      assert.equal(autopilotState.bmad_active_epic_path, canonicalState.activeEpicRef);
      assert.equal(autopilotState.bmad_context_blocked_by_ambiguity, false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('reconciles canonical BMAD state before BMAD-aware Ralph state writes', async () => {
    const { handleStateToolCallWithEnv } = await loadStateServerModule();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-bmad-'));
    try {
      const refs = buildBmadFixtureRefs();
      await createBmadProject(wd);
      const testEnv = buildChildEnv(wd, { OMX_STATE_SERVER_DISABLE_AUTO_START: '1' });

      const response = await handleStateToolCallWithEnv({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'ralph',
            active: true,
            current_phase: 'executing',
            state: {
              bmad_detected: true,
              bmad_story_path: refs.storyPath,
              bmad_epic_path: refs.epicPath,
              bmad_sprint_status_path: refs.sprintStatusPath,
              bmad_acceptance_criteria: [],
              bmad_writeback_supported: false,
              bmad_writeback_blocked: true,
              bmad_implementation_artifacts_root: refs.implementationArtifactsRoot,
            },
          },
        },
      }, testEnv);

      assert.equal(response.isError, undefined);

      const canonicalState = JSON.parse(await readFile(getBmadStatePath(wd), 'utf-8')) as {
        phase?: string;
        activeStoryRef?: string | null;
        activeEpicRef?: string | null;
      };
      const artifactIndex = JSON.parse(await readFile(getBmadArtifactIndexPath(wd), 'utf-8')) as {
        outputRoot?: string | null;
      };
      const ralphState = JSON.parse(await readFile(join(wd, '.omx', 'state', 'ralph-state.json'), 'utf-8')) as {
        bmad_detected?: boolean;
        bmad_phase?: string;
        bmad_story_path?: string | null;
        bmad_epic_path?: string | null;
        bmad_sprint_status_path?: string | null;
        bmad_acceptance_criteria?: string[];
        bmad_writeback_supported?: boolean;
        bmad_writeback_blocked?: boolean;
        bmad_implementation_artifacts_root?: string | null;
      };

      assert.equal(canonicalState.phase, 'implementation');
      assert.equal(canonicalState.activeStoryRef, refs.storyPath);
      assert.equal(canonicalState.activeEpicRef, refs.epicPath);
      assert.equal(artifactIndex.outputRoot, refs.outputRoot);
      assert.equal(ralphState.bmad_detected, true);
      assert.equal(ralphState.bmad_phase, canonicalState.phase);
      assert.equal(ralphState.bmad_story_path, canonicalState.activeStoryRef);
      assert.equal(ralphState.bmad_epic_path, canonicalState.activeEpicRef);
      assert.equal(ralphState.bmad_sprint_status_path, refs.sprintStatusPath);
      assert.deepEqual(ralphState.bmad_acceptance_criteria, []);
      assert.equal(ralphState.bmad_writeback_supported, true);
      assert.equal(ralphState.bmad_writeback_blocked, false);
      assert.equal(ralphState.bmad_implementation_artifacts_root, refs.implementationArtifactsRoot);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
