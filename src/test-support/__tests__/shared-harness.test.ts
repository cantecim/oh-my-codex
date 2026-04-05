import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_FORWARDED_TEST_ENV_KEYS,
  EXPLICIT_RUNTIME_ENV_KEYS,
  RESET_BY_DEFAULT_RUNTIME_ENV_KEYS,
  buildChildEnv,
  buildDebugChildEnv,
  buildFakeTmuxScript,
  buildIsolatedEnv,
} from '../shared-harness.js';

describe('shared harness isolation contract', () => {
  it('auto-forwards only the approved OMX_TEST whitelist', () => {
    const env = buildIsolatedEnv({}, {
      PATH: '/usr/bin',
      OMX_TEST_DEBUG: '1',
      OMX_TEST_ARTIFACTS_DIR: '/tmp/artifacts',
      OMX_TEST_DEBUG_TEST_ID: 'fixture-test-id',
      OMX_TEST_TRACE_ID: 'trace-123',
      OMX_TEST_CAPTURE_FILE: '/tmp/capture.txt',
      OMX_TEST_CAPTURE_SEQUENCE_FILE: '/tmp/capture-seq.txt',
      OMX_TEST_CAPTURE_COUNTER_FILE: '/tmp/capture-seq.idx',
      OMX_TEST_REPO_ROOT: '/tmp/repo-root',
      OMX_TEST_NOT_WHITELISTED: 'should-not-flow',
    });

    for (const key of AUTO_FORWARDED_TEST_ENV_KEYS) {
      assert.equal(typeof env[key], 'string', `${key} should auto-forward`);
    }
    assert.equal(env.OMX_TEST_NOT_WHITELISTED, undefined);
  });

  it('resets runtime-affecting env by default unless explicitly overridden', () => {
    const env = buildIsolatedEnv({}, {
      PATH: '/usr/bin',
      TMUX: 'leader,123,0',
      TMUX_PANE: '%42',
      OMX_TEAM_WORKER: 'alpha/worker-1',
      OMX_TEAM_STATE_ROOT: '/tmp/state',
      OMX_TEAM_LEADER_CWD: '/tmp/cwd',
      OMX_MODEL_INSTRUCTIONS_FILE: '/tmp/instructions.md',
      OMX_RUNTIME_BINARY: '/tmp/runtime',
      CODEX_HOME: '/tmp/codex-home',
    });

    for (const key of RESET_BY_DEFAULT_RUNTIME_ENV_KEYS) {
      assert.equal(env[key], '', `${key} should reset to empty by default`);
    }
    assert.equal(env.OMX_RUNTIME_BINARY, undefined);
    assert.equal(env.CODEX_HOME, undefined);
    assert.equal(env.PATH, '/usr/bin');
  });

  it('buildChildEnv composes buildDebugChildEnv over the isolated base env', () => {
    const inheritedEnv = {
      PATH: '/usr/bin',
      OMX_TEST_DEBUG: '1',
      OMX_TEST_ARTIFACTS_DIR: '/tmp/artifacts',
      OMX_TEST_DEBUG_TEST_ID: 'explicit-debug-id',
      OMX_TEST_TRACE_ID: 'trace-123',
      TMUX: 'leader,123,0',
      OMX_RUNTIME_BINARY: '/tmp/runtime',
    } satisfies NodeJS.ProcessEnv;
    const cwd = '/tmp/fixture-cwd';

    const childEnv = buildChildEnv(cwd, {
      PATH: '/tmp/fake-bin:/usr/bin',
      OMX_RUNTIME_BINARY: '/tmp/runtime',
      TMUX: '',
      TMUX_PANE: '',
    }, inheritedEnv);

    assert.deepEqual(buildDebugChildEnv(cwd, inheritedEnv), {
      OMX_TEST_DEBUG: '1',
      OMX_TEST_DEBUG_TEST_ID: 'explicit-debug-id',
      OMX_TEST_ARTIFACTS_DIR: '/tmp/artifacts',
    });
    assert.equal(childEnv.PATH, '/tmp/fake-bin:/usr/bin');
    assert.equal(childEnv.OMX_RUNTIME_BINARY, '/tmp/runtime');
    assert.equal(childEnv.TMUX, '');
    assert.equal(childEnv.TMUX_PANE, '');
    assert.equal(childEnv.OMX_TEST_DEBUG, '1');
    assert.equal(childEnv.OMX_TEST_TRACE_ID, 'trace-123');
  });

  it('documents PATH and runtime selectors as explicit-only surfaces', () => {
    assert.deepEqual(EXPLICIT_RUNTIME_ENV_KEYS, [
      'PATH',
      'OMX_RUNTIME_BINARY',
      'CODEX_HOME',
    ]);
  });

  it('keeps OMX_TEST_CAPTURE_* as the only ambient fake tmux capture contract', () => {
    const script = buildFakeTmuxScript('/tmp/tmux.log');
    assert.match(script, /OMX_TEST_CAPTURE_FILE/);
    assert.match(script, /OMX_TEST_CAPTURE_SEQUENCE_FILE/);
    assert.match(script, /OMX_TEST_CAPTURE_COUNTER_FILE/);
    assert.doesNotMatch(script, /OMX_RUNTIME_BINARY/);
  });
});
