import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildFakeTmuxScript,
  buildChildEnv,
  readJson,
  withTempDir,
  writeTestArtifactManifest,
  writeJson,
} from "../../test-support/shared-harness.js";

const NOTIFY_HOOK_SCRIPT = new URL(
  "../../../dist/scripts/notify-hook.js",
  import.meta.url,
);

const withTempWorkingDir = (
  run: (cwd: string) => Promise<void>,
): Promise<void> => withTempDir("omx-notify-tmux-heal-", run);

function runTmuxHealNotifyHook(
  cwd: string,
  fakeBinDir: string,
  payloadOverrides: Record<string, unknown> = {},
  extraEnv: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  const payload = {
    cwd,
    type: "agent-turn-complete",
    "thread-id": "thread-test",
    "turn-id": `turn-${Date.now()}`,
    "input-messages": ["no marker here"],
    "last-assistant-message": "output",
    ...payloadOverrides,
  };

  return spawnSync(
    process.execPath,
    [NOTIFY_HOOK_SCRIPT.pathname, JSON.stringify(payload)],
    {
      cwd,
      encoding: "utf8",
      env: buildChildEnv(cwd, {
        PATH: `${fakeBinDir}:${process.env.PATH || ""}`,
        OMX_TEAM_WORKER: "",
        ...extraEnv,
      }),
    },
  );
}

async function prepareTmuxHealHarness(
  cwd: string,
  fakeBinDir: string,
  manifest: Record<string, unknown> = {},
): Promise<{ fakeTmuxPath: string; tmuxLogPath: string }> {
  const fakeTmuxPath = join(fakeBinDir, "tmux");
  const tmuxLogPath = join(cwd, "tmux.log");
  await writeFile(tmuxLogPath, "");
  await writeTestArtifactManifest(cwd, {
    suite: "notify-hook-tmux-heal",
    fake_tmux_path: fakeTmuxPath,
    tmux_log_path: tmuxLogPath,
    ...manifest,
  });
  return { fakeTmuxPath, tmuxLogPath };
}

function buildFakeTmuxHealScript(
  tmuxLogPath: string,
  options: Parameters<typeof buildFakeTmuxScript>[1] = {},
): string {
  return buildFakeTmuxScript(tmuxLogPath, {
    listPaneLines: [],
    unsupportedExitCode: 1,
    ...options,
  });
}

describe("notify-hook tmux target healing", () => {
  it("falls back to global mode state when scoped session has no allowed active mode", async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, ".omx");
      const stateDir = join(omxDir, "state");
      const logsDir = join(omxDir, "logs");
      const sessionId = "omx-abc123";
      const sessionStateDir = join(stateDir, "sessions", sessionId);
      const fakeBinDir = join(cwd, "fake-bin");
      const configPath = join(omxDir, "tmux-hook.json");
      const hookStatePath = join(stateDir, "tmux-hook-state.json");

      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      const { fakeTmuxPath, tmuxLogPath } = await prepareTmuxHealHarness(
        cwd,
        fakeBinDir,
        {
          case: "cwd-mismatch-fallback-pane",
        },
      );

      await writeJson(join(stateDir, "session.json"), {
        session_id: sessionId,
      });
      await writeJson(join(sessionStateDir, "team-state.json"), {
        active: true,
        current_phase: "team-exec",
      });
      await writeJson(join(stateDir, "ralph-state.json"), {
        active: true,
        iteration: 0,
      });
      await writeJson(configPath, {
        enabled: true,
        target: { type: "pane", value: "%42" },
        allowed_modes: ["ralph"],
        cooldown_ms: 0,
        max_injections_per_session: 10,
        prompt_template: "Continue [OMX_TMUX_INJECT]",
        marker: "[OMX_TMUX_INJECT]",
        dry_run: false,
        log_level: "debug",
      });

      const fakeTmux = buildFakeTmuxHealScript(tmuxLogPath, {
        paneProbes: {
          "%42": {
            paneId: "%42",
            currentCommand: "codex",
            paneInMode: "0",
          },
        },
      });
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      const result = runTmuxHealNotifyHook(cwd, fakeBinDir, {
        session_id: sessionId,
        "thread-id": "thread-test-global-fallback",
        "turn-id": "turn-test-global-fallback",
      });
      assert.equal(
        result.status,
        0,
        `notify-hook failed: ${result.stderr || result.stdout}`,
      );

      const hookState = await readJson<Record<string, unknown>>(hookStatePath);
      assert.equal(hookState.last_reason, "injection_sent");
      assert.equal(hookState.total_injections, 1);
    });
  });

  it.skip("falls back to current tmux pane and heals stale session target", async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, ".omx");
      const stateDir = join(omxDir, "state");
      const logsDir = join(omxDir, "logs");
      const sessionId = "omx-abc123";
      const sessionStateDir = join(stateDir, "sessions", sessionId);
      const fakeBinDir = join(cwd, "fake-bin");
      const configPath = join(omxDir, "tmux-hook.json");
      const hookStatePath = join(stateDir, "tmux-hook-state.json");

      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      const { fakeTmuxPath, tmuxLogPath } = await prepareTmuxHealHarness(
        cwd,
        fakeBinDir,
        {
          case: "stale-hud-heal",
        },
      );

      await writeJson(join(stateDir, "session.json"), {
        session_id: sessionId,
      });
      await writeJson(join(sessionStateDir, "ralph-state.json"), {
        active: true,
        iteration: 0,
      });
      await writeJson(configPath, {
        enabled: true,
        target: { type: "session", value: sessionId },
        allowed_modes: ["ralph"],
        cooldown_ms: 0,
        max_injections_per_session: 10,
        prompt_template: "Continue [OMX_TMUX_INJECT]",
        marker: "[OMX_TMUX_INJECT]",
        dry_run: false,
        log_level: "debug",
      });

      const fakeTmux = buildFakeTmuxHealScript(tmuxLogPath, {
        listPaneTargets: {
          devsess: ["%42 1"],
        },
        paneProbes: {
          "%42": {
            paneId: "%42",
            currentCommand: "codex",
            startCommand: "codex",
            currentPath: cwd,
            sessionName: "devsess",
          },
        },
      });
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      const result = runTmuxHealNotifyHook(
        cwd,
        fakeBinDir,
        {
          "thread-id": "thread-test",
          "turn-id": "turn-test",
        },
        {
          TMUX_PANE: "%42",
        },
      );
      assert.equal(
        result.status,
        0,
        `notify-hook failed: ${result.stderr || result.stdout}`,
      );

      const hookState = await readJson<Record<string, unknown>>(hookStatePath);
      assert.equal(hookState.last_reason, "injection_sent");
      assert.equal(hookState.total_injections, 1);

      const healedConfig = await readJson<{
        target: { type: string; value: string };
      }>(configPath);
      assert.equal(healedConfig.target.type, "pane");
      assert.equal(healedConfig.target.value, "%42");
    });
  });

  it.skip("skips injection when fallback pane cwd does not match hook cwd", async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, ".omx");
      const stateDir = join(omxDir, "state");
      const logsDir = join(omxDir, "logs");
      const sessionId = "omx-abc123";
      const sessionStateDir = join(stateDir, "sessions", sessionId);
      const fakeBinDir = join(cwd, "fake-bin");
      const configPath = join(omxDir, "tmux-hook.json");
      const hookStatePath = join(stateDir, "tmux-hook-state.json");

      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      const { fakeTmuxPath, tmuxLogPath } = await prepareTmuxHealHarness(
        cwd,
        fakeBinDir,
        {
          case: "active-mode-pane-id",
        },
      );

      await writeJson(join(stateDir, "session.json"), {
        session_id: sessionId,
      });
      await writeJson(join(sessionStateDir, "ralph-state.json"), {
        active: true,
        iteration: 0,
      });
      await writeJson(configPath, {
        enabled: true,
        target: { type: "session", value: sessionId },
        allowed_modes: ["ralph"],
        cooldown_ms: 0,
        max_injections_per_session: 10,
        prompt_template: "Continue [OMX_TMUX_INJECT]",
        marker: "[OMX_TMUX_INJECT]",
        dry_run: false,
        log_level: "debug",
      });

      const fakeTmux = buildFakeTmuxHealScript(tmuxLogPath, {
        listPaneTargets: {
          devsess: ["%42 1"],
        },
        paneProbes: {
          "%42": {
            paneId: "%42",
            currentCommand: "codex",
            startCommand: "codex",
            currentPath: "/tmp/not-the-hook-cwd",
            sessionName: "devsess",
          },
        },
      });
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      const result = runTmuxHealNotifyHook(
        cwd,
        fakeBinDir,
        {
          "thread-id": "thread-test-2",
          "turn-id": "turn-test-2",
        },
        {
          TMUX_PANE: "%42",
        },
      );
      assert.equal(
        result.status,
        0,
        `notify-hook failed: ${result.stderr || result.stdout}`,
      );

      const hookState = await readJson<Record<string, unknown>>(hookStatePath);
      assert.equal(hookState.last_reason, "pane_cwd_mismatch");
      assert.equal(hookState.total_injections, 0);
    });
  });

  it("does not guess a pane by shared cwd when canonical codex pane is unavailable", async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, ".omx");
      const stateDir = join(omxDir, "state");
      const logsDir = join(omxDir, "logs");
      const sessionId = "omx-abc123";
      const sessionStateDir = join(stateDir, "sessions", sessionId);
      const fakeBinDir = join(cwd, "fake-bin");
      const configPath = join(omxDir, "tmux-hook.json");
      const hookStatePath = join(stateDir, "tmux-hook-state.json");

      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      const { fakeTmuxPath, tmuxLogPath } = await prepareTmuxHealHarness(
        cwd,
        fakeBinDir,
        {
          case: "scoped-mode-pane-precedence",
        },
      );

      await writeJson(join(stateDir, "session.json"), {
        session_id: sessionId,
      });
      await writeJson(join(sessionStateDir, "ralph-state.json"), {
        active: true,
        iteration: 0,
      });
      await writeJson(configPath, {
        enabled: true,
        target: { type: "session", value: sessionId },
        allowed_modes: ["ralph"],
        cooldown_ms: 0,
        max_injections_per_session: 10,
        prompt_template: "Continue [OMX_TMUX_INJECT]",
        marker: "[OMX_TMUX_INJECT]",
        dry_run: false,
        log_level: "debug",
      });

      const fakeTmux = buildFakeTmuxHealScript(tmuxLogPath, {
        allPaneLines: [`%42\t${cwd}\t1\tdevsess`],
        listPaneTargets: {
          devsess: ["%42 1"],
        },
        paneProbes: {
          "%42": {
            paneId: "%42",
            currentPath: cwd,
            sessionName: "devsess",
          },
        },
      });
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      const result = runTmuxHealNotifyHook(cwd, fakeBinDir, {
        "thread-id": "thread-test-3",
        "turn-id": "turn-test-3",
      });
      assert.equal(
        result.status,
        0,
        `notify-hook failed: ${result.stderr || result.stdout}`,
      );

      const hookState = await readJson<Record<string, unknown>>(hookStatePath);
      assert.equal(hookState.last_reason, "target_not_found");
      assert.equal(hookState.total_injections ?? 0, 0);
    });
  });

  it.skip("heals a stale HUD pane target back to the canonical codex pane", async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, ".omx");
      const stateDir = join(omxDir, "state");
      const logsDir = join(omxDir, "logs");
      const sessionId = "omx-hud-stale";
      const sessionStateDir = join(stateDir, "sessions", sessionId);
      const fakeBinDir = join(cwd, "fake-bin");
      const configPath = join(omxDir, "tmux-hook.json");
      const hookStatePath = join(stateDir, "tmux-hook-state.json");

      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      const { fakeTmuxPath, tmuxLogPath } = await prepareTmuxHealHarness(
        cwd,
        fakeBinDir,
        {
          case: "busy-pane-skip",
        },
      );

      await writeJson(join(stateDir, "session.json"), {
        session_id: sessionId,
      });
      await writeJson(join(sessionStateDir, "ralph-state.json"), {
        active: true,
        iteration: 0,
      });
      await writeJson(configPath, {
        enabled: true,
        target: { type: "pane", value: "%77" },
        allowed_modes: ["ralph"],
        cooldown_ms: 0,
        max_injections_per_session: 10,
        prompt_template: "Continue [OMX_TMUX_INJECT]",
        marker: "[OMX_TMUX_INJECT]",
        dry_run: false,
        log_level: "debug",
      });

      const fakeTmux = buildFakeTmuxHealScript(tmuxLogPath, {
        paneProbes: {
          "%77": {
            paneId: "%77",
            startCommand: "node dist/cli/omx.js hud --watch",
            sessionName: "devsess",
          },
          "%99": {
            currentCommand: "node",
            currentPath: cwd,
            startCommand: "codex",
            sessionName: "devsess",
            paneInMode: "0",
          },
        },
      });
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      const result = runTmuxHealNotifyHook(
        cwd,
        fakeBinDir,
        {
          session_id: sessionId,
          "thread-id": "thread-test-hud-heal",
          "turn-id": "turn-test-hud-heal",
        },
        {
          TMUX_PANE: "%99",
        },
      );
      assert.equal(
        result.status,
        0,
        `notify-hook failed: ${result.stderr || result.stdout}`,
      );

      const hookState = await readJson<Record<string, unknown>>(hookStatePath);
      assert.equal(hookState.last_reason, "injection_sent");
      assert.equal(hookState.last_target, "%99");

      const healedConfig = await readJson<{
        target: { type: string; value: string };
      }>(configPath);
      assert.equal(healedConfig.target.type, "pane");
      assert.equal(healedConfig.target.value, "%99");
    });
  });

  it("falls back to current tmux pane and heals stale session target (isolated env)", async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, ".omx");
      const stateDir = join(omxDir, "state");
      const logsDir = join(omxDir, "logs");
      const sessionId = "omx-abc123";
      const sessionStateDir = join(stateDir, "sessions", sessionId);
      const fakeBinDir = join(cwd, "fake-bin");
      const fakeTmuxPath = join(fakeBinDir, "tmux");
      const tmuxLogPath = join(cwd, "tmux.log");
      const configPath = join(omxDir, "tmux-hook.json");
      const hookStatePath = join(stateDir, "tmux-hook-state.json");

      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, "session.json"), {
        session_id: sessionId,
      });
      await writeJson(join(sessionStateDir, "ralph-state.json"), {
        active: true,
        iteration: 0,
      });
      await writeJson(configPath, {
        enabled: true,
        target: { type: "session", value: sessionId },
        allowed_modes: ["ralph"],
        cooldown_ms: 0,
        max_injections_per_session: 10,
        prompt_template: "Continue [OMX_TMUX_INJECT]",
        marker: "[OMX_TMUX_INJECT]",
        dry_run: false,
        log_level: "debug",
      });

      const fakeTmux = buildFakeTmuxHealScript(tmuxLogPath, {
        listPaneTargets: {
          devsess: ["%42 1"],
        },
        paneProbes: {
          "%42": {
            paneId: "%42",
            currentCommand: "codex",
            startCommand: "codex",
            currentPath: cwd,
            sessionName: "devsess",
          },
        },
      });
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      const result = runTmuxHealNotifyHook(
        cwd,
        fakeBinDir,
        {
          "thread-id": "thread-test",
          "turn-id": "turn-test",
        },
        {
          TMUX_PANE: "%42",
        },
      );
      assert.equal(
        result.status,
        0,
        `notify-hook failed: ${result.stderr || result.stdout}`,
      );

      const hookState = await readJson<Record<string, unknown>>(hookStatePath);
      assert.equal(hookState.last_reason, "injection_sent");
      assert.equal(hookState.total_injections, 1);

      const healedConfig = await readJson<{
        target: { type: string; value: string };
      }>(configPath);
      assert.equal(healedConfig.target.type, "pane");
      assert.equal(healedConfig.target.value, "%42");
    });
  });

  it("skips injection when fallback pane cwd does not match hook cwd (isolated env)", async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, ".omx");
      const stateDir = join(omxDir, "state");
      const logsDir = join(omxDir, "logs");
      const sessionId = "omx-abc123";
      const sessionStateDir = join(stateDir, "sessions", sessionId);
      const fakeBinDir = join(cwd, "fake-bin");
      const fakeTmuxPath = join(fakeBinDir, "tmux");
      const tmuxLogPath = join(cwd, "tmux.log");
      const configPath = join(omxDir, "tmux-hook.json");
      const hookStatePath = join(stateDir, "tmux-hook-state.json");

      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, "session.json"), {
        session_id: sessionId,
      });
      await writeJson(join(sessionStateDir, "ralph-state.json"), {
        active: true,
        iteration: 0,
      });
      await writeJson(configPath, {
        enabled: true,
        target: { type: "session", value: sessionId },
        allowed_modes: ["ralph"],
        cooldown_ms: 0,
        max_injections_per_session: 10,
        prompt_template: "Continue [OMX_TMUX_INJECT]",
        marker: "[OMX_TMUX_INJECT]",
        dry_run: false,
        log_level: "debug",
      });

      const fakeTmux = buildFakeTmuxHealScript(tmuxLogPath, {
        listPaneTargets: {
          devsess: ["%42 1"],
        },
        paneProbes: {
          "%42": {
            paneId: "%42",
            currentCommand: "codex",
            startCommand: "codex",
            currentPath: "/tmp/not-the-hook-cwd",
            sessionName: "devsess",
          },
        },
      });
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      const result = runTmuxHealNotifyHook(
        cwd,
        fakeBinDir,
        {
          "thread-id": "thread-test-2",
          "turn-id": "turn-test-2",
        },
        {
          TMUX_PANE: "%42",
        },
      );
      assert.equal(
        result.status,
        0,
        `notify-hook failed: ${result.stderr || result.stdout}`,
      );

      const hookState = await readJson<Record<string, unknown>>(hookStatePath);
      assert.equal(hookState.last_reason, "pane_cwd_mismatch");
      assert.equal(hookState.total_injections ?? 0, 0);
    });
  });

  it("heals a stale HUD pane target back to the canonical codex pane (isolated env)", async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, ".omx");
      const stateDir = join(omxDir, "state");
      const logsDir = join(omxDir, "logs");
      const sessionId = "omx-hud-stale";
      const sessionStateDir = join(stateDir, "sessions", sessionId);
      const fakeBinDir = join(cwd, "fake-bin");
      const fakeTmuxPath = join(fakeBinDir, "tmux");
      const tmuxLogPath = join(cwd, "tmux.log");
      const configPath = join(omxDir, "tmux-hook.json");
      const hookStatePath = join(stateDir, "tmux-hook-state.json");

      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, "session.json"), {
        session_id: sessionId,
      });
      await writeJson(join(sessionStateDir, "ralph-state.json"), {
        active: true,
        iteration: 0,
      });
      await writeJson(configPath, {
        enabled: true,
        target: { type: "pane", value: "%77" },
        allowed_modes: ["ralph"],
        cooldown_ms: 0,
        max_injections_per_session: 10,
        prompt_template: "Continue [OMX_TMUX_INJECT]",
        marker: "[OMX_TMUX_INJECT]",
        dry_run: false,
        log_level: "debug",
      });

      const fakeTmux = buildFakeTmuxHealScript(tmuxLogPath, {
        paneProbes: {
          "%77": {
            paneId: "%77",
            startCommand: "node dist/cli/omx.js hud --watch",
            sessionName: "devsess",
          },
          "%99": {
            currentCommand: "node",
            currentPath: cwd,
            startCommand: "codex",
            sessionName: "devsess",
            paneInMode: "0",
          },
        },
      });
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      const result = runTmuxHealNotifyHook(
        cwd,
        fakeBinDir,
        {
          session_id: sessionId,
          "thread-id": "thread-test-hud-heal",
          "turn-id": "turn-test-hud-heal",
        },
        {
          TMUX_PANE: "%99",
        },
      );
      assert.equal(
        result.status,
        0,
        `notify-hook failed: ${result.stderr || result.stdout}`,
      );

      const hookState = await readJson<Record<string, unknown>>(hookStatePath);
      assert.equal(hookState.last_reason, "injection_sent");
      assert.equal(hookState.total_injections, 1);

      const healedConfig = await readJson<{
        target: { type: string; value: string };
      }>(configPath);
      assert.equal(healedConfig.target.type, "pane");
      assert.equal(healedConfig.target.value, "%99");
    });
  });

  it("prefers active mode state tmux_pane_id when present", async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, ".omx");
      const stateDir = join(omxDir, "state");
      const logsDir = join(omxDir, "logs");
      const sessionId = "omx-abc123";
      const sessionStateDir = join(stateDir, "sessions", sessionId);
      const fakeBinDir = join(cwd, "fake-bin");
      const fakeTmuxPath = join(fakeBinDir, "tmux");
      const tmuxLogPath = join(cwd, "tmux.log");
      const configPath = join(omxDir, "tmux-hook.json");
      const hookStatePath = join(stateDir, "tmux-hook-state.json");

      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, "session.json"), {
        session_id: sessionId,
      });
      await writeJson(join(sessionStateDir, "ralph-state.json"), {
        active: true,
        iteration: 0,
        tmux_pane_id: "%99",
      });
      await writeJson(configPath, {
        enabled: true,
        target: { type: "session", value: "nonexistent-session" },
        allowed_modes: ["ralph"],
        cooldown_ms: 0,
        max_injections_per_session: 10,
        prompt_template: "Continue [OMX_TMUX_INJECT]",
        marker: "[OMX_TMUX_INJECT]",
        dry_run: false,
        log_level: "debug",
      });

      const fakeTmux = buildFakeTmuxHealScript(tmuxLogPath, {
        paneProbes: {
          "%99": {
            paneId: "%99",
            currentPath: cwd,
            sessionName: "devsess",
          },
        },
      });
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      const result = runTmuxHealNotifyHook(cwd, fakeBinDir, {
        "thread-id": "thread-test-4",
        "turn-id": "turn-test-4",
      });
      assert.equal(
        result.status,
        0,
        `notify-hook failed: ${result.stderr || result.stdout}`,
      );

      const hookState = await readJson<Record<string, unknown>>(hookStatePath);
      assert.equal(hookState.last_reason, "injection_sent");
      assert.equal(hookState.total_injections, 1);

      const healedConfig = await readJson<{
        target: { type: string; value: string };
      }>(configPath);
      assert.equal(healedConfig.target.type, "pane");
      assert.equal(healedConfig.target.value, "%99");
    });
  });

  it("prefers scoped active mode state over global mode state for tmux pane selection", async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, ".omx");
      const stateDir = join(omxDir, "state");
      const logsDir = join(omxDir, "logs");
      const sessionId = "omx-abc123";
      const sessionStateDir = join(stateDir, "sessions", sessionId);
      const fakeBinDir = join(cwd, "fake-bin");
      const fakeTmuxPath = join(fakeBinDir, "tmux");
      const tmuxLogPath = join(cwd, "tmux.log");
      const configPath = join(omxDir, "tmux-hook.json");
      const hookStatePath = join(stateDir, "tmux-hook-state.json");

      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, "session.json"), {
        session_id: sessionId,
      });
      await writeJson(join(sessionStateDir, "ralph-state.json"), {
        active: true,
        iteration: 0,
        tmux_pane_id: "%99",
      });
      await writeJson(join(stateDir, "ralph-state.json"), {
        active: true,
        iteration: 100,
        tmux_pane_id: "%55",
      });
      await writeJson(configPath, {
        enabled: true,
        target: { type: "session", value: "nonexistent-session" },
        allowed_modes: ["ralph"],
        cooldown_ms: 0,
        max_injections_per_session: 10,
        prompt_template: "Continue [OMX_TMUX_INJECT]",
        marker: "[OMX_TMUX_INJECT]",
        dry_run: false,
        log_level: "debug",
      });

      const fakeTmux = buildFakeTmuxHealScript(tmuxLogPath, {
        paneProbes: {
          "%99": {
            paneId: "%99",
            currentPath: cwd,
            sessionName: "devsess",
            currentCommand: "codex",
            paneInMode: "0",
          },
        },
      });
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      const result = runTmuxHealNotifyHook(cwd, fakeBinDir, {
        session_id: sessionId,
        "thread-id": "thread-test-scoped-pane-precedence",
        "turn-id": "turn-test-scoped-pane-precedence",
      });
      assert.equal(
        result.status,
        0,
        `notify-hook failed: ${result.stderr || result.stdout}`,
      );

      const hookState = await readJson<Record<string, unknown>>(hookStatePath);
      assert.equal(hookState.last_reason, "injection_sent");
      assert.equal(hookState.total_injections, 1);

      const healedConfig = await readJson<{
        target: { type: string; value: string };
      }>(configPath);
      assert.equal(healedConfig.target.type, "pane");
      assert.equal(healedConfig.target.value, "%99");
    });
  });

  it("skips injection when the resolved pane is still busy", async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, ".omx");
      const stateDir = join(omxDir, "state");
      const logsDir = join(omxDir, "logs");
      const sessionId = "omx-busy-pane";
      const sessionStateDir = join(stateDir, "sessions", sessionId);
      const fakeBinDir = join(cwd, "fake-bin");
      const fakeTmuxPath = join(fakeBinDir, "tmux");
      const tmuxLogPath = join(cwd, "tmux.log");
      const configPath = join(omxDir, "tmux-hook.json");
      const hookStatePath = join(stateDir, "tmux-hook-state.json");

      await mkdir(sessionStateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(stateDir, "session.json"), {
        session_id: sessionId,
      });
      await writeJson(join(sessionStateDir, "ralph-state.json"), {
        active: true,
        iteration: 0,
        tmux_pane_id: "%42",
      });
      await writeJson(configPath, {
        enabled: true,
        target: { type: "pane", value: "%42" },
        allowed_modes: ["ralph"],
        cooldown_ms: 0,
        max_injections_per_session: 10,
        prompt_template: "Continue [OMX_TMUX_INJECT]",
        marker: "[OMX_TMUX_INJECT]",
        dry_run: false,
        log_level: "debug",
      });

      const fakeTmux = buildFakeTmuxHealScript(tmuxLogPath, {
        paneProbes: {
          "%42": {
            paneId: "%42",
            currentCommand: "codex",
            paneInMode: "0",
          },
        },
        captureOutput:
          "Working...\n• Running tests (3m 12s • esc to interrupt)\n",
        failSendKeys: true,
      });
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      const result = runTmuxHealNotifyHook(cwd, fakeBinDir, {
        session_id: sessionId,
        "thread-id": "thread-test-busy-pane",
        "turn-id": "turn-test-busy-pane",
      });
      assert.equal(
        result.status,
        0,
        `notify-hook failed: ${result.stderr || result.stdout}`,
      );

      const hookState = await readJson<Record<string, unknown>>(hookStatePath);
      assert.equal(hookState.last_reason, "pane_has_active_task");
      assert.equal(hookState.total_injections ?? 0, 0);
    });
  });
});
