import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initTeamState,
  enqueueDispatchRequest,
  readDispatchRequest,
  listMailboxMessages,
  sendDirectMessage,
  readTeamConfig,
  saveTeamConfig,
} from '../../team/state.js';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { buildFakeTmuxScript, withEnv } from '../../test-support/shared-harness.js';

function buildFakeTmux(
  tmuxLogPath: string,
  options: Parameters<typeof buildFakeTmuxScript>[1] = {},
): string {
  return buildFakeTmuxScript(tmuxLogPath, {
    listPaneLines: ['%42 1'],
    defaultProbe: {
      paneInMode: '0',
      currentPath: dirname(tmuxLogPath),
      currentCommand: 'codex',
      startCommand: 'codex',
      sessionName: 'session-test',
    },
    ...options,
  });
}

const DISPATCH_MODULE_URL = pathToFileURL(new URL('../../../dist/scripts/notify-hook/team-dispatch.js', import.meta.url).pathname).href;

async function loadDispatchModule() {
  return import(DISPATCH_MODULE_URL);
}

async function withDispatchEnv<T>(
  run: () => Promise<T>,
  overrides: Record<string, string | undefined> = {},
): Promise<T> {
  // Temporary same-process fallback for module-oriented tests.
  return withEnv({
    OMX_TEAM_WORKER: undefined,
    OMX_TEAM_STATE_ROOT: undefined,
    OMX_TEAM_LEADER_CWD: undefined,
    OMX_MODEL_INSTRUCTIONS_FILE: undefined,
    TMUX: undefined,
    TMUX_PANE: undefined,
    ...overrides,
  }, run);
}

function dispatchCase(
  name: string,
  run: () => Promise<void>,
) {
  it(name, async () => {
    await withDispatchEnv(run);
  });
}

describe('notify-hook team dispatch consumer', () => {
  dispatchCase('marks pending request as notified and preserves mailbox notified_at semantics', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    try {
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const msg = await sendDirectMessage('alpha', 'worker-1', 'worker-1', 'hello', cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'mailbox',
        to_worker: 'worker-1',
        worker_index: 1,
        message_id: msg.message_id,
        trigger_message: 'check mailbox',
      }, cwd);

      const mod = await loadDispatchModule();
      const result = await mod.drainPendingTeamDispatch({
        cwd,
        maxPerTick: 5,
        injector: async () => ({ ok: true, reason: 'injected_for_test' }),
      });
      assert.equal(result.processed, 1);
      const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
      assert.equal(request?.status, 'notified');
      const mailbox = await listMailboxMessages('alpha', 'worker-1', cwd);
      assert.ok(mailbox[0]?.notified_at);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  dispatchCase('leader-fixed dispatch remains pending with leader_pane_missing_deferred when pane missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    try {
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const msg = await sendDirectMessage('alpha', 'worker-1', 'leader-fixed', 'hello leader', cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'mailbox',
        to_worker: 'leader-fixed',
        message_id: msg.message_id,
        trigger_message: 'check leader mailbox',
      }, cwd);

      const mod = await loadDispatchModule();
      const result = await mod.drainPendingTeamDispatch({
        cwd,
        maxPerTick: 5,
        injector: async () => ({ ok: true, reason: 'injected_for_test' }),
      });

      assert.equal(result.processed, 0);
      assert.ok(result.skipped >= 1);

      const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
      assert.equal(request?.status, 'pending');
      assert.equal(request?.last_reason, 'leader_pane_missing_deferred');

      const mailbox = await listMailboxMessages('alpha', 'leader-fixed', cwd);
      assert.equal(mailbox.length, 1);
      assert.equal(mailbox[0]?.notified_at, undefined);

      const eventsPath = join(cwd, '.omx', 'state', 'team', 'alpha', 'events', 'events.ndjson');
      const eventsRaw = await readFile(eventsPath, 'utf-8');
      const events = eventsRaw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const deferred = events.find((event: {
        type?: string;
        reason?: string;
        request_id?: string;
        to_worker?: string;
      }) =>
        event.type === 'leader_notification_deferred'
        && event.reason === 'leader_pane_missing_deferred'
        && event.request_id === queued.request.request_id
        && event.to_worker === 'leader-fixed');
      assert.ok(deferred, 'expected leader_notification_deferred event for missing leader pane');
      assert.equal(deferred.source_type, 'team_dispatch');
      assert.equal(typeof deferred.tmux_session, 'string');
      assert.ok(deferred.tmux_session.length > 0);
      assert.equal(deferred.leader_pane_id, null);
      assert.equal(deferred.tmux_injection_attempted, false);

      const dispatchLogPath = join(cwd, '.omx', 'logs', `team-dispatch-${new Date().toISOString().slice(0, 10)}.jsonl`);
      const dispatchLogs = (await readFile(dispatchLogPath, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const deferredLog = dispatchLogs.find((entry: { type?: string; request_id?: string }) =>
        entry.type === 'dispatch_deferred' && entry.request_id === queued.request.request_id);
      assert.ok(deferredLog, 'expected dispatch_deferred log entry');
      assert.equal(typeof deferredLog.tmux_session, 'string');
      assert.ok(deferredLog.tmux_session.length > 0);
      assert.equal(deferredLog.leader_pane_id, null);
      assert.equal(deferredLog.tmux_injection_attempted, false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  dispatchCase('does not duplicate deferred leader artifacts across repeated drain ticks', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    try {
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const msg = await sendDirectMessage('alpha', 'worker-1', 'leader-fixed', 'hello leader', cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'mailbox',
        to_worker: 'leader-fixed',
        message_id: msg.message_id,
        trigger_message: 'check leader mailbox',
      }, cwd);

      const mod = await loadDispatchModule();
      await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5, injector: async () => ({ ok: true, reason: 'injected_for_test' }) });
      await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5, injector: async () => ({ ok: true, reason: 'injected_for_test' }) });

      const eventsPath = join(cwd, '.omx', 'state', 'team', 'alpha', 'events', 'events.ndjson');
      const events = (await readFile(eventsPath, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const deferredEvents = events.filter((event: { type?: string; request_id?: string }) =>
        event.type === 'leader_notification_deferred' && event.request_id === queued.request.request_id);
      assert.equal(deferredEvents.length, 1, 'should only write one deferred event per missing-pane request until state changes');

      const dispatchLogPath = join(cwd, '.omx', 'logs', `team-dispatch-${new Date().toISOString().slice(0, 10)}.jsonl`);
      const dispatchLogs = (await readFile(dispatchLogPath, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const deferredLogs = dispatchLogs.filter((entry: { type?: string; request_id?: string }) =>
        entry.type === 'dispatch_deferred' && entry.request_id === queued.request.request_id);
      assert.equal(deferredLogs.length, 1, 'should only log one dispatch_deferred artifact per missing-pane request until state changes');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  dispatchCase('invokes omx-runtime exec via shared bridge fallback', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const runtimeLogPath = join(cwd, 'runtime.log');
    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(
        join(fakeBinDir, 'omx-runtime'),
        `#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "${runtimeLogPath}"
if [[ "\${1:-}" == "schema" ]]; then
  printf '{"schema_version":1,"commands":["acquire-authority","renew-authority","queue-dispatch","mark-notified","mark-delivered","mark-failed","request-replay","capture-snapshot"],"events":[],"transport":"tmux"}\n'
  exit 0
fi
if [[ "\${1:-}" == "exec" ]]; then
  printf '{"event":"DispatchNotified","request_id":"runtime-fallback","channel":"tmux"}\n'
  exit 0
fi
exit 1
`,
      );
      await chmod(join(fakeBinDir, 'omx-runtime'), 0o755);
      await withDispatchEnv(async () => {
        await initTeamState('alpha', 'task', 'executor', 1, cwd);
        const queued = await enqueueDispatchRequest('alpha', {
          kind: 'inbox',
          to_worker: 'worker-1',
          worker_index: 1,
          pane_id: '%42',
          trigger_message: 'ping',
        }, cwd);

        const mod = await loadDispatchModule();
        await mod.drainPendingTeamDispatch({
          cwd,
          maxPerTick: 5,
          injector: async () => ({ ok: true, reason: 'injected_for_test' }),
        });

        const runtimeLog = await readFile(runtimeLogPath, 'utf8');
        assert.match(runtimeLog, /^exec \{"command":"MarkNotified"/m);

        const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
        assert.equal(request?.status, 'notified');
      }, {
        PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
        OMX_RUNTIME_BINARY: join(fakeBinDir, 'omx-runtime'),
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  dispatchCase('leader-fixed dispatch uses pane target only when leader_pane_id exists', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');
    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await withDispatchEnv(async () => {
        await initTeamState('alpha', 'task', 'executor', 1, cwd);
        const cfg = await readTeamConfig('alpha', cwd);
        assert.ok(cfg);
        if (!cfg) throw new Error('missing team config');
        cfg.leader_pane_id = '%99';
        await saveTeamConfig(cfg, cwd);

        const msg = await sendDirectMessage('alpha', 'worker-1', 'leader-fixed', 'hello leader', cwd);
        await enqueueDispatchRequest('alpha', {
          kind: 'mailbox',
          to_worker: 'leader-fixed',
          message_id: msg.message_id,
          trigger_message: 'Read .omx/state/team/alpha/mailbox/leader-fixed.json; worker-1 sent a new message. Review it and decide the next concrete step.',
        }, cwd);

        const mod = await loadDispatchModule();
        const result = await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5 });
        assert.equal(result.processed, 1);

        const tmuxLog = await readFile(tmuxLogPath, 'utf8');
        assert.match(tmuxLog, /send-keys -t %99/);
        assert.match(tmuxLog, /mailbox\/leader-fixed\.json; worker-1 sent a new message/);
        assert.doesNotMatch(tmuxLog, /send-keys -t .*devsess/);
      }, {
        PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  dispatchCase('leader-fixed dispatch prefers the canonical codex pane over a stale HUD leader pane id', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');
    try {
      await mkdir(fakeBinDir, { recursive: true });
      const fakeTmux = buildFakeTmux(tmuxLogPath, {
        paneProbes: {
          '%42': {
            currentCommand: 'codex',
            startCommand: 'codex',
          },
          '%91': {
            startCommand: 'node dist/cli/omx.js hud --watch',
          },
          '%99': {
            currentCommand: 'codex',
          },
        },
        captureOutput: '› ready\n',
        listPaneLines: ['%42\t1\tnode\tcodex', '%91\t0\tnode\tnode dist/cli/omx.js hud --watch'],
      });
      await writeFile(join(fakeBinDir, 'tmux'), fakeTmux);
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await withDispatchEnv(async () => {
        await initTeamState('alpha', 'task', 'executor', 1, cwd);
        const cfg = await readTeamConfig('alpha', cwd);
        assert.ok(cfg);
        if (!cfg) throw new Error('missing team config');
        cfg.leader_pane_id = '%91';
        await saveTeamConfig(cfg, cwd);

        const msg = await sendDirectMessage('alpha', 'worker-1', 'leader-fixed', 'hello leader', cwd);
        await enqueueDispatchRequest('alpha', {
          kind: 'mailbox',
          to_worker: 'leader-fixed',
          message_id: msg.message_id,
          trigger_message: 'Read .omx/state/team/alpha/mailbox/leader-fixed.json; worker-1 sent a new message. Review it and decide the next concrete step.',
        }, cwd);

        const mod = await loadDispatchModule();
        const result = await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5 });
        assert.equal(result.processed, 1);

        const tmuxLog = await readFile(tmuxLogPath, 'utf8');
        assert.match(tmuxLog, /send-keys -t %42/);
        assert.doesNotMatch(tmuxLog, /send-keys -t %91/);
      }, {
        PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
        TMUX_PANE: '%42',
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  dispatchCase('uses explicit stateDir when marking mailbox notified_at', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    const stateDir = join(cwd, 'custom-state-root');
    try {
      await withDispatchEnv(async () => {
        await initTeamState('alpha', 'task', 'executor', 1, cwd);
        const msg = await sendDirectMessage('alpha', 'worker-1', 'worker-1', 'hello', cwd);
        const queued = await enqueueDispatchRequest('alpha', {
          kind: 'mailbox',
          to_worker: 'worker-1',
          worker_index: 1,
          message_id: msg.message_id,
          trigger_message: 'check mailbox',
        }, cwd);

        const mod = await loadDispatchModule();
        const result = await mod.drainPendingTeamDispatch({
          cwd,
          stateDir,
          maxPerTick: 5,
          injector: async () => ({ ok: true, reason: 'injected_for_test' }),
        });

        assert.equal(result.processed, 1);
        const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
        assert.equal(request?.status, 'notified');
        const mailbox = await listMailboxMessages('alpha', 'worker-1', cwd);
        assert.ok(mailbox[0]?.notified_at);
      }, {
        OMX_TEAM_STATE_ROOT: './custom-state-root',
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  dispatchCase('is idempotent across repeated ticks (no duplicate processing)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    try {
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        trigger_message: 'ping',
      }, cwd);

      const mod = await loadDispatchModule();
      await mod.drainPendingTeamDispatch({
        cwd,
        maxPerTick: 5,
        injector: async () => ({ ok: true, reason: 'injected_for_test' }),
      });
      const second = await mod.drainPendingTeamDispatch({
        cwd,
        maxPerTick: 5,
        injector: async () => ({ ok: true, reason: 'injected_for_test' }),
      });
      assert.equal(second.processed, 0);
      const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
      assert.equal(request?.status, 'notified');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  dispatchCase('leaves unconfirmed injection as pending for retry (#391)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    try {
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        trigger_message: 'ping',
      }, cwd);

      const mod = await loadDispatchModule();
      // First tick: injector returns unconfirmed → should stay pending
      const result = await mod.drainPendingTeamDispatch({
        cwd,
        maxPerTick: 5,
        injector: async () => ({ ok: true, reason: 'tmux_send_keys_unconfirmed' }),
      });
      assert.equal(result.processed, 0, 'unconfirmed should not count as processed');
      assert.ok(result.skipped >= 1, 'unconfirmed should be skipped for retry');
      const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
      assert.equal(request?.status, 'pending', 'status should remain pending');
      assert.equal(request?.last_reason, 'tmux_send_keys_unconfirmed');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  dispatchCase('marks unconfirmed as failed after max attempts (#391)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    try {
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        trigger_message: 'ping',
      }, cwd);

      const mod = await loadDispatchModule();
      const injector = async () => ({ ok: true, reason: 'tmux_send_keys_unconfirmed' });
      // Drain 3 times to exhaust max attempts (MAX_UNCONFIRMED_ATTEMPTS=3)
      await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5, injector });
      await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5, injector });
      const result = await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5, injector });
      assert.equal(result.processed, 1, 'should transition to failed on 3rd attempt');
      assert.equal(result.failed, 1);
      const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
      assert.equal(request?.status, 'failed');
      assert.equal(request?.last_reason, 'unconfirmed_after_max_retries');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  dispatchCase('confirmed injection marks notified immediately (#391)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    try {
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        trigger_message: 'ping',
      }, cwd);

      const mod = await loadDispatchModule();
      const result = await mod.drainPendingTeamDispatch({
        cwd,
        maxPerTick: 5,
        injector: async () => ({ ok: true, reason: 'tmux_send_keys_confirmed' }),
      });
      assert.equal(result.processed, 1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  dispatchCase('keeps retry_pending derived-only and does not persist transient tags', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    try {
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        trigger_message: 'ping',
      }, cwd);

      const mod = await loadDispatchModule();
      await mod.drainPendingTeamDispatch({
        cwd,
        maxPerTick: 5,
        injector: async () => ({ ok: true, reason: 'tmux_send_keys_unconfirmed' }),
      });

      const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
      assert.equal(request?.status, 'pending');
      assert.equal(request?.last_reason, 'tmux_send_keys_unconfirmed');
      assert.notEqual(request?.status, 'retry_pending');

      const rawRequests = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'team', 'alpha', 'dispatch', 'requests.json'), 'utf8'));
      const persisted = rawRequests.find((entry: { request_id?: string }) => entry?.request_id === queued.request.request_id);
      assert.ok(persisted);
      assert.equal(persisted.status, 'pending');
      assert.ok(!('retry_mode' in persisted), 'retry_mode must not be persisted');
      assert.ok(!('retry_tag' in persisted), 'retry_tag must not be persisted');
      assert.ok(!('status_tag' in persisted), 'status_tag must not be persisted');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  dispatchCase('retries submit with isolated C-m and does not retype when trigger already present', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');
    const captureFile = join(cwd, 'capture.txt');
    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      await writeFile(captureFile, '... ping ...');
      await withDispatchEnv(async () => {
        await initTeamState('alpha', 'task', 'executor', 1, cwd);
        const queued = await enqueueDispatchRequest('alpha', {
          kind: 'inbox',
          to_worker: 'worker-1',
          worker_index: 1,
          pane_id: '%42',
          trigger_message: 'ping',
        }, cwd);

        const mod = await loadDispatchModule();
        await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5 });
        await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5 });

        const tmuxLog = await readFile(tmuxLogPath, 'utf8');
        const typeMatches = tmuxLog.match(/send-keys -t %42 -l ping/g) || [];
        assert.equal(typeMatches.length, 1, 'fresh attempt should type once; retries with draft should be submit-only');
        const cmMatches = tmuxLog.match(/send-keys -t %42 C-m/g) || [];
        assert.ok(cmMatches.length > 0, 'submit should use C-m');
        assert.ok(!/send-keys[^\n]*-l[^\n]*C-m/.test(tmuxLog), 'must not mix -l payload with C-m submit');

        const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
        assert.equal(request?.status, 'pending');
        assert.equal(request?.attempt_count, 2);
        assert.equal(request?.last_reason, 'tmux_send_keys_unconfirmed');
      }, {
        PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
        OMX_TEST_CAPTURE_FILE: captureFile,
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  dispatchCase('retypes on every retry when trigger is not in narrow input area', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');
    const captureSeqFile = join(cwd, 'capture-seq.txt');
    const captureCounterFile = join(cwd, 'capture-seq.idx');
    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      // Shared preflight now adds one 80-line capture per tick before the
      // narrow retry check. Pre-capture on retries still returns "ready"
      // (no trigger) so the request is retyped on every retry.
      await writeFile(captureSeqFile, [
        // tick1: 1 shared preflight + 3 verify rounds × 2 captures = 7
        'ready', 'ping', 'ping', 'ping', 'ping', 'ping', 'ping',
        // tick2: 1 shared preflight + 1 pre-capture + 3 verify rounds × 2 captures = 8
        'ready', 'ready', 'ping', 'ping', 'ping', 'ping', 'ping', 'ping',
        // tick3: 1 shared preflight + 1 pre-capture + 3 verify rounds × 2 captures = 8
        'ready', 'ready', 'ping', 'ping', 'ping', 'ping', 'ping', 'ping',
      ].join('\n'));
      await withDispatchEnv(async () => {
        await initTeamState('alpha', 'task', 'executor', 1, cwd);
        const queued = await enqueueDispatchRequest('alpha', {
          kind: 'inbox',
          to_worker: 'worker-1',
          worker_index: 1,
          pane_id: '%42',
          trigger_message: 'ping',
        }, cwd);

        const mod = await loadDispatchModule();
        await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5 });
        await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5 });
        await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5 });

        const tmuxLog = await readFile(tmuxLogPath, 'utf8');
        const typeMatches = tmuxLog.match(/send-keys -t %42 -l ping/g) || [];
        assert.equal(typeMatches.length, 3, 'should retype on every retry when trigger not in narrow capture (fresh + 2 retries)');

        const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
        assert.equal(request?.status, 'failed');
        assert.equal(request?.last_reason, 'unconfirmed_after_max_retries');
      }, {
        PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
        OMX_TEST_CAPTURE_SEQUENCE_FILE: captureSeqFile,
        OMX_TEST_CAPTURE_COUNTER_FILE: captureCounterFile,
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  dispatchCase('does not confirm when narrow misses but wide tail still has unsent trigger', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');
    const captureSeqFile = join(cwd, 'capture-seq.txt');
    const captureCounterFile = join(cwd, 'capture-seq.idx');
    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      // Each verify round uses narrow + wide capture.
      // Narrow captures are whitespace-only (trigger absent), while wide captures
      // still include the trigger near tail => should remain unconfirmed.
      await writeFile(captureSeqFile, [
        '   ', 'ping',
        '   ', 'ping',
        '   ', 'ping',
      ].join('\n'));
      await withDispatchEnv(async () => {
        await initTeamState('alpha', 'task', 'executor', 1, cwd);
        const queued = await enqueueDispatchRequest('alpha', {
          kind: 'inbox',
          to_worker: 'worker-1',
          worker_index: 1,
          pane_id: '%42',
          trigger_message: 'ping',
        }, cwd);

        const mod = await loadDispatchModule();
        const result = await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5 });
        assert.equal(result.processed, 0, 'must not mark notified when wide tail still shows trigger');
        assert.ok(result.skipped >= 1);

        const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
        assert.equal(request?.status, 'pending');
        assert.equal(request?.last_reason, 'tmux_send_keys_unconfirmed');
      }, {
        PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
        OMX_TEST_CAPTURE_SEQUENCE_FILE: captureSeqFile,
        OMX_TEST_CAPTURE_COUNTER_FILE: captureCounterFile,
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  dispatchCase('does not confirm while pane is still bootstrapping even when trigger is absent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');
    const captureSeqFile = join(cwd, 'capture-seq.txt');
    const captureCounterFile = join(cwd, 'capture-seq.idx');
    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      // verify rounds: narrow capture empty, wide capture still loading.
      await writeFile(captureSeqFile, [
        '   ', 'model: loading',
        '   ', 'model: loading',
        '   ', 'model: loading',
      ].join('\n'));
      await withDispatchEnv(async () => {
        await initTeamState('alpha', 'task', 'executor', 1, cwd);
        const queued = await enqueueDispatchRequest('alpha', {
          kind: 'inbox',
          to_worker: 'worker-1',
          worker_index: 1,
          pane_id: '%42',
          trigger_message: 'ping',
        }, cwd);

        const mod = await loadDispatchModule();
        const result = await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5 });
        assert.equal(result.processed, 0);
        assert.ok(result.skipped >= 1);

        const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
        assert.equal(request?.status, 'pending');
        assert.equal(request?.last_reason, 'tmux_send_keys_unconfirmed');
      }, {
        PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
        OMX_TEST_CAPTURE_SEQUENCE_FILE: captureSeqFile,
        OMX_TEST_CAPTURE_COUNTER_FILE: captureCounterFile,
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  dispatchCase('applies per-issue cooldown to avoid repeated reinjection in one drain tick', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    try {
      await withDispatchEnv(async () => {
        await initTeamState('alpha', 'task', 'executor', 2, cwd);
        const first = await enqueueDispatchRequest('alpha', {
          kind: 'inbox',
          to_worker: 'worker-1',
          worker_index: 1,
          trigger_message: '› IND-123 only...',
        }, cwd);
        const second = await enqueueDispatchRequest('alpha', {
          kind: 'inbox',
          to_worker: 'worker-2',
          worker_index: 2,
          trigger_message: 'IND-123 only...',
        }, cwd);

        const mod = await loadDispatchModule();
        const result = await mod.drainPendingTeamDispatch({
          cwd,
          maxPerTick: 5,
          injector: async () => ({ ok: true, reason: 'injected_for_test' }),
        });
        assert.equal(result.processed, 1);
        assert.ok(result.skipped >= 1);

        const firstReq = await readDispatchRequest('alpha', first.request.request_id, cwd);
        const secondReq = await readDispatchRequest('alpha', second.request.request_id, cwd);
        assert.equal(firstReq?.status, 'notified');
        assert.equal(secondReq?.status, 'pending');
        assert.equal(secondReq?.attempt_count, 0);
      }, {
        OMX_TEAM_DISPATCH_ISSUE_COOLDOWN_MS: '900000',
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  dispatchCase('skips repeated same-issue reinjection during per-issue cooldown window', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    let injectCount = 0;
    try {
      await withDispatchEnv(async () => {
        await initTeamState('alpha', 'task', 'executor', 1, cwd);
        const first = await enqueueDispatchRequest('alpha', {
          kind: 'inbox',
          to_worker: 'worker-1',
          worker_index: 1,
          trigger_message: 'IND-123 only...',
        }, cwd);
        const second = await enqueueDispatchRequest('alpha', {
          kind: 'inbox',
          to_worker: 'worker-1',
          worker_index: 1,
          trigger_message: 'IND-123 only: retry',
        }, cwd);

        const mod = await loadDispatchModule();
        const injector = async () => {
          injectCount += 1;
          return { ok: true, reason: 'tmux_send_keys_unconfirmed' };
        };

        const firstTick = await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5, injector });
        const secondTick = await mod.drainPendingTeamDispatch({ cwd, maxPerTick: 5, injector });

        assert.equal(firstTick.processed, 0);
        assert.ok(firstTick.skipped >= 1);
        assert.equal(secondTick.processed, 0);
        assert.ok(secondTick.skipped >= 2);
        assert.equal(injectCount, 1, 'same issue should not be reinjected while cooldown is active');

        const firstRequest = await readDispatchRequest('alpha', first.request.request_id, cwd);
        const secondRequest = await readDispatchRequest('alpha', second.request.request_id, cwd);
        assert.equal(firstRequest?.status, 'pending');
        assert.equal(firstRequest?.attempt_count, 1);
        assert.equal(secondRequest?.status, 'pending');
        assert.equal(secondRequest?.attempt_count, 0, 'cooldown-blocked request should remain untouched');
      }, {
        OMX_TEAM_DISPATCH_ISSUE_COOLDOWN_MS: '900000',
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  dispatchCase('skips non-hook transport preferences in hook consumer', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hook-team-dispatch-'));
    try {
      await initTeamState('alpha', 'task', 'executor', 1, cwd);
      const queued = await enqueueDispatchRequest('alpha', {
        kind: 'inbox',
        to_worker: 'worker-1',
        worker_index: 1,
        trigger_message: 'ping',
        transport_preference: 'transport_direct',
        fallback_allowed: false,
      }, cwd);

      const mod = await loadDispatchModule();
      const result = await mod.drainPendingTeamDispatch({
        cwd,
        maxPerTick: 5,
        injector: async () => ({ ok: true, reason: 'injected_for_test' }),
      });
      assert.equal(result.processed, 0);
      assert.equal(result.failed, 0);
      assert.ok(result.skipped >= 1);
      const request = await readDispatchRequest('alpha', queued.request.request_id, cwd);
      assert.equal(request?.status, 'pending');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
