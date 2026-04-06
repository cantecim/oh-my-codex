# Debug Neutrality Technical Debt

Superseded:

- This document is now a historical recovery/debt note.
- The active source of truth is [debug-trace-boundary-separation-master-plan-2026-04-06.md](/Users/cantecim/Desktop/Projects/Myself/oh-my-codex/docs/qa/debug-trace-boundary-separation-master-plan-2026-04-06.md).
- Read this document for historical context only, not for current planning authority.

Date: 2026-04-04

## Summary

Full suite is green, but the debug/trace recovery work left a few deliberate technical-debt areas behind. None of these are release blockers. They are cleanup/follow-up scopes intended to preserve the current debugging value while shrinking maintenance risk.

The goal of this note is to capture those scopes before they fade from context.

## 1. Debug/Trace Layer Consolidation

Current state:
- `src/debug/test-debug.ts` is now the effective owner for trace IDs, artifact roots, env subset capture, and JSON/JSONL emission.
- `src/scripts/extract-test-debug.ts` depends on the current artifact schema.
- `src/test-support/shared-harness.ts` still contains a meaningful amount of debug-specific fixture logic.

Remaining debt:
- The boundary between debug contract and test fixture contract is still broader than ideal.
- Some debug concepts are represented both in the shared harness and in the core debug helper surface.
- The current shape is workable, but the ownership split is not minimal yet.

Desired cleanup direction:
- Keep artifact/schema ownership centralized in `src/debug/test-debug.ts`.
- Reduce `src/test-support/shared-harness.ts` to fixture-only responsibilities.
- Preserve extractor compatibility while simplifying where possible.

## 2. Runtime Files Still Carry `@ts-nocheck`

Current state:
- Several stabilized runtime lanes still rely on `@ts-nocheck`, including:
  - `src/scripts/notify-hook/tmux-injection.ts`
  - `src/scripts/notify-hook/team-leader-nudge.ts`
  - `src/scripts/notify-hook/team-dispatch.ts`
  - `src/scripts/notify-hook/auto-nudge.ts`

Remaining debt:
- These files now contain important recovery logic but still lack strong type guarantees.
- Future edits in these lanes are more likely to regress quietly.

Desired cleanup direction:
- Remove `@ts-nocheck` incrementally, lane by lane.
- Prefer local type shaping and helper extraction over broad rewrites.
- Keep behavior locked with the existing tests before any typing cleanup.

## 3. Fake tmux / Test Contract Standardization

Current state:
- `buildFakeTmuxScript()` in `src/test-support/shared-harness.ts` became the most reliable fake tmux contract.
- Several critical tests were moved or aligned to that shared contract.
- Some test files still use local fake tmux or direct env mutation patterns.

Remaining debt:
- Test surfaces are greener, but not fully uniform.
- The suite still has mixed styles for:
  - fake tmux construction
  - `tmux.log` ownership
  - `OMX_TEST_CAPTURE_*` env management
  - assertion style (`tmux.log`-first vs event-first)

Desired cleanup direction:
- Move more tests onto the shared fake tmux contract when it reduces drift.
- Keep event-first assertions where `tmux.log` proved brittle.
- Avoid mass migration; do it opportunistically in touched lanes.

## 4. Debug Artifact Ergonomics

Current state:
- `omx-debug-summary.json` and extracted artifacts were critical during recovery.
- Artifact roots currently accumulate historical runs unless manually cleared or uniquely named.

Remaining debt:
- Historical noise makes post-run reading harder.
- Summary interpretation still requires remembering that old failed artifacts can coexist with a green suite.

Desired cleanup direction:
- Add run-scoped ergonomics rather than changing trace semantics.
- Possible follow-ups:
  - filtered extraction by run root
  - clearer documentation for “historical artifacts vs current run”
  - optional cleanup helper for debug roots

## 5. Concurrency and Env Mutation Discipline

Current state:
- The worst global env mutation issues were fixed.
- Some files intentionally keep `concurrency: false` because they still share fixture or env assumptions.

Remaining debt:
- The suite is stable, but the concurrency policy is not fully normalized.
- Some tests still mutate `process.env` directly in narrow scopes.

Desired cleanup direction:
- Treat `concurrency: false` as explicit debt, not default practice.
- When touching these files later, prefer helper-scoped env handling over ad hoc mutation.
- Only remove serialization where the fixture contract is demonstrably isolated.

## Recommended Follow-up Order

1. Debug/trace layer consolidation
2. Fake tmux / test contract standardization in touched files
3. `@ts-nocheck` reduction in stabilized runtime lanes
4. Artifact ergonomics improvements
5. Concurrency policy cleanup

## Non-Goals

These are intentionally not part of this debt note:
- changing runtime behavior again
- removing the trace system
- broad refactors without test protection
- converting the entire suite to a single assertion style in one pass
