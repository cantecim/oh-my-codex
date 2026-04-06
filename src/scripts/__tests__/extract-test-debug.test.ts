import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseExtractTestDebugOptions, summarizeArtifactDir } from '../extract-test-debug.js';

async function createArtifactDir(root: string, name: string, updatedAtMs: number): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ cwd: dir }));
  await writeFile(join(dir, 'paths.json'), JSON.stringify({ cwd: dir }));
  const timestamp = new Date(updatedAtMs);
  await utimes(dir, timestamp, timestamp);
  await utimes(join(dir, 'manifest.json'), timestamp, timestamp);
  await utimes(join(dir, 'paths.json'), timestamp, timestamp);
  return dir;
}

describe('extract-test-debug ergonomics', () => {
  it('supports latest selection and reports omitted historical artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-extract-debug-'));
    const now = Date.now();
    try {
      await createArtifactDir(root, 'older-artifact', now - 60_000);
      await createArtifactDir(root, 'newer-artifact', now - 10_000);

      const summary = await summarizeArtifactDir(root, '', { latest: 1 });
      assert.equal(summary.selection_mode, 'latest');
      assert.equal(summary.total_matching_dirs, 2);
      assert.equal(summary.omitted_historical_count, 1);
      assert.equal(summary.summaries.length, 1);
      assert.equal(summary.summaries[0]?.name, 'newer-artifact');
      assert.equal(summary.newest_artifact_updated_at, summary.summaries[0]?.artifact_updated_at);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('supports current-run selection window around the newest artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-extract-debug-run-'));
    const now = Date.now();
    try {
      await createArtifactDir(root, 'run-a', now - 5_000);
      await createArtifactDir(root, 'run-b', now - 15_000);
      await createArtifactDir(root, 'historical', now - 10 * 60_000);

      const summary = await summarizeArtifactDir(root, '', {
        currentRun: true,
        currentRunWindowMs: 30_000,
      });
      assert.equal(summary.selection_mode, 'current_run');
      assert.equal(summary.total_matching_dirs, 3);
      assert.equal(summary.omitted_historical_count, 1);
      assert.deepEqual(summary.summaries.map((entry) => entry.name), ['run-a', 'run-b']);
      assert.equal(summary.current_run_window_ms, 30_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('parses CLI options for current-run and latest selection', () => {
    const options = parseExtractTestDebugOptions([
      '--root', '/tmp/debug-root',
      '--filter', 'watcher',
      '--latest', '3',
      '--current-run',
      '--current-run-window-ms', '45000',
    ], '/workspace');

    assert.equal(options.root, '/tmp/debug-root');
    assert.equal(options.filter, 'watcher');
    assert.equal(options.latest, 3);
    assert.equal(options.currentRun, true);
    assert.equal(options.currentRunWindowMs, 45_000);
    assert.equal(options.help, false);
  });
});
