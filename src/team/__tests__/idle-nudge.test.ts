import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFakeTmuxScript, buildIsolatedEnv, withEnv } from '../../test-support/shared-harness.js';
import { DEFAULT_NUDGE_CONFIG, NudgeTracker, capturePane, isPaneIdle } from '../idle-nudge.js';

function renderCaptureToken(token: string): string {
  switch (token) {
    case 'IDLE':
      return '› ';
    case 'ACTIVE':
      return '› • Doing work (3s • esc to interrupt)';
    case 'EMPTY':
      return '';
    default:
      if (token.startsWith('RAW:')) return token.slice(4);
      return token;
  }
}

async function withFakeTmux(run: (ctx: {
  tmuxLogPath: string;
  setCaptureSequence: (tokens: string[]) => Promise<void>;
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'omx-idle-nudge-test-'));
  const binDir = join(root, 'bin');
  const tmuxPath = join(binDir, 'tmux');
  const tmuxLogPath = join(root, 'tmux.log');
  const captureSeqPath = join(root, 'capture-seq.txt');
  const captureFilePath = join(root, 'capture.txt');

  const hostPath = buildIsolatedEnv().PATH ?? '';

  try {
    await mkdir(binDir, { recursive: true });
    await writeFile(
      tmuxPath,
      buildFakeTmuxScript(tmuxLogPath, {
        listPaneLines: ['0 12345'],
      }),
    );
    await chmod(tmuxPath, 0o755);
    await writeFile(captureFilePath, renderCaptureToken('IDLE'));

    await withEnv({
      PATH: hostPath ? `${binDir}:${hostPath}` : binDir,
      OMX_TEST_CAPTURE_SEQUENCE_FILE: captureSeqPath,
      OMX_TEST_CAPTURE_COUNTER_FILE: undefined,
      OMX_TEST_CAPTURE_FILE: captureFilePath,
    }, async () => {
      await run({
        tmuxLogPath,
        setCaptureSequence: async (tokens: string[]) => {
          await writeFile(captureSeqPath, tokens.map(renderCaptureToken).join('\n'));
        },
      });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withMockedNow(
  initialNow: number,
  run: (setNow: (nextNow: number) => void) => Promise<void>,
): Promise<void> {
  const originalNow = Date.now;
  let currentNow = initialNow;
  Date.now = () => currentNow;
  try {
    await run((nextNow: number) => {
      currentNow = nextNow;
    });
  } finally {
    Date.now = originalNow;
  }
}

describe('idle-nudge', () => {
  it('uses an explicit next-action default nudge message', () => {
    assert.equal(
      DEFAULT_NUDGE_CONFIG.message,
      'Next: read your inbox/mailbox, continue your assigned task now, and if blocked send the leader a concrete status update.',
    );
    const tracker = new NudgeTracker();
    assert.equal(tracker.totalNudges, 0);
  });

  it('throttles scans that happen too soon after the previous scan', async () => {
    await withFakeTmux(async ({ tmuxLogPath }) => {
      await withMockedNow(10_000, async (setNow) => {
        const tracker = new NudgeTracker({ delayMs: 0, maxCount: 3, message: 'nudge' });

        const first = await tracker.checkAndNudge(['%2'], undefined, 'omx-team-a');
        assert.deepEqual(first, ['%2']);
        const firstLog = await readFile(tmuxLogPath, 'utf-8');

        setNow(11_000); // < 5000ms scan interval
        const second = await tracker.checkAndNudge(['%2'], undefined, 'omx-team-a');
        assert.deepEqual(second, []);

        const secondLog = await readFile(tmuxLogPath, 'utf-8');
        assert.equal(secondLog, firstLog);
      });
    });
  });

  it('never nudges the leader pane', async () => {
    await withFakeTmux(async ({ tmuxLogPath }) => {
      const tracker = new NudgeTracker({ delayMs: 0, maxCount: 3, message: 'nudge' });
      const nudged = await tracker.checkAndNudge(['%1'], '%1', 'omx-team-a');
      assert.deepEqual(nudged, []);

      assert.equal(existsSync(tmuxLogPath), false);
      assert.equal(tracker.totalNudges, 0);
      assert.deepEqual(tracker.getSummary(), {});
    });
  });

  it('respects maxCount and does not scan again once pane reached nudge limit', async () => {
    await withFakeTmux(async ({ tmuxLogPath }) => {
      await withMockedNow(10_000, async (setNow) => {
        const tracker = new NudgeTracker({ delayMs: 0, maxCount: 1, message: 'nudge' });

        const first = await tracker.checkAndNudge(['%2'], undefined, 'omx-team-a');
        assert.deepEqual(first, ['%2']);
        const firstLog = await readFile(tmuxLogPath, 'utf-8');

        setNow(16_000); // > 5000ms scan interval
        const second = await tracker.checkAndNudge(['%2'], undefined, 'omx-team-a');
        assert.deepEqual(second, []);

        const secondLog = await readFile(tmuxLogPath, 'utf-8');
        assert.equal(secondLog, firstLog);
        assert.equal(tracker.totalNudges, 1);
        assert.deepEqual(tracker.getSummary(), {
          '%2': {
            nudgeCount: 1,
            lastNudgeAt: 10_000,
          },
        });
      });
    });
  });

  it('resets idle timer when pane becomes active before delay elapses', async () => {
    await withFakeTmux(async ({ setCaptureSequence }) => {
      await setCaptureSequence(['IDLE', 'IDLE', 'ACTIVE', 'IDLE', 'IDLE']);

      await withMockedNow(10_000, async (setNow) => {
        const tracker = new NudgeTracker({ delayMs: 10_000, maxCount: 3, message: 'nudge' });

        const r1 = await tracker.checkAndNudge(['%2'], undefined, 'omx-team-a');
        assert.deepEqual(r1, []);

        setNow(16_000);
        const r2 = await tracker.checkAndNudge(['%2'], undefined, 'omx-team-a');
        assert.deepEqual(r2, []);

        setNow(22_000);
        const r3 = await tracker.checkAndNudge(['%2'], undefined, 'omx-team-a');
        assert.deepEqual(r3, []);

        setNow(28_000);
        const r4 = await tracker.checkAndNudge(['%2'], undefined, 'omx-team-a');
        assert.deepEqual(r4, []);

        setNow(39_000);
        const r5 = await tracker.checkAndNudge(['%2'], undefined, 'omx-team-a');
        assert.deepEqual(r5, ['%2']);
        assert.equal(tracker.totalNudges, 1);
      });
    });
  });

  it('does not count nudges when sendToWorker fails', async () => {
    await withFakeTmux(async () => {
      const root = await mkdtemp(join(tmpdir(), 'omx-idle-nudge-fail-send-'));
      const binDir = join(root, 'bin');
      const tmuxPath = join(binDir, 'tmux');
      const hostPath = buildIsolatedEnv().PATH ?? '';
      try {
        await mkdir(binDir, { recursive: true });
        await writeFile(
          tmuxPath,
          buildFakeTmuxScript(join(root, 'tmux.log'), {
            listPaneLines: ['0 12345'],
            failSendKeys: true,
          }),
        );
        await chmod(tmuxPath, 0o755);

        await withEnv({
          PATH: hostPath ? `${binDir}:${hostPath}` : binDir,
        }, async () => {
          await withMockedNow(10_000, async () => {
            const tracker = new NudgeTracker({ delayMs: 0, maxCount: 3, message: 'nudge' });
            const nudged = await tracker.checkAndNudge(['%2'], undefined, 'omx-team-a');
            assert.deepEqual(nudged, []);
            assert.equal(tracker.totalNudges, 0);
            assert.deepEqual(tracker.getSummary(), {});
          });
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it('returns empty capture and non-idle when capture-pane command fails', async () => {
    await withFakeTmux(async () => {
      const root = await mkdtemp(join(tmpdir(), 'omx-idle-nudge-fail-capture-'));
      const binDir = join(root, 'bin');
      const tmuxPath = join(binDir, 'tmux');
      const hostPath = buildIsolatedEnv().PATH ?? '';
      try {
        await mkdir(binDir, { recursive: true });
        await writeFile(
          tmuxPath,
          buildFakeTmuxScript(join(root, 'tmux.log'), {
            listPaneLines: ['0 12345'],
            failCapture: true,
          }),
        );
        await chmod(tmuxPath, 0o755);

        await withEnv({
          PATH: hostPath ? `${binDir}:${hostPath}` : binDir,
        }, async () => {
          const captured = await capturePane('%2');
          assert.equal(captured, '');

          const idle = await isPaneIdle('%2');
          assert.equal(idle, false);
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
