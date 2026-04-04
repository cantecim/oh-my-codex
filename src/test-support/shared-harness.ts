import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { collectTrackedEnv, recordEnvMutation, recordTempDirFixtureCreated, recordTempDirFixtureFinished } from './fixture-debug.js';
import { appendDebugJsonl, isTestDebugEnabled, resolveDebugTestId, writeDebugJson } from '../debug/test-debug.js';

const INHERITED_TEST_ENV_KEYS = [
  'OMX_TEST_DEBUG',
  'OMX_TEST_ARTIFACTS_DIR',
  'OMX_TEST_DEBUG_TEST_ID',
  'OMX_TEST_TRACE_ID',
  'OMX_TEST_CAPTURE_FILE',
  'OMX_TEST_CAPTURE_SEQUENCE_FILE',
  'OMX_TEST_CAPTURE_COUNTER_FILE',
];

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
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -a) allPanes=1; shift ;;
      -s) sessionPanes=1; shift ;;
      -F) shift 2 ;;
      -t) shift 2 ;;
      *) shift ;;
    esac
  done
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
): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    HOME: currentHomeDir(),
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
    TZ: process.env.TZ,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    TERM: process.env.TERM,
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
    PATHEXT: process.env.PATHEXT,
    windir: process.env.windir,
    OMX_TEAM_WORKER: '',
    OMX_TEAM_STATE_ROOT: '',
    OMX_TEAM_LEADER_CWD: '',
    OMX_MODEL_INSTRUCTIONS_FILE: '',
    OMX_TEST_DEBUG: process.env.OMX_TEST_DEBUG,
    OMX_TEST_ARTIFACTS_DIR: process.env.OMX_TEST_ARTIFACTS_DIR,
    OMX_TEST_DEBUG_TEST_ID: process.env.OMX_TEST_DEBUG_TEST_ID,
    TMUX: '',
    TMUX_PANE: '',
    ...overrides,
  };

  for (const key of INHERITED_TEST_ENV_KEYS) {
    const value = process.env[key];
    if (env[key] === undefined && typeof value === 'string') env[key] = value;
  }

  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
}
