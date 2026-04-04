import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';

export async function withTempDir<T>(
  prefix: string,
  run: (dir: string) => Promise<T> | T,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
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

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf-8')) as T;
}

export async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  run: () => Promise<T> | T,
): Promise<T> {
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
  return `if [[ "${varName}" == "1" ]]; then
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
echo "$@" >> "${tmuxLogPath}"
cmd="$1"
shift || true
if [[ "$cmd" == "capture-pane" ]]; then
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
  allPanes=0
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -a) allPanes=1; shift ;;
      -F) shift 2 ;;
      -t) shift 2 ;;
      *) shift ;;
    esac
  done
  ${buildListPaneBlock('allPanes', options.allPaneLines)}
  printf "%b\\n" "${escapePrintf((options.listPaneLines ?? ['%1 12345']).join('\\n'))}"
  exit 0
fi
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
    TMUX: '',
    TMUX_PANE: '',
    ...overrides,
  };

  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
}

