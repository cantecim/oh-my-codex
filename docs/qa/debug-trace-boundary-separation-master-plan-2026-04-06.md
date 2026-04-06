# Debug / Trace Boundary Separation Master Plan

Date: 2026-04-06

## Status

Active source of truth.

This document replaces [debug-neutrality-technical-debt-2026-04-04.md](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/docs/qa/debug-neutrality-technical-debt-2026-04-04.md) as the primary planning artifact for the remaining debug/trace and harness-boundary cleanup work.

It also absorbs the still-relevant remaining scopes from [shared-harness-stabilization-plan.md](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/docs/shared-harness-stabilization-plan.md):

- `H2: Notify/Tmux Fake Runner Harness`
- `H3: Team/Tmux Session Fixture Harness`
- `H4: User/Home-Scoped Write Paths in Tests`

The older documents remain useful as historical notes, but they are no longer the canonical planning surface for this work.

## Summary

The env-isolation program is complete and the debug-off full suite is green. That effort removed the largest contamination and drift classes:

- broad `process.env` mutation
- raw `env: process.env` / `...process.env`
- same-process freeloading in the hottest notify/tmux/team/mcp/cli lanes
- ambient `TMUX` / `TMUX_PANE` drift

What remains is not the old env-isolation problem. The remaining work is a **boundary-shaping** problem:

1. product/runtime code must not know about test-debug ownership or test artifact policy
2. test/debug artifact ownership must be centralized and explicit
3. fake tmux / session fixtures must stop behaving like semi-ambient compatibility layers
4. home/path redirection must become a normal fixture contract instead of scattered per-test behavior

The new goal is:

- make the debug and trace system structurally inert when test debug is disabled
- keep product tracing generic and non-test-specific
- keep test artifact ownership completely outside runtime/product semantics
- narrow shared harness responsibilities so fixture helpers stay fixture-only

This plan is intentionally stricter than a debt note. It defines the desired architecture, the migration order, and the acceptance gates for the remaining cleanup.

## Problem Statement

We now have a stable suite, but the debug/test-support system still has boundary leakage in a few forms:

### 1. Mixed ownership between debug contract and fixture contract

Current shape:

- [src/debug/test-debug.ts](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/debug/test-debug.ts)
  owns the effective debug artifact contract
- [src/test-support/fixture-debug.ts](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/test-support/fixture-debug.ts)
  owns fixture lifecycle-oriented debug recording
- [src/test-support/shared-harness.ts](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/test-support/shared-harness.ts)
  is still directly aware of both fixture logic and low-level debug artifact helpers

This is workable, but it means the harness knows too much about the debug layer.

### 2. Product/runtime tracing still relies on a seam that is not yet architecturally explicit enough

The suite now depends on tracing and debug artifacts for drift diagnosis, but the rules are not yet strict enough:

- product code may call generic trace helpers
- product code must not know anything about test artifact paths, fixture manifests, or test-debug policy
- `OMX_TEST_DEBUG` must not become a behavior fork inside runtime/product code

The invariant we want is:

- product code may emit generic trace events
- product code may not know whether those traces are being persisted for tests, dropped, or sent elsewhere

### 3. Fake tmux and tmux-session fixtures are still only partially standardized

We already improved:

- fake tmux builder quality
- notify/tmux env isolation
- `applyTmuxEnv` removal
- explicit env threading in key tmux/runtime seams

But the test surface is still mixed:

- some files use shared fake tmux contract cleanly
- some still carry local wrapper functions around the shared builder
- some still rely on helper-level conventions rather than one explicit fixture contract

### 4. HOME/CODEX_HOME/team-jobs redirection is improved but not yet fully normalized

We now redirect many tests to temp roots, but the policy is not yet fully systematic:

- some tests still use local `withEnv({ HOME: ... })`
- some mcp tests still reason via `homedir()`-anchored default path helpers
- the repo does not yet have one obvious “home-scoped synthetic fixture” contract

### 5. Debug artifact ergonomics are still operationally rough

The current debug artifacts are useful, but they still assume too much operator memory:

- historical artifacts accumulate
- current-run vs old-run interpretation is manual
- extraction is functional, but not yet optimized for run-scoped reading

This is not a correctness issue, but it is a maintenance issue.

## Desired End State

The target architecture is:

### Layer A: Product/runtime tracing

Responsibilities:

- emit generic trace/diagnostic events
- never own test artifact paths
- never own fixture manifests
- never branch directly on `OMX_TEST_DEBUG`

Allowed:

- product code calling a generic trace adapter

Forbidden:

- product code knowing test artifact filenames
- product code knowing `env-before.json`, `manifest.json`, `lifecycle.jsonl`, or similar test fixture artifacts
- product code containing `if (OMX_TEST_DEBUG)` policy forks

### Layer B: Debug artifact adapter

Responsibilities:

- decide whether trace/debug persistence is active
- resolve artifact roots and test IDs
- write schema-controlled JSON / JSONL artifacts
- remain a no-op when debug is disabled

This layer is the only place that should know:

- `OMX_TEST_DEBUG`
- `OMX_TEST_ARTIFACTS_DIR`
- `OMX_TEST_DEBUG_TEST_ID`
- artifact filenames and schema shape

### Layer C: Fixture debug orchestration

Responsibilities:

- temp-dir lifecycle recording
- env snapshot/diff recording
- fixture-local manifests and cleanup metadata
- fixture-oriented wrappers over the debug artifact adapter

This layer should know fixture semantics, but not runtime behavior.

### Layer D: Shared harness

Responsibilities:

- temp directories
- temp HOME
- child env building
- working directory scoping
- shared fake tmux script construction

This layer should not own debug artifact policy directly.
It should consume fixture-debug helpers rather than speaking low-level debug-artifact language itself.

### Layer E: Extractors / reporting

Responsibilities:

- consume the stable artifact schema
- summarize and filter runs
- stay compatible with the adapter-owned schema

This layer should not need to know fixture implementation details beyond the stable artifact contract.

## Non-Negotiable Rules

### 1. Product code must not know test-debug policy

This is the central rule.

Product/runtime code may emit generic trace data, but:

- it does not inspect `OMX_TEST_DEBUG`
- it does not compute test artifact directories
- it does not know fixture/debug ownership
- it does not own test-only file naming

### 2. The debug adapter must be inert when disabled

When debug is off:

- no artifact root resolution with side effects
- no fixture preservation behavior
- no hidden cleanup suppression
- no product behavior changes

The adapter may still exist as a seam, but it must be semantically inert.

### 3. Shared harness must not be the real owner of debug schema

`shared-harness` may call fixture-debug APIs, but it must not be the place where:

- debug schema is invented
- artifact naming policy is duplicated
- trace/test-id policy is duplicated

### 4. Fake tmux contracts must be explicit and fixture-local

The fake tmux surface must behave like a proper fixture contract:

- its owned files are explicit
- its env contract is explicit
- its supported probes are explicit
- it must not rely on ambient tmux state

### 5. HOME-scoped writes must always be synthetic in tests

Tests may validate default-home behavior, but only through a redirected synthetic home root.

No test should implicitly depend on:

- the real user home
- the real default npm cache
- the real team-jobs directory
- ambient session dirs

## Current State Snapshot

### Already Good

- env isolation master plan is complete
- debug-off full suite is green
- `applyTmuxEnv` was removed
- many notify/tmux/team/mcp/cli lanes already use explicit child env
- several broad raw inheritance seams were removed

### Still Structurally Mixed

- [src/test-support/shared-harness.ts](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/test-support/shared-harness.ts)
  still imports both fixture-debug helpers and direct debug helpers
- [src/test-support/fixture-debug.ts](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/test-support/fixture-debug.ts)
  and [src/debug/test-debug.ts](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/debug/test-debug.ts)
  still have a boundary that can be made tighter
- fake tmux wrappers remain spread across many tests
- home/path fixture normalization is not yet canonicalized
- artifact ergonomics are still manual

## Workstreams

## Workstream 1: Debug Adapter Boundary

### Goal

Make the debug adapter the only owner of:

- artifact root resolution
- test-id resolution
- JSON/JSONL persistence
- debug enablement policy

### Required Changes

1. Narrow [src/debug/test-debug.ts](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/debug/test-debug.ts) into the canonical adapter façade.
2. Ensure all low-level artifact helpers remain behind that façade.
3. Remove low-level debug-artifact policy duplication from [src/test-support/shared-harness.ts](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/test-support/shared-harness.ts).

### Desired Outcome

`shared-harness` no longer imports low-level artifact writer functions directly unless they are clearly fixture-neutral and adapter-approved.

## Workstream 2: Fixture Debug Consolidation

### Goal

Make [src/test-support/fixture-debug.ts](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/test-support/fixture-debug.ts) the owner of fixture lifecycle debug instrumentation.

### Scope

- temp-dir creation/preservation/cleanup recording
- env before/after/diff snapshots
- fixture manifests
- fixture lifecycle JSONL events

### Required Changes

1. Move fixture-oriented debug behavior behind fixture-debug APIs.
2. Let [src/test-support/shared-harness.ts](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/test-support/shared-harness.ts) call fixture-debug, not low-level debug-writing utilities.
3. Keep output schema stable enough for [src/scripts/extract-test-debug.ts](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/scripts/extract-test-debug.ts).

### Desired Outcome

`shared-harness` becomes a consumer of fixture-debug, not a co-owner of the debug artifact contract.

## Workstream 3: Notify/Tmux Fake Runner Harness

### Goal

Finish standardizing the remaining fake tmux runner surface across notify/tmux tests.

### Scope

Priority files include:

- [src/hooks/__tests__/notify-hook-team-leader-nudge.test.ts](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/hooks/__tests__/notify-hook-team-leader-nudge.test.ts)
- [src/hooks/__tests__/notify-fallback-watcher.test.ts](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/hooks/__tests__/notify-fallback-watcher.test.ts)
- [src/hooks/__tests__/notify-hook-auto-nudge.test.ts](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/hooks/__tests__/notify-hook-auto-nudge.test.ts)
- [src/hooks/__tests__/notify-hook-worker-idle.test.ts](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/hooks/__tests__/notify-hook-worker-idle.test.ts)
- [src/hooks/__tests__/notify-hook-all-workers-idle.test.ts](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/hooks/__tests__/notify-hook-all-workers-idle.test.ts)
- [src/team/__tests__/idle-nudge.test.ts](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/team/__tests__/idle-nudge.test.ts)

### Required Changes

1. Reduce local wrapper diversity around `buildFakeTmuxScript(...)`.
2. Standardize probe support through explicit options rather than one-off local variants.
3. Keep fixture-local ownership of `tmux.log` and related capture artifacts.
4. Prefer event-first assertions where `tmux.log` has proven brittle, but do not soften transport tests that truly intend to verify `send-keys`.

### Desired Outcome

The fake tmux contract becomes predictable enough that future notify/tmux changes do not require lane-specific builder archaeology.

## Workstream 4: Team/Tmux Session Fixture Boundary

### Goal

Finish making tmux-session and team-side fixture behavior explicit rather than semi-ambient.

### Scope

- [src/team/__tests__/tmux-test-fixture.ts](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/team/__tests__/tmux-test-fixture.ts)
- [src/team/__tests__/tmux-session.test.ts](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/team/__tests__/tmux-session.test.ts)
- [src/team/tmux-session.ts](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/team/tmux-session.ts)
- deferred boundary work noted in [team-env-threading-followup-2026-04-06.md](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/docs/qa/team-env-threading-followup-2026-04-06.md)

### Required Changes

1. Keep tmux fixture ownership explicit.
2. Continue reducing helper-level ambient assumptions.
3. Avoid re-introducing tmux-env mutation as convenience behavior.
4. Keep team env-threading refactor deferred unless a touched change requires it.

### Desired Outcome

The tmux test fixture becomes a clean boundary and no longer behaves like a compatibility patch over ambient tmux state.

## Workstream 5: HOME / CODEX_HOME / team-jobs Normalization

### Goal

Make synthetic home-scoped test behavior systematic.

### Scope

Priority files include:

- [src/mcp/__tests__/team-server-cleanup.test.ts](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/mcp/__tests__/team-server-cleanup.test.ts)
- [src/mcp/__tests__/team-server-wait.test.ts](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/mcp/__tests__/team-server-wait.test.ts)
- setup/doctor/explore/sparkshell tests that still use local home redirection wrappers

### Required Changes

1. Create or standardize a single home-scoped synthetic fixture pattern.
2. Keep tests off the real user home and real default team-jobs path.
3. Make “default-home behavior” assertions operate through redirected synthetic home roots only.

### Desired Outcome

HOME-sensitive tests stop looking like special exceptions and become ordinary fixture-based tests.

## Workstream 6: Debug Artifact Ergonomics

### Goal

Keep the current debug power while reducing operator friction.

### Scope

- [src/scripts/extract-test-debug.ts](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/scripts/extract-test-debug.ts)
- debug artifact root reading conventions
- optional cleanup/filter helpers

### Required Changes

1. Add run-scoped or filter-scoped extraction ergonomics where helpful.
2. Clarify “historical artifacts vs current run” behavior.
3. Avoid changing the trace semantics just to improve readability.

### Desired Outcome

The debug artifacts stay powerful without demanding too much operator memory.

## Recommended Rollout

This work should not be attacked as one giant cleanup. The safest order is:

### Pass 1: Boundary Tightening

- debug adapter ownership review
- fixture-debug ownership review
- remove obvious shared-harness low-level debug coupling

### Pass 2: Fake Tmux Surface Standardization

- notify/tmux builder cleanup
- tmux-session fixture normalization

### Pass 3: Home/Path Normalization

- synthetic home contract
- mcp/package/bin/home-sensitive lane cleanup

### Pass 4: Debug Ergonomics

- extractor/run-scoped ergonomics
- documentation polish

## Acceptance Gates

This program is done only when all of the following are true:

### Architecture Gates

1. Product/runtime code contains no test-specific debug policy.
2. `OMX_TEST_DEBUG` is owned by the debug adapter layer, not runtime/product code.
3. `shared-harness` is no longer a co-owner of debug artifact schema.

### Harness Gates

1. Fake tmux fixture behavior is explicit and fixture-local.
2. Team/tmux session fixtures no longer rely on ambient compatibility behavior.
3. HOME-sensitive tests use synthetic home fixtures rather than the real user home.

### Ergonomics Gates

1. Debug artifacts remain extractable and compatible.
2. Run-scoped reading is practical enough that historical artifact noise is manageable.

### Verification Gates

Minimum verification for touched changes:

- `npm run build`
- `npm run check:no-unused`
- targeted suites for the touched harness family

Program-level verification should also include grouped runs for:

- notify/tmux families
- tmux-session / team runtime families
- home/path-sensitive mcp and cli families

## What This Plan Does Not Require

This plan does not require:

- rewriting the full debug system from scratch
- removing useful runtime tracing
- removing the extractor
- undoing the env-isolation architecture
- pulling the deferred team env-threading refactor back into the active lane

## Final Position

The repo no longer has the old “debug neutrality” problem in the same form.
That note was useful while recovering the suite, but it is too weak as a primary planning artifact now.

The real remaining problem is:

- ownership boundaries are still broader than they should be
- some harness surfaces are still more compatibility-driven than contract-driven

This plan exists to finish that separation cleanly and intentionally.
