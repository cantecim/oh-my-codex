import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { appendRuntimeDecisionTrace, createRuntimeProcessTraceSession } from '../test-debug.js';

describe('test-debug runtime adapter surface', () => {
  it('appendRuntimeDecisionTrace is inert when debug is disabled', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-test-debug-off-'));
    try {
      const result = await appendRuntimeDecisionTrace(cwd, 'unit-module', 'unit.event', {}, {});
      assert.equal(result, null);
      await assert.rejects(() => readFile(join(cwd, '.omx', 'test-artifacts', 'decision-trace.jsonl'), 'utf8'));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('appendRuntimeDecisionTrace preserves the current event schema', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-test-debug-on-'));
    try {
      const env = {
        OMX_TEST_DEBUG: '1',
        OMX_TEST_DEBUG_TEST_ID: 'adapter-runtime-trace',
      } satisfies NodeJS.ProcessEnv;
      const path = await appendRuntimeDecisionTrace(cwd, 'unit-module', 'unit.event', {
        trace_id: 'trace-123',
        payload_key: 'value',
      }, env);
      assert.ok(path);
      const content = await readFile(path, 'utf8');
      assert.match(content, /"module":"unit-module"/);
      assert.match(content, /"event":"unit\.event"/);
      assert.match(content, /"test_id":"adapter-runtime-trace"/);
      assert.match(content, /"trace_id":"trace-123"/);
      assert.match(content, /"payload_key":"value"/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('createRuntimeProcessTraceSession preserves process-runner payload shape', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-test-debug-process-'));
    try {
      const env = {
        PATH: process.env.PATH ?? '',
        OMX_TEST_DEBUG: '1',
        OMX_TEST_DEBUG_TEST_ID: 'adapter-process-trace',
      } satisfies NodeJS.ProcessEnv;
      const session = createRuntimeProcessTraceSession(
        'tmux',
        ['list-panes'],
        3000,
        { command_role: 'dispatch_probe', invocation_id: 'inv-123', extra_field: 'extra' },
        env,
      );
      await session.append(cwd, Date.now() - 50, {
        status: 'ok',
        stdout_preview: 'stdout',
        stderr_preview: 'stderr',
      });
      const content = await readFile(join(cwd, '.omx', 'test-artifacts', 'adapter-process-trace', 'process-runner.jsonl'), 'utf8');
      assert.match(content, /"command":"tmux"/);
      assert.match(content, /"argv":\["list-panes"\]/);
      assert.match(content, /"invocation_id":"inv-123"/);
      assert.match(content, /"command_role":"dispatch_probe"/);
      assert.match(content, /"timeout_ms":3000/);
      assert.match(content, /"status":"ok"/);
      assert.match(content, /"resolved_command":/);
      assert.match(content, /"extra_field":"extra"/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('createRuntimeProcessTraceSession keeps debug disabled path inert', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-test-debug-disabled-process-'));
    try {
      const env = { PATH: process.env.PATH ?? '' } satisfies NodeJS.ProcessEnv;
      const session = createRuntimeProcessTraceSession('tmux', ['list-panes'], 3000, {}, env);
      assert.equal(session.debugEnabled, false);
      assert.equal(session.childEnv, env);
      await session.append(cwd, Date.now(), { status: 'ok' });
      await assert.rejects(() => readFile(join(cwd, '.omx', 'test-artifacts', 'process-runner.jsonl'), 'utf8'));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
