import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TempTmuxSessionFixture {
  sessionName: string;
  serverName: string;
  windowTarget: string;
  leaderPaneId: string;
  socketPath: string;
  serverKind: 'ambient' | 'synthetic';
  env: {
    TMUX: string;
    TMUX_PANE: string;
  };
  sessionExists: (targetSessionName?: string) => boolean;
}

export interface TempTmuxSessionOptions {
  useAmbientServer?: boolean;
}

function scrubTmuxEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...source,
    TMUX: undefined,
    TMUX_PANE: undefined,
  };
}

function runTmuxCommand(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  serverName?: string,
): string {
  const argv = serverName ? ['-L', serverName, ...args] : args;
  const result = spawnSync('tmux', argv, {
    encoding: 'utf-8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || '').trim() || `tmux exited ${result.status}`);
  }
  return (result.stdout || '').trim();
}

export function runAmbientTmux(args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return runTmuxCommand(args, scrubTmuxEnv(env));
}

function runFixtureServerTmux(
  args: string[],
  serverName?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return runTmuxCommand(args, scrubTmuxEnv(env), serverName);
}

export function isRealTmuxAvailable(): boolean {
  try {
    runAmbientTmux(['-V']);
    return true;
  } catch {
    return false;
  }
}

export function ambientTmuxSessionExists(sessionName: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    runAmbientTmux(['has-session', '-t', sessionName], env);
    return true;
  } catch {
    return false;
  }
}

export function tmuxSessionExists(sessionName: string, serverName?: string): boolean {
  try {
    runFixtureServerTmux(['has-session', '-t', sessionName], serverName);
    return true;
  } catch {
    return false;
  }
}

function uniqueTmuxIdentifier(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function withTempTmuxSession<T>(
  optionsOrFn: TempTmuxSessionOptions | ((fixture: TempTmuxSessionFixture) => Promise<T> | T),
  maybeFn?: (fixture: TempTmuxSessionFixture) => Promise<T> | T,
): Promise<T> {
  if (!isRealTmuxAvailable()) {
    throw new Error('tmux is not available');
  }

  const options = typeof optionsOrFn === 'function' ? {} : optionsOrFn;
  const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn;
  if (!fn) {
    throw new Error('withTempTmuxSession requires a callback');
  }

  const fixtureCwd = await mkdtemp(join(tmpdir(), 'omx-tmux-fixture-'));
  const sessionName = uniqueTmuxIdentifier('omx-test');
  const serverName = options.useAmbientServer ? '' : uniqueTmuxIdentifier('omx-fixture');
  const serverKind: TempTmuxSessionFixture['serverKind'] = options.useAmbientServer ? 'ambient' : 'synthetic';

  const created = runFixtureServerTmux([
    'new-session',
    '-d',
    '-P',
    '-F',
    '#{session_name}:#{window_index} #{pane_id}',
    '-s',
    sessionName,
    '-c',
    fixtureCwd,
    'sleep 300',
  ], serverName || undefined);
  const [windowTarget = '', leaderPaneId = ''] = created.split(/\s+/, 2);
  if (windowTarget === '' || leaderPaneId === '') {
    try {
      if (serverKind === 'synthetic') {
        runFixtureServerTmux(['kill-server'], serverName || undefined);
      } else {
        runFixtureServerTmux(['kill-session', '-t', sessionName], serverName || undefined);
      }
    } catch {}
    await rm(fixtureCwd, { recursive: true, force: true });
    throw new Error(`failed to create temporary tmux fixture: ${created}`);
  }

  const socketPath = runFixtureServerTmux(
    ['display-message', '-p', '-t', leaderPaneId, '#{socket_path}'],
    serverName || undefined,
  );
  const fixtureEnv = {
    TMUX: `${socketPath},${process.pid},0`,
    TMUX_PANE: leaderPaneId,
  } satisfies { TMUX: string; TMUX_PANE: string };

  const fixture: TempTmuxSessionFixture = {
    sessionName,
    serverName,
    windowTarget,
    leaderPaneId,
    socketPath,
    serverKind,
    env: {
      TMUX: fixtureEnv.TMUX,
      TMUX_PANE: fixtureEnv.TMUX_PANE,
    },
    sessionExists: (targetSessionName = sessionName) => tmuxSessionExists(targetSessionName, serverName || undefined),
  };

  try {
    return await fn(fixture);
  } finally {
    try {
      if (serverKind === 'synthetic') {
        runFixtureServerTmux(['kill-server'], serverName || undefined);
      } else {
        runFixtureServerTmux(['kill-session', '-t', sessionName], serverName || undefined);
      }
    } catch {}
    await rm(fixtureCwd, { recursive: true, force: true });
  }
}
