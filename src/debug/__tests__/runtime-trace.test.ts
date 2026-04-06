import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { createProcessTraceSession, traceDecision } from '../runtime-trace.js';

describe('runtime-trace', () => {
  it('traceDecision returns null and writes nothing when debug is disabled', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-trace-off-'));
    try {
      const result = await traceDecision(cwd, 'unit-module', 'unit.event', {}, {});
      assert.equal(result, null);
      await assert.rejects(() => readFile(join(cwd, '.omx', 'test-artifacts', 'decision-trace.jsonl'), 'utf8'));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('traceDecision writes decision trace through the adapter when debug is enabled', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-trace-on-'));
    try {
      const env = {
        OMX_TEST_DEBUG: '1',
        OMX_TEST_DEBUG_TEST_ID: 'runtime-trace-test',
      } satisfies NodeJS.ProcessEnv;
      const path = await traceDecision(cwd, 'unit-module', 'unit.event', { foo: 'bar' }, env);
      assert.ok(path);
      const content = await readFile(path, 'utf8');
      assert.match(content, /"module":"unit-module"/);
      assert.match(content, /"event":"unit\.event"/);
      assert.match(content, /"test_id":"runtime-trace-test"/);
      assert.match(content, /"foo":"bar"/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('createProcessTraceSession preserves child env identity when debug is disabled', () => {
    const env = { PATH: '/usr/bin' } satisfies NodeJS.ProcessEnv;
    const session = createProcessTraceSession('tmux', ['list-panes'], 1000, {}, env);
    assert.equal(session.debugEnabled, false);
    assert.equal(session.childEnv, env);
    assert.equal(session.invocationId, '');
    assert.equal(session.commandRole, '');
  });

  it('createProcessTraceSession adds only trace-specific child env when debug is enabled', () => {
    const env = {
      PATH: '/usr/bin',
      OMX_TEST_DEBUG: '1',
      OMX_TEST_DEBUG_TEST_ID: 'runtime-process-trace',
    } satisfies NodeJS.ProcessEnv;
    const session = createProcessTraceSession(
      'tmux',
      ['list-panes'],
      1000,
      { command_role: 'readiness_probe', invocation_id: 'explicit-invocation' },
      env,
    );
    assert.equal(session.debugEnabled, true);
    assert.notEqual(session.childEnv, env);
    assert.equal(session.commandRole, 'readiness_probe');
    assert.equal(session.invocationId, 'explicit-invocation');
    assert.equal(session.childEnv.OMX_TEST_TMUX_INVOCATION_ID, 'explicit-invocation');
    assert.equal(session.childEnv.OMX_TEST_TMUX_COMMAND_ROLE, 'readiness_probe');
    assert.equal(session.childEnv.PATH, env.PATH);
    assert.equal(session.childEnv.OMX_TEST_DEBUG, env.OMX_TEST_DEBUG);
    assert.equal(session.childEnv.OMX_TEST_DEBUG_TEST_ID, env.OMX_TEST_DEBUG_TEST_ID);
  });

  it('runtime-trace source no longer embeds test-debug policy details', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/debug/runtime-trace.ts'), 'utf8');
    const forbidden = [
      'OMX_TEST_DEBUG',
      'decision-trace.jsonl',
      'process-runner.jsonl',
      'resolveDebugTestId',
      'collectDebugEnvSubset',
      "from './debug-artifacts.js'",
    ];
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });
});
