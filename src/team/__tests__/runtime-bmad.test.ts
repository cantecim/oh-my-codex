import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { startTeam, shutdownTeam, type TeamRuntime } from '../runtime.js';
import { buildIsolatedEnv } from '../../test-support/shared-harness.js';

describe('team runtime BMAD contract', () => {
  it('injects BMAD-aware worker context into detached worktree instructions', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'team-detached-worktree-paths-'));
    const binDir = await mkdtemp(join(tmpdir(), 'omx-runtime-bmad-bin-'));
    const fakeCodexPath = join(binDir, 'codex');
    const outputRoot = '_bmad-output';
    let runtime: TeamRuntime | null = null;
    try {
      execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' });
      await writeFile(join(repo, 'README.md'), '# Team Runtime BMAD\n', 'utf-8');
      execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'init repo'], { cwd: repo, stdio: 'ignore' });
      await writeFile(
        fakeCodexPath,
        `#!/usr/bin/env node
process.stdin.resume();
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
`,
        { mode: 0o755 },
      );
      mock.method(process, 'cwd', () => repo);

      runtime = await startTeam(
        'leader-fixed',
        'task',
        'executor',
        1,
        [{ subject: 's', description: 'd', owner: 'worker-1' }],
        repo,
        {
          worktreeMode: { enabled: true, detached: true, name: null },
          leaderEnvSnapshot: buildIsolatedEnv({
            PATH: binDir,
            TMUX: undefined,
            OMX_TEAM_WORKER: undefined,
            OMX_TEAM_WORKER_LAUNCH_MODE: 'prompt',
            OMX_TEAM_WORKER_CLI: 'codex',
          }),
          bmadContext: {
            detected: true,
            outputRoot,
            projectContextPath: `${outputRoot}/project-context.md`,
            architecturePaths: [`${outputRoot}/planning-artifacts/architecture.md`],
            activeStoryPath: `${outputRoot}/planning-artifacts/epics/story-login.md`,
            activeEpicPath: `${outputRoot}/planning-artifacts/epics/epic-auth.md`,
            storyAcceptanceCriteria: ['user can log in'],
            sprintStatusPath: `${outputRoot}/implementation-artifacts/sprint-status.yaml`,
            implementationArtifactsRoot: `${outputRoot}/implementation-artifacts`,
            contextBlockedByAmbiguity: false,
            writebackSupported: true,
            writebackBlockedByDrift: false,
          },
        },
      );

      const workerPath = runtime.config.workers[0]?.worktree_path;
      assert.ok(workerPath);
      const rootAgents = await readFile(join(workerPath!, 'AGENTS.md'), 'utf-8');
      assert.match(rootAgents, /BMAD-aware team context is active/i);
      assert.match(rootAgents, /active story: _bmad-output\/planning-artifacts\/epics\/story-login\.md/i);
    } finally {
      if (runtime) {
        await shutdownTeam(runtime.teamName, repo, { force: true }).catch(() => {});
      }
      mock.restoreAll();
      await rm(binDir, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });
});
