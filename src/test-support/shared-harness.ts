import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { collectTrackedEnv, recordEnvMutation, recordTempDirFixtureCreated, recordTempDirFixtureFinished } from './fixture-debug.js';
import { appendDebugJsonl, isTestDebugEnabled, resolveDebugTestId, writeDebugJson } from '../debug/test-debug.js';

// Intentional test-only whitelist. These are the only OMX_TEST_* keys that
// auto-forward through the isolation contract.
export const AUTO_FORWARDED_TEST_ENV_KEYS = [
  'OMX_TEST_DEBUG',
  'OMX_TEST_ARTIFACTS_DIR',
  'OMX_TEST_DEBUG_TEST_ID',
  'OMX_TEST_TRACE_ID',
  'OMX_TEST_CAPTURE_FILE',
  'OMX_TEST_CAPTURE_SEQUENCE_FILE',
  'OMX_TEST_CAPTURE_COUNTER_FILE',
  'OMX_TEST_REPO_ROOT',
] as const;

// Runtime-affecting env that should never leak implicitly between tests.
// These are reset-by-default and only flow to children via explicit overrides.
export const RESET_BY_DEFAULT_RUNTIME_ENV_KEYS = [
  'TMUX',
  'TMUX_PANE',
  'OMX_TEAM_WORKER',
  'OMX_TEAM_STATE_ROOT',
  'OMX_TEAM_LEADER_CWD',
  'OMX_MODEL_INSTRUCTIONS_FILE',
] as const;

// Runtime selectors that remain opt-in even though the base isolated env still
// preserves host PATH compatibility. Tests must pass these explicitly when they
// intend to exercise an alternate transport/runtime path.
export const EXPLICIT_RUNTIME_ENV_KEYS = [
  'PATH',
  'OMX_RUNTIME_BINARY',
  'CODEX_HOME',
] as const;

export async function withTempDir<T>(
  prefix: string,
  run: (dir: string) => Promise<T> | T,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const debugEnabled = isTestDebugEnabled();
  await recordTempDirFixtureCreated(dir, prefix);
  try {
    return await run(dir);
  } finally {
    if (debugEnabled) {
      await recordTempDirFixtureFinished(dir);
    } else {
      await appendDebugJsonl(dir, 'lifecycle.jsonl', {
        type: 'temp_dir_cleanup_started',
        cwd: resolve(dir),
      }).catch(() => {});
      await rm(dir, { recursive: true, force: true });
      await appendDebugJsonl(dir, 'lifecycle.jsonl', {
        type: 'temp_dir_cleanup_finished',
        cwd: resolve(dir),
      }).catch(() => {});
    }
  }
}

export async function withTempHome<T>(
  prefix: string,
  run: (homeDir: string) => Promise<T> | T,
): Promise<T> {
  return withTempDir(prefix, run);
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

export async function writeTestArtifactManifest(
  cwd: string,
  manifest: Record<string, unknown>,
): Promise<string | null> {
  return await writeDebugJson(cwd, 'test-manifest.json', {
    cwd: resolve(cwd),
    ...manifest,
  });
}

export function buildDebugChildEnv(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (!isTestDebugEnabled(env)) return {};
  const debugEnv: Record<string, string> = {
    OMX_TEST_DEBUG: '1',
  };
  const explicitTestId = typeof env.OMX_TEST_DEBUG_TEST_ID === 'string' ? env.OMX_TEST_DEBUG_TEST_ID.trim() : '';
  debugEnv.OMX_TEST_DEBUG_TEST_ID = explicitTestId || resolveDebugTestId(cwd, env);
  if (typeof env.OMX_TEST_ARTIFACTS_DIR === 'string' && env.OMX_TEST_ARTIFACTS_DIR.trim() !== '') {
    debugEnv.OMX_TEST_ARTIFACTS_DIR = env.OMX_TEST_ARTIFACTS_DIR;
  }
  return debugEnv;
}

export function buildChildEnv(
  cwd: string,
  overrides: Record<string, string | undefined> = {},
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return buildIsolatedEnv({
    ...buildDebugChildEnv(cwd, env),
    ...overrides,
  }, env);
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf-8')) as T;
}

export async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  run: () => Promise<T> | T,
): Promise<T> {
  const debugEnabled = isTestDebugEnabled();
  const cwd = process.cwd();
  const beforeSnapshot = debugEnabled ? collectTrackedEnv() : null;
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await recordEnvMutation(cwd, debugEnabled ? beforeSnapshot : null);
  }
}

export function createEnvResetHooks(
  keys: string[],
  env: NodeJS.ProcessEnv = process.env,
): { beforeEachHook: () => void; afterEachHook: () => void } {
  const original = new Map<string, string | undefined>();
  for (const key of keys) {
    original.set(key, env[key]);
  }

  return {
    beforeEachHook: () => {
      for (const key of keys) delete env[key];
    },
    afterEachHook: () => {
      for (const key of keys) {
        const value = original.get(key);
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
    },
  };
}

export async function withWorkingDir<T>(
  cwd: string,
  run: () => Promise<T> | T,
): Promise<T> {
  const previousCwd = process.cwd();
  process.chdir(cwd);
  try {
    return await run();
  } finally {
    process.chdir(previousCwd);
  }
}

function quoteBash(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function escapePrintf(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

export interface FakeTmuxProbeConfig {
  paneId?: string;
  paneInMode?: string;
  currentCommand?: string;
  startCommand?: string;
  currentPath?: string;
  sessionName?: string;
}

export interface FakeTmuxScriptOptions {
  defaultProbe?: FakeTmuxProbeConfig;
  paneProbes?: Record<string, FakeTmuxProbeConfig>;
  listPaneLines?: string[];
  sessionPaneLines?: string[];
  allPaneLines?: string[];
  listPaneTargets?: Record<string, string[]>;
  captureOutput?: string;
  captureSequence?: string[];
  failSendKeys?: boolean;
  failSendKeysMatch?: string;
  unsupportedExitCode?: 0 | 1;
}

function buildProbeCondition(format: string, value: string, target?: string): string {
  const formatCheck = `[[ "$format" == ${quoteBash(format)} ]]`;
  const targetCheck = typeof target === 'string'
    ? ` && [[ "$target" == ${quoteBash(target)} ]]`
    : '';
  return `if ${formatCheck}${targetCheck}; then\n    printf "%s\\n" ${quoteBash(value)}\n    exit 0\n  fi`;
}

function buildProbeBlocks(options: FakeTmuxScriptOptions): string {
  const lines: string[] = [];
  const defaultProbe = options.defaultProbe ?? {};
  const paneProbes = options.paneProbes ?? {};

  for (const [target, probe] of Object.entries(paneProbes)) {
    if (probe.paneInMode !== undefined) lines.push(buildProbeCondition('#{pane_in_mode}', probe.paneInMode, target));
    if (probe.currentCommand !== undefined) lines.push(buildProbeCondition('#{pane_current_command}', probe.currentCommand, target));
    if (probe.startCommand !== undefined) lines.push(buildProbeCondition('#{pane_start_command}', probe.startCommand, target));
    if (probe.currentPath !== undefined) lines.push(buildProbeCondition('#{pane_current_path}', probe.currentPath, target));
    if (probe.sessionName !== undefined) lines.push(buildProbeCondition('#S', probe.sessionName, target));
    if (probe.paneId !== undefined) lines.push(buildProbeCondition('#{pane_id}', probe.paneId, target));
  }

  if (defaultProbe.paneInMode !== undefined) lines.push(buildProbeCondition('#{pane_in_mode}', defaultProbe.paneInMode));
  if (defaultProbe.currentCommand !== undefined) lines.push(buildProbeCondition('#{pane_current_command}', defaultProbe.currentCommand));
  if (defaultProbe.startCommand !== undefined) lines.push(buildProbeCondition('#{pane_start_command}', defaultProbe.startCommand));
  if (defaultProbe.currentPath !== undefined) lines.push(buildProbeCondition('#{pane_current_path}', defaultProbe.currentPath));
  if (defaultProbe.sessionName !== undefined) lines.push(buildProbeCondition('#S', defaultProbe.sessionName));
  if (defaultProbe.paneId !== undefined) lines.push(buildProbeCondition('#{pane_id}', defaultProbe.paneId));

  lines.push(`if [[ "$format" == "#{pane_id}" && -n "$target" ]]; then
    printf "%s\\n" "$target"
    exit 0
  fi`);

  return lines.join('\n  ');
}

function buildListPaneBlock(varName: string, values: string[] | undefined): string {
  if (!values || values.length === 0) {
    return '';
  }
  const escaped = values.map((value) => escapePrintf(value)).join('\\n');
  return `if [[ "$${varName}" == "1" ]]; then
    printf "%b\\n" "${escaped}"
    exit 0
  fi`;
}

function buildTargetedListPaneBlocks(targets: Record<string, string[]> | undefined): string {
  if (!targets) return '';
  const blocks: string[] = [];
  for (const [target, values] of Object.entries(targets)) {
    if (!values || values.length === 0) continue;
    const escaped = values.map((value) => escapePrintf(value)).join('\\n');
    blocks.push(`if [[ "$target" == ${quoteBash(target)} ]]; then
    printf "%b\\n" "${escaped}"
    exit 0
  fi`);
  }
  return blocks.join('\n  ');
}

export function buildFakeTmuxScript(
  tmuxLogPath: string,
  options: FakeTmuxScriptOptions = {},
): string {
  const failSendKeys = options.failSendKeys === true ? '1' : '0';
  const failSendKeysMatch = options.failSendKeysMatch ? quoteBash(options.failSendKeysMatch) : '""';
  const unsupportedExitCode = options.unsupportedExitCode ?? 0;
  const tmuxMetaPath = `${tmuxLogPath}.meta.jsonl`;
  const defaultListPaneLines = options.listPaneLines ?? ['%1 12345'];
  const defaultListPaneBlock = buildListPaneBlock('__tmux_default_list_panes', defaultListPaneLines);
  const targetedListPaneBlocks = buildTargetedListPaneBlocks(options.listPaneTargets);
  const captureOutput = options.captureOutput ? quoteBash(options.captureOutput) : '""';
  const captureSequence = options.captureSequence ?? [];
  const captureSequenceLines = captureSequence.map((line) => quoteBash(line)).join(' ');
  const defaultProbe: FakeTmuxProbeConfig = {
    paneInMode: '0',
    currentCommand: 'codex',
    startCommand: 'codex --model gpt-5',
    currentPath: dirname(tmuxLogPath),
    sessionName: 'session-test',
    ...options.defaultProbe,
  };

  return `#!/usr/bin/env bash
set -eu
if [[ ! -f "${tmuxLogPath}" ]]; then : > "${tmuxLogPath}"; fi
if [[ ! -f "${tmuxMetaPath}" ]]; then : > "${tmuxMetaPath}"; fi
__tmux_exit_code=0
__tmux_branch="startup"
__tmux_cmd=""
__tmux_meta() {
  printf '{"timestamp":"%s","pid":%s,"ppid":%s,"cwd":"%s","cmd":"%s","branch":"%s","exit_code":%s,"invocation_id":"%s","command_role":"%s","raw_args_preview":"(see tmux.log)"}\\n' \
    "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    "$$" \
    "$PPID" \
    "$PWD" \
    "$__tmux_cmd" \
    "$__tmux_branch" \
    "$__tmux_exit_code" \
    "\${OMX_TEST_TMUX_INVOCATION_ID:-}" \
    "\${OMX_TEST_TMUX_COMMAND_ROLE:-}" >> "${tmuxMetaPath}"
}
trap '__tmux_exit_code=$?; __tmux_meta' EXIT
echo "$@" >> "${tmuxLogPath}"
cmd="$1"
__tmux_cmd="$cmd"
shift || true
if [[ "$cmd" == "capture-pane" ]]; then
  __tmux_branch="capture-pane"
  # OMX_TEST_CAPTURE_* is an intentional test contract. These are not runtime
  # selectors and are the only ambient env inputs this helper is allowed to
  # read without per-call options.
  if [[ -n "\${OMX_TEST_CAPTURE_SEQUENCE_FILE:-}" && -f "\${OMX_TEST_CAPTURE_SEQUENCE_FILE}" ]]; then
    counterFile="\${OMX_TEST_CAPTURE_COUNTER_FILE:-\${OMX_TEST_CAPTURE_SEQUENCE_FILE}.idx}"
    idx=0
    if [[ -f "$counterFile" ]]; then idx="$(cat "$counterFile")"; fi
    lineNo=$((idx + 1))
    line="$(sed -n "\${lineNo}p" "\${OMX_TEST_CAPTURE_SEQUENCE_FILE}" || true)"
    if [[ -z "$line" ]]; then
      line="$(tail -n 1 "\${OMX_TEST_CAPTURE_SEQUENCE_FILE}" || true)"
    fi
    printf "%s\\n" "$line"
    echo "$lineNo" > "$counterFile"
    exit 0
  fi
  if [[ -n "\${OMX_TEST_CAPTURE_FILE:-}" && -f "\${OMX_TEST_CAPTURE_FILE}" ]]; then
    cat "\${OMX_TEST_CAPTURE_FILE}"
    exit 0
  fi
  if [[ ${captureSequence.length} -gt 0 ]]; then
    counterFile="\${OMX_TEST_CAPTURE_COUNTER_FILE:-${tmuxLogPath}.capture.idx}"
    idx=0
    if [[ -f "$counterFile" ]]; then idx="$(cat "$counterFile")"; fi
    __capture_sequence=( ${captureSequenceLines} )
    if (( idx >= \${#__capture_sequence[@]} )); then
      idx=$(( \${#__capture_sequence[@]} - 1 ))
    fi
    if (( idx >= 0 )); then
      printf "%s\\n" "\${__capture_sequence[$idx]}"
      echo "$((idx + 1))" > "$counterFile"
      exit 0
    fi
  fi
  if [[ -n ${captureOutput} ]]; then
    printf "%s" ${captureOutput}
  fi
  exit 0
fi
if [[ "$cmd" == "display-message" ]]; then
  __tmux_branch="display-message"
  target=""
  format=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  ${buildProbeBlocks({ ...options, defaultProbe })}
  exit 0
fi
if [[ "$cmd" == "send-keys" ]]; then
  __tmux_branch="send-keys"
  sendKeysArgs="$*"
  if [[ "${failSendKeys}" == "1" ]]; then
    echo "send failed" >&2
    exit 1
  fi
  if [[ -n ${failSendKeysMatch} && "$sendKeysArgs" == *${failSendKeysMatch}* ]]; then
    echo "send failed" >&2
    exit 1
  fi
  exit 0
fi
if [[ "$cmd" == "list-panes" ]]; then
  __tmux_branch="list-panes"
  __tmux_default_list_panes=1
  allPanes=0
  sessionPanes=0
  target=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -a) allPanes=1; shift ;;
      -s) sessionPanes=1; shift ;;
      -F) shift 2 ;;
      -t) target="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  ${targetedListPaneBlocks}
  ${buildListPaneBlock('allPanes', options.allPaneLines)}
  ${buildListPaneBlock('sessionPanes', options.sessionPaneLines ?? options.listPaneLines)}
  ${defaultListPaneBlock}
fi
__tmux_branch="fallback"
exit ${unsupportedExitCode}
`;
}

function currentHomeDir(): string {
  return homedir();
}

export function buildIsolatedEnv(
  overrides: Record<string, string | undefined> = {},
  inheritedEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const isolatedEnv: Record<string, string | undefined> = {
    HOME: currentHomeDir(),
    PATH: inheritedEnv.PATH,
    TMPDIR: inheritedEnv.TMPDIR,
    TMP: inheritedEnv.TMP,
    TEMP: inheritedEnv.TEMP,
    TZ: inheritedEnv.TZ,
    LANG: inheritedEnv.LANG,
    LC_ALL: inheritedEnv.LC_ALL,
    TERM: inheritedEnv.TERM,
    SystemRoot: inheritedEnv.SystemRoot,
    ComSpec: inheritedEnv.ComSpec,
    PATHEXT: inheritedEnv.PATHEXT,
    windir: inheritedEnv.windir,
    OMX_TEAM_WORKER: '',
    OMX_TEAM_STATE_ROOT: '',
    OMX_TEAM_LEADER_CWD: '',
    OMX_MODEL_INSTRUCTIONS_FILE: '',
    OMX_TEST_DEBUG: inheritedEnv.OMX_TEST_DEBUG,
    OMX_TEST_ARTIFACTS_DIR: inheritedEnv.OMX_TEST_ARTIFACTS_DIR,
    OMX_TEST_DEBUG_TEST_ID: inheritedEnv.OMX_TEST_DEBUG_TEST_ID,
    TMUX: '',
    TMUX_PANE: '',
    ...overrides,
  };

  for (const key of AUTO_FORWARDED_TEST_ENV_KEYS) {
    const value = inheritedEnv[key];
    if (isolatedEnv[key] === undefined && typeof value === 'string') isolatedEnv[key] = value;
  }

  return Object.fromEntries(Object.entries(isolatedEnv).filter(([, value]) => value !== undefined));
}
