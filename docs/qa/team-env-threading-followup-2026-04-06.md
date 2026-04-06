# Team Env-Threading Follow-up

## Purpose

This document captures the remaining `withEnv(...)` residuals that were **not** closed during the hermetic execution / env isolation program.

These residuals are no longer simple test-cleanup work. They now require **production API env-threading refactors** in the team runtime / tmux helper layer.

This note exists so the work can be deferred without losing:

- what is still open
- why it is still open
- what kind of refactor is required
- what should be verified when the refactor is resumed

## Current Residual Surface

Remaining `withEnv(...)` usage is intentionally down to the following test-helper patterns:

- [`src/team/__tests__/tmux-session.test.ts`](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/team/__tests__/tmux-session.test.ts)
- [`src/team/__tests__/runtime.test.ts`](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/team/__tests__/runtime.test.ts)

At the time of writing, the remaining residuals are helper-level wrappers such as:

- `withEmptyPath(...)`
- `withMockTmuxFixture(...)`
- `withoutTeamWorkerEnv(...)`

## Why These Were Not Closed

The remaining helpers still rely on same-process env mutation because several production functions in the team/tmux stack still read environment state implicitly rather than accepting an explicit env object.

Examples:

- [`src/team/tmux-session.ts`](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/team/tmux-session.ts)
  - `enableMouseScrolling(...)`
  - `listTeamSessions(...)`
  - `killWorkerByPaneId(...)`
  - `killWorker(...)`
  - `waitForWorkerReady(...)`
  - some internal `runTmux(...)`-driven branches
- [`src/team/runtime.ts`](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/team/runtime.ts)
  - runtime flows that indirectly depend on tmux/session helpers still using implicit env

As a result, the remaining test helpers are not just convenience wrappers. They are currently compensating for missing explicit env threading in production APIs.

## Required Follow-up Refactor

The next pass should convert the remaining team/tmux helpers from implicit process env reads to explicit env threading where appropriate.

Target direction:

1. Add optional `env: NodeJS.ProcessEnv` parameters to remaining tmux/session helpers that still read ambient env.
2. Thread those env objects through runtime call sites.
3. Replace helper-level `withEnv(...)` wrappers in tests with explicit env objects or fixture-local env builders.
4. Re-run targeted team runtime and tmux suites after each signature group conversion.

## Suggested Refactor Order

1. [`src/team/tmux-session.ts`](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/team/tmux-session.ts)
   - finish env threading for helper functions that still depend on `PATH`, `TMUX`, `TMUX_PANE`, WSL/MSYS markers, or worker/tmux strategy env
2. [`src/team/__tests__/tmux-session.test.ts`](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/team/__tests__/tmux-session.test.ts)
   - remove `withEmptyPath(...)`
   - remove `withMockTmuxFixture(...)` ambient PATH mutation
3. [`src/team/runtime.ts`](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/team/runtime.ts)
   - thread env through tmux-dependent helper calls where still implicit
4. [`src/team/__tests__/runtime.test.ts`](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/src/team/__tests__/runtime.test.ts)
   - remove `withoutTeamWorkerEnv(...)`
   - remove remaining helper-level `withEnv(...)`

## Acceptance For The Deferred Follow-up

This deferred work is done only when:

- residual `withEnv(...)` usage in the two team test files is reduced to zero, or
- any remaining usage is explicitly justified as a true same-process import-time test seam

Verification should include:

- `npm run build`
- `npm run check:no-unused`
- `node --test dist/team/__tests__/tmux-session.test.js`
- `node --test dist/team/__tests__/runtime.test.js`

## Status

Deferred intentionally.

Reason:

- current env isolation effort already eliminated the broad mutation/raw inheritance failures
- the remaining work is production signature refactor territory, not just test harness cleanup
- this should be resumed as a focused follow-up rather than hidden as incidental cleanup
