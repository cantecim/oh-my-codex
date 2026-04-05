import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { withEnv } from '../../test-support/shared-harness.js';

async function withAmbientTmuxEnv<T>(env: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
  return withEnv({
    TMUX: env.TMUX,
    TMUX_PANE: env.TMUX_PANE,
    PATH: env.PATH,
  }, run);
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
    await withEnv({ OMX_STATE_SERVER_DISABLE_AUTO_START: '1' }, async () => {
      const { handleStateToolCall } = await import('../state-server.js');

      const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-test-'));
      try {
        const stateDir = join(wd, '.omx', 'state');
        const tmuxHookConfig = join(wd, '.omx', 'tmux-hook.json');
        assert.equal(existsSync(stateDir), false);
        assert.equal(existsSync(tmuxHookConfig), false);

        const response = await handleStateToolCall({
          params: {
            name: 'state_list_active',
            arguments: { workingDirectory: wd },
          },
        });

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
  });

  it('bootstraps state-tool tmux-hook from the current tmux pane when available', async () => {
    await withEnv({ OMX_STATE_SERVER_DISABLE_AUTO_START: '1' }, async () => {
      const { handleStateToolCall } = await import('../state-server.js');

      const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-test-live-'));
      try {
        const tmuxHookConfig = join(wd, '.omx', 'tmux-hook.json');
        const fakeBin = await createFakeTmuxBin(wd);

        await withAmbientTmuxEnv(
          {
            TMUX: '/tmp/maintainer-default,123,0',
            TMUX_PANE: '%777',
            PATH: `${fakeBin}:${process.env.PATH || ''}`,
          },
          async () => {
            const response = await handleStateToolCall({
              params: {
                name: 'state_list_active',
                arguments: { workingDirectory: wd },
              },
            });
            assert.deepEqual(JSON.parse(response.content[0]?.text || '{}'), { active_modes: [] });
          },
        );

        const tmuxConfig = JSON.parse(await readFile(tmuxHookConfig, 'utf-8')) as {
          target?: { type?: string; value?: string };
        };
        assert.deepEqual(tmuxConfig.target, { type: 'pane', value: '%777' });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    });
  });

  it('writes and reads deep-interview state', async () => {
    await withEnv({ OMX_STATE_SERVER_DISABLE_AUTO_START: '1' }, async () => {
      const { handleStateToolCall } = await import('../state-server.js');

      const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-test-'));
      try {
        const writeResponse = await handleStateToolCall({
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
        });

        assert.equal(writeResponse.isError, undefined);
        assert.deepEqual(
          JSON.parse(writeResponse.content[0]?.text || '{}'),
          {
            success: true,
            mode: 'deep-interview',
            path: join(wd, '.omx', 'state', 'deep-interview-state.json'),
          },
        );

        const readResponse = await handleStateToolCall({
          params: {
            name: 'state_read',
            arguments: {
              workingDirectory: wd,
              mode: 'deep-interview',
            },
          },
        });

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
  });

  it('creates session-scoped state directory when session_id is provided', async () => {
    await withEnv({ OMX_STATE_SERVER_DISABLE_AUTO_START: '1' }, async () => {
      const { handleStateToolCall } = await import('../state-server.js');

      const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-test-'));
      try {
        const sessionDir = join(wd, '.omx', 'state', 'sessions', 'sess1');
        assert.equal(existsSync(sessionDir), false);

        const response = await handleStateToolCall({
          params: {
            name: 'state_get_status',
            arguments: { workingDirectory: wd, session_id: 'sess1' },
          },
        });

        assert.equal(existsSync(sessionDir), true);
        assert.deepEqual(
          JSON.parse(response.content[0]?.text || '{}'),
          { statuses: {} },
        );
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    });
  });

  it('serializes concurrent state_write calls per mode file and preserves merged fields', async () => {
    await withEnv({ OMX_STATE_SERVER_DISABLE_AUTO_START: '1' }, async () => {
      const { handleStateToolCall } = await import('../state-server.js');

      const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-test-'));
      try {
        const writes = Array.from({ length: 16 }, (_, i) => handleStateToolCall({
          params: {
            name: 'state_write',
            arguments: {
              workingDirectory: wd,
              mode: 'team',
              state: { [`k${i}`]: i },
            },
          },
        }));

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
  });
});
