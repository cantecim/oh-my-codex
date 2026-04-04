#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

function argValue(name: string, fallback = ''): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

const repoRoot = process.cwd();
const testFile = resolve(repoRoot, 'dist', 'hooks', '__tests__', 'notify-hook-tmux-heal.test.js');
const artifactRoot = resolve(argValue('--artifacts-root', join(repoRoot, '.omx', 'test-artifacts', 'tmux-heal-drift')));
const variant = argValue('--variant', 'base').trim().toLowerCase() || 'base';
const testPatternsByVariant: Record<string, string[]> = {
  base: [
    'skips injection when fallback pane cwd does not match hook cwd \\(isolated env\\)',
    'heals a stale HUD pane target back to the canonical codex pane \\(isolated env\\)',
    'prefers active mode state tmux_pane_id when present',
    'prefers scoped active mode state over global mode state for tmux pane selection',
  ],
  extended: [
    'skips injection when fallback pane cwd does not match hook cwd \\(isolated env\\)',
    'heals a stale HUD pane target back to the canonical codex pane \\(isolated env\\)',
    'prefers active mode state tmux_pane_id when present',
    'prefers scoped active mode state over global mode state for tmux pane selection',
    'skips injection when the resolved pane is still busy',
  ],
};
const selectedPatterns = testPatternsByVariant[variant] || testPatternsByVariant.base;
const testPattern = selectedPatterns.join('|');

const result = spawnSync(process.execPath, [
  '--test',
  '--test-name-pattern',
  testPattern,
  testFile,
], {
  cwd: repoRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    OMX_TEST_DEBUG: '1',
    OMX_TEST_ARTIFACTS_DIR: artifactRoot,
  },
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
