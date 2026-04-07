# BMAD Integration Follow-up

This document is the single follow-up backlog for BMAD integration work that remains after the current BMAD integration hardening passes.

The current shipped state is:

- BMAD project detection, indexing, readiness, campaign routing, and configured output root handling are implemented and regression-tested
- BMAD canonical integration state persistence is implemented for OMX CLI/runtime entry points
- real-drive validation exists for both `_bmad-output` and `docs`-root project shapes

The remaining work is no longer about basic BMAD support. It is about closing the gap between:

- the OMX CLI/runtime entry surfaces
- the skill-driven execution surfaces

and about fixing one real production bug exposed by an actual BMAD project.

Status update as of 2026-04-06:

- BMAD `output_folder` placeholder resolution is now fixed in runtime/config handling
- BMAD skill/runtime bridge enforcement is now fixed in the `omx_state` server for BMAD-aware `state_write` calls
- remaining validation is production confirmation on real installed skill-driven runs, not repo-side implementation work

## 1. BMAD `output_folder` Placeholder Resolution Bug

Status: implemented

### Problem

Real BMAD projects may configure:

- `output_folder: "{project-root}/docs"`

in `_bmad/core/config.yaml`.

Today, OMX runtime detection may preserve that placeholder literally instead of resolving it to a canonical relative output root such as:

- `docs`

When that happens:

- BMAD is detected
- canonical `bmad.json` / `bmad-artifact-index.json` may be written
- but the artifact index is effectively empty
- `projectContextPath`, `prdPaths`, `architecturePaths`, `storyPaths`, and `sprintStatusPaths` come back empty
- derived phase/readiness become wrong

### Desired Outcome

BMAD config resolution must treat placeholder-based output roots as first-class supported values.

Expected behavior:

- `"{project-root}/docs"` resolves to `docs`
- `"{project-root}/some/nested/path"` resolves to `some/nested/path`
- canonical artifact indexing uses the resolved relative root
- canonical state and mode-local BMAD fields reflect the real project shape

### Implementation Direction

- fix BMAD config/output-root normalization at the config/discovery boundary
- normalize resolved BMAD output roots to a project-relative canonical path before discovery/indexing
- preserve existing support for `_bmad-output`, `docs`, and custom relative roots
- do not introduce absolute-path leakage into canonical BMAD state unless there is a compelling compatibility reason

### Acceptance

- `_bmad/core/config.yaml` with `output_folder: "{project-root}/docs"` yields:
  - `outputRoot: "docs"`
  - non-empty artifact index for real docs-root BMAD projects
- `phase`, `storyPaths`, `sprintStatusPaths`, and `projectContextPath` reflect the actual repository
- current BMAD regression gates remain green

## 2. BMAD Skill/Runtime Bridge Alignment

Status: implemented in repo, pending real-run confirmation

### Problem

The OMX CLI/runtime entry points now run canonical BMAD reconciliation before BMAD-aware state updates.

However, transcript evidence from real `$autopilot`, `$ralplan`, and `$ralph` runs shows that skill-driven flows can still:

- write BMAD-aware mode-local state directly
- create `.omx/context/...` and `.omx/plans/...` artifacts
- proceed with Story/acceptance-aware work
- without a visible canonical BMAD reconcile/persistence step

In practice, this means:

- `autopilot-state.json`, `ralplan-state.json`, or `ralph-state.json` may contain rich `bmad_*` fields
- while `.omx/state/integrations/bmad.json` and `.omx/state/integrations/bmad-artifact-index.json` may still be absent or stale

### Desired Outcome

BMAD-aware skill execution must obey the same canonical contract as OMX CLI/runtime entry points:

- if a skill-driven flow exposes BMAD phase/story/readiness fields
- then canonical BMAD integration reconciliation has already happened

### Implementation Direction

- audit the actual `$autopilot`, `$ralplan`, and `$ralph` skill/runtime bridge paths
- find where they currently write mode-local BMAD state directly
- route those paths through the same canonical BMAD reconcile helper/contract used by OMX runtime entry points
- make skill text and runtime behavior match exactly:
  - BMAD context gate must not be advisory only
  - canonical reconcile must be an enforced precondition

This is not primarily a docs-only task.

It may require:

- runtime bridge changes
- skill wording tightening
- or both

### Acceptance

- real skill-driven `$autopilot` runs leave:
  - `.omx/state/integrations/bmad.json`
  - `.omx/state/integrations/bmad-artifact-index.json`
- real skill-driven `$ralplan` runs leave the same canonical artifacts
- real skill-driven `$ralph` runs leave the same canonical artifacts
- mode-local `bmad_*` fields and canonical BMAD state do not drift apart

### Implementation Notes

Repo-side enforcement now happens in the `omx_state` MCP server:

- BMAD-aware `state_write` calls for `autopilot`, `ralph`, `ralplan`, and `team`
- force canonical BMAD reconcile first
- persist explicit story/epic selections back into canonical BMAD state when a skill/runtime path supplies them
- then normalize additive `bmad_*` mode-local fields from canonical BMAD state, readiness, and execution context

This closes the skill/runtime bridge gap inside OMX even when a skill-driven flow writes BMAD mode-local state directly.

## Verification Strategy

Verification for this follow-up must use both kinds of evidence:

1. repo regression tests
2. real transcript / real project validation

Minimum proof bar:

- targeted BMAD regression suites are green
- a real BMAD project using installed OMX shows correct `integrations/` artifacts
- transcript evidence confirms the canonical BMAD reconcile contract is actually exercised in skill-driven flows

## Priority

Priority order:

1. Real installed skill-driven validation of BMAD canonical reconcile artifacts

Rationale:

- the placeholder-resolution bug breaks even correctly installed CLI/runtime flows on real BMAD repos
- the skill/runtime bridge issue is also important, but it should be fixed on top of correct canonical config/output-root resolution

## Notes

- This follow-up is separate from deferred team env-threading work
- This follow-up is also separate from `.bmad-orchestrator`; that surface is out of scope for OMX BMAD integration evaluation
