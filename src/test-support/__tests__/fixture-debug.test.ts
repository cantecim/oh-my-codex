import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildFixtureDebugChildEnv,
  recordTempDirFixtureCreated,
  recordTempDirFixtureFinished,
  writeFixtureArtifactManifest,
} from '../fixture-debug.js';

describe('fixture-debug ownership contract', () => {
  it('builds debug child env only from the canonical fixture debug contract', () => {
    const cwd = '/tmp/fixture-cwd';
    const env = buildFixtureDebugChildEnv(cwd, {
      OMX_TEST_DEBUG: '1',
      OMX_TEST_ARTIFACTS_DIR: '/tmp/artifacts',
      OMX_TEST_DEBUG_TEST_ID: 'fixture-id',
      OMX_TEST_TRACE_ID: 'trace-123',
    });

    assert.deepEqual(env, {
      OMX_TEST_DEBUG: '1',
      OMX_TEST_ARTIFACTS_DIR: '/tmp/artifacts',
      OMX_TEST_DEBUG_TEST_ID: 'fixture-id',
    });
    assert.deepEqual(buildFixtureDebugChildEnv(cwd, {}), {});
  });

  it('preserves fixture artifact schema through the fixture-debug owner surface', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-fixture-debug-root-'));
    const cwd = await mkdtemp(join(tmpdir(), 'omx-fixture-debug-cwd-'));
    const env = {
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      OMX_TEST_DEBUG: '1',
      OMX_TEST_ARTIFACTS_DIR: root,
      OMX_TEST_DEBUG_TEST_ID: 'fixture-debug-id',
      OMX_TEST_TRACE_ID: 'trace-123',
    } satisfies NodeJS.ProcessEnv;

    try {
      await recordTempDirFixtureCreated(cwd, 'omx-fixture-', env);
      const testManifestPath = await writeFixtureArtifactManifest(cwd, {
        fixture_kind: 'unit-test',
      }, env);
      await recordTempDirFixtureFinished(cwd, env);

      const artifactDir = join(root, 'fixture-debug-id');
      const files = await readdir(artifactDir);
      assert.ok(files.includes('manifest.json'));
      assert.ok(files.includes('env.json'));
      assert.ok(files.includes('paths.json'));
      assert.ok(files.includes('test-manifest.json'));
      assert.ok(files.includes('env-before.json'));
      assert.ok(files.includes('env-after.json'));
      assert.ok(files.includes('env-diff.json'));
      assert.ok(files.includes('lifecycle.jsonl'));
      assert.equal(testManifestPath, join(artifactDir, 'test-manifest.json'));

      const manifest = JSON.parse(await readFile(join(artifactDir, 'manifest.json'), 'utf-8')) as Record<string, unknown>;
      const paths = JSON.parse(await readFile(join(artifactDir, 'paths.json'), 'utf-8')) as Record<string, unknown>;
      const testManifest = JSON.parse(await readFile(join(artifactDir, 'test-manifest.json'), 'utf-8')) as Record<string, unknown>;
      const envBefore = JSON.parse(await readFile(join(artifactDir, 'env-before.json'), 'utf-8')) as Record<string, unknown>;
      const envAfter = JSON.parse(await readFile(join(artifactDir, 'env-after.json'), 'utf-8')) as Record<string, unknown>;
      const envDiff = JSON.parse(await readFile(join(artifactDir, 'env-diff.json'), 'utf-8')) as Record<string, unknown>;
      const lifecycle = (await readFile(join(artifactDir, 'lifecycle.jsonl'), 'utf-8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      assert.equal(manifest.type, 'temp_dir_fixture');
      assert.equal(manifest.prefix, 'omx-fixture-');
      assert.equal(manifest.test_id, 'fixture-debug-id');
      assert.equal(paths.cwd, cwd);
      assert.equal(paths.debug_artifact_dir, artifactDir);
      assert.equal(testManifest.cwd, cwd);
      assert.equal(testManifest.fixture_kind, 'unit-test');
      assert.equal(envBefore.OMX_TEST_TRACE_ID, 'trace-123');
      assert.equal(envAfter.OMX_TEST_TRACE_ID, 'trace-123');
      assert.deepEqual(envDiff, {});
      assert.deepEqual(
        lifecycle.map((entry) => entry.type),
        ['temp_dir_created', 'temp_dir_cleanup_skipped_debug', 'temp_dir_preserved'],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
