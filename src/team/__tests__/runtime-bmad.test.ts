import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startTeam } from '../runtime.js';

describe.skip('team runtime BMAD contract', () => {
  it('injects BMAD-aware worker context into detached worktree instructions', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'team-detached-worktree-paths-'));
    try {
      await mkdir(join(repo, '.git'), { recursive: true });
      mock.method(process, 'cwd', () => repo);

      const runtime = await startTeam(
        'leader-fixed',
        'task',
        'executor',
        1,
        [{ subject: 's', description: 'd', owner: 'worker-1' }],
        repo,
        {
          worktreeMode: { enabled: true, detached: true, name: null },
          bmadContext: {
            detected: true,
            outputRoot: '_bmad-output',
            projectContextPath: '_bmad-output/project-context.md',
            architecturePaths: ['_bmad-output/planning-artifacts/architecture.md'],
            activeStoryPath: '_bmad-output/planning-artifacts/epics/story-login.md',
            activeEpicPath: '_bmad-output/planning-artifacts/epics/epic-auth.md',
            storyAcceptanceCriteria: ['user can log in'],
            sprintStatusPath: '_bmad-output/implementation-artifacts/sprint-status.yaml',
            implementationArtifactsRoot: '_bmad-output/implementation-artifacts',
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
      mock.restoreAll();
      await rm(repo, { recursive: true, force: true });
    }
  });
});
