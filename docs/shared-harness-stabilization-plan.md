# Shared Harness Stabilization Plan

Superseded:

- This document is now a historical planning note and is no longer an active source of truth.
- The remaining active scopes were split into:
  - [debug-trace-boundary-separation-master-plan-2026-04-06.md](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/docs/qa/debug-trace-boundary-separation-master-plan-2026-04-06.md)
    - notify/tmux fake runner harness
    - team/tmux session fixture boundary cleanup
    - user/home-scoped write-path normalization
  - [team-env-threading-followup-2026-04-06.md](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/docs/qa/team-env-threading-followup-2026-04-06.md)
    - deferred production env-threading follow-up
- Read this document for historical context only, not for current planning authority.

## Summary

Amaç: "bir yeri düzeltince başka yer bozuluyor" döngüsünü kırmak. Bunu test-by-test değil, ortak harness/state surfaces üzerinden yapacağız. Planın temel yaklaşımı:

- önce ortak test helper/state yüzeylerini stabilize et
- sonra ilgili testleri o stabilize harness'e taşı
- en son grouped verification ile aynı surface'in bütün etkileşimlerini birlikte doğrula

Bu plan runtime/product semantics'i değiştirmeyi değil, test harness determinism sağlamayı hedefler. Runtime code'a ancak bir fail targeted + grouped run'da da gerçek code bug olarak kanıtlanırsa dokunulur.

## Buckets

### H1: Packaged Binary Fixture / Shared Lock

Ortak yüzey:
- `src/cli/__tests__/packaged-explore-harness-lock.ts`

Bağlı test aileleri:
- `doctor-warning-copy`
- `explore`
- `sparkshell-cli`

Risk:
- same-process concurrency
- shared packaged `bin/*` mutation
- global lock starvation
- stale lock leftover

Durum:
- scope-aware lock eklendi
- bu bucket artık "stabilized harness" adayı
- final grouped verification ile tekrar doğrulanmalı

### H2: Notify/Tmux Fake Runner Harness

Ortak yüzey:
- `buildFakeTmux(...)`
- `buildFakeTmuxWithListPanes(...)`
- `buildCleanNotifyEnv(...)`
- `withTempWorkingDir(...)`

Bağlı test aileleri:
- `notify-fallback-watcher`
- `notify-hook-auto-nudge`
- `notify-hook-team-leader-nudge`
- `notify-hook-team-tmux-guard`
- `notify-hook-tmux-heal`

Risk:
- process-global env leakage
- `TMUX` / `TMUX_PANE` inheritance
- `HOME` / `CODEX_HOME` / session-state crosstalk
- fake tmux scripts not returning enough probe fields for the branch under test
- mixed use of root `.omx/state` vs session-scoped state

Plan:
- helper'ları ortak deterministic contract'a çek
- all fake tmux builders explicit probe coverage vermeli:
  - `#{pane_in_mode}`
  - `#{pane_current_command}`
  - `#{pane_start_command}`
  - `#{pane_current_path}`
  - `#S`
- test-local env builder, inherited env'i minimuma indirmeli
- where behavior is inherently flaky in shared suite:
  - old test `skip`
  - replacement isolated test active

### H3: Team/Tmux Session Fixture Harness

Ortak yüzey:
- `src/team/__tests__/tmux-test-fixture.ts`
- `src/team/__tests__/tmux-session.test.ts`

Risk:
- ambient/default tmux server interaction
- synthetic server vs ambient server ambiguity
- `TMUX` / `TMUX_PANE` env restoration
- fake tmux fixture timing around prompt dismissal / readiness loops

Plan:
- tmux fixture must be the only authority for tmux env during a test
- no accidental fallback to ambient/default server
- original old tests stay active where stable
- only genuinely unstable variants use `skip + replacement`

### H4: User/Home-Scoped Write Paths in Tests

Ortak yüzey:
- `~/.omx/team-jobs`
- default npm cache
- default tmux socket
- HOME-dependent session dirs

Bağlı test aileleri:
- `mcp team-server-*`
- package/bin style pack tests
- any test still touching user home implicitly

Plan:
- all tests in this bucket must be moved to temp HOME / temp cache / explicit env roots
- no test should rely on actual user home write access
- if test intentionally validates default-home behavior, it should do so through a redirected synthetic HOME, not the real one

## Implementation Changes

### 1. Stabilize helper contracts before touching more runtime code

Prioritize helper-level changes in this order:
1. `packaged-explore-harness-lock`
2. notify fake tmux/env helpers
3. tmux test fixture helpers
4. home/cache redirection helpers

For each helper:
- define the exact env it owns
- define what it restores
- define what shared resource it mutates
- make mutation scope explicit in the helper API

### 2. Convert flaky old tests to isolated replacements only when necessary

Rule:
- if a test passes reliably alone but fails in grouped/full runs due to harness interaction, keep the old assertion semantics but:
  - mark the old test `skip`
  - add an isolated replacement directly below it
- replacement must assert the same behavior, not weaker behavior
- replacement must use the stabilized helper surface, not ad-hoc local scripting

### 3. Group verification by shared surface, not by feature

After each helper/harness stabilization:
- run the full family that shares it
- then run the adjacent family that is most likely to collide with it

Required grouped gates:

- packaged binary family:
  - `doctor-warning-copy`
  - `explore`
  - `sparkshell-cli`

- notify/tmux family:
  - `notify-fallback-watcher`
  - `notify-hook-auto-nudge`
  - `notify-hook-team-leader-nudge`
  - `notify-hook-team-tmux-guard`
  - `notify-hook-tmux-heal`
  - `team/tmux-session`

- home/path family:
  - `mcp team-server-*`
  - package/bin tests
  - any HOME-bound registry/session tests touched by the same helper

### 4. Only then classify remaining red tests as real runtime bugs

A remaining fail is treated as a runtime bug only if:
- the stabilized helper family is green in isolation and grouped mode
- the failing test still reproduces
- the failure is not explained by host permission/network/socket policy

That prevents us from "fixing product code" to compensate for broken tests.

## Test Plan

### Harness stabilization checks

- `packaged-explore-harness-lock` families together:
  - `dist/cli/__tests__/doctor-warning-copy.test.js`
  - `dist/cli/__tests__/explore.test.js`
  - `dist/cli/__tests__/sparkshell-cli.test.js`

- notify/tmux grouped:
  - `dist/hooks/__tests__/notify-fallback-watcher.test.js`
  - `dist/hooks/__tests__/notify-hook-auto-nudge.test.js`
  - `dist/hooks/__tests__/notify-hook-team-leader-nudge.test.js`
  - `dist/hooks/__tests__/notify-hook-team-tmux-guard.test.js`
  - `dist/hooks/__tests__/notify-hook-tmux-heal.test.js`
  - `dist/cli/__tests__/team.test.js`
  - `dist/team/__tests__/tmux-session.test.js`

### Home/path isolation checks

- `dist/mcp/__tests__/team-server-cleanup.test.js`
- `dist/mcp/__tests__/team-server-wait.test.js`
- package/bin tests with redirected npm cache
- any test writing under user HOME redirected to temp HOME

### Final grouped acceptance

- no timeout-based lock starvation
- no accidental writes to real user home/cache/sockets
- any skipped old test must have an active replacement directly covering the same behavior
- residual failures, if any, are true runtime issues, not shared-harness artifacts

## Assumptions

- current flakiness is dominated by shared harness/state, not by many unrelated product bugs
- `skip + replacement` is acceptable only for genuinely unstable old tests and only when the replacement preserves the same behavior contract
- runtime semantics should not be changed merely to satisfy a flaky shared harness
- Windows-specific expansion remains out of scope; existing support is preserved but not extended
