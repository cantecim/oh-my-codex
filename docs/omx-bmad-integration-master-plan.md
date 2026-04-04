# OMX x BMAD Integration Master Plan

## Purpose

This document defines the canonical master plan for integrating BMAD-aware delivery behavior into OMX without replacing OMX's runtime model or duplicating the skill surface.

The core design goal is:

- OMX remains the runtime, orchestration, and execution authority
- BMAD remains the delivery-artifact and workflow-context authority
- Integration is achieved through projection, reconciliation, and explicit writeback

This plan is intended to be the single planning artifact used to drive follow-up design work, implementation tasks, and verification loops.

## Goals

OMX should be able to detect when a repository is using BMAD and adapt its behavior accordingly. In BMAD-aware mode, OMX should:

- detect BMAD projects and installed artifact structure
- read BMAD planning and implementation artifacts as authoritative delivery context
- maintain its own runtime and orchestration state
- adapt `$ralplan`, `$ralph`, `$team`, and `$autopilot` behavior to BMAD project state
- execute story- and epic-oriented development loops against BMAD artifacts
- detect and contain drift between OMX runtime state and BMAD delivery state

## Non-Goals

The integration must not:

- reimplement BMAD's long-form human-in-the-loop authoring workflows inside OMX
- duplicate the OMX skill surface with `-bmad` suffixed variants for every core skill
- create a single unified state store shared equally by OMX and BMAD
- silently perform unrestricted bidirectional synchronization
- require BMAD-native execution surfaces in the first implementation phase

## Architectural Principles

1. OMX owns runtime behavior.
2. BMAD owns delivery artifacts.
3. Integration happens through projection plus explicit writeback.
4. Reconciliation happens at controlled boundaries, not as continuous background sync.
5. Human-authored BMAD planning workflows are respected, not cloned.
6. OMX orchestrates execution; BMAD supplies delivery structure and context.
7. Drift must be observable, classified, and recoverable.

## System Model

### OMX Authority

OMX is authoritative for runtime and orchestration concerns, including:

- active mode
- active skill
- current runtime phase
- team runtime state
- worker and subagent assignments
- verification loop state
- retry state
- resume checkpoints
- integration projection cache
- reconcile status and drift logs

### BMAD Authority

BMAD is authoritative for delivery and artifact concerns, including:

- `project-context.md`
- PRD artifacts
- UX design artifacts
- architecture artifacts
- epic and story artifacts
- sprint planning and sprint tracking artifacts
- implementation artifact lineage
- project delivery progression

### Shared Through Projection

The systems meet through derived state, not shared ownership. The projected view should include:

- current BMAD track
- current BMAD phase
- planning readiness
- implementation readiness
- active epic reference
- active story reference
- backlog summary
- story completion candidate state
- drift and writeback status

## Integration Layers

### Layer A: BMAD Detection

OMX should detect BMAD usage by scanning for signals such as:

- `_bmad/`
- `_bmad-output/`
- `_bmad-output/project-context.md`
- `_bmad-output/planning-artifacts/`
- `_bmad-output/implementation-artifacts/`
- BMAD-style PRD, architecture, epic, story, or sprint artifacts

### Layer B: Artifact Discovery

OMX should discover and index BMAD artifacts, including:

- project context
- PRD documents
- UX documents
- architecture documents
- epics and stories
- sprint status and sprint planning artifacts
- implementation output artifacts

### Layer C: Projection

OMX should derive a BMAD integration projection from discovered artifacts. This projection is not the source of truth; it is OMX's runtime-readable summary of BMAD project state.

### Layer D: Explicit Writeback

When OMX completes or advances implementation work, it may write back progress summaries to BMAD-owned artifacts through explicit writeback operations only.

### Layer E: Drift Detection

OMX must detect discrepancies between runtime assumptions and BMAD artifact state, classify them, and either reconcile automatically or stop safely.

## Authority Matrix

| Domain                           | Authority                | Notes                      |
| -------------------------------- | ------------------------ | -------------------------- |
| Runtime mode and active loop     | OMX                      | Never delegated to BMAD    |
| Worker/team state                | OMX                      | Runtime-only concern       |
| Retry and verification lifecycle | OMX                      | Runtime-only concern       |
| Project context artifact         | BMAD                     | OMX may cache a summary    |
| PRD / UX / architecture          | BMAD                     | Delivery truth             |
| Epic/story definitions           | BMAD                     | Delivery truth             |
| Sprint status                    | BMAD                     | Delivery progression truth |
| Active story projection          | BMAD-derived, OMX-cached | BMAD wins on conflict      |
| Drift status                     | OMX                      | Integration concern        |
| Writeback status                 | OMX                      | Integration concern        |

## Skill Behavior in BMAD-Aware Mode

### `$ralplan`

In BMAD-aware mode, `$ralplan` becomes a readiness gate, gap detector, and execution handoff planner.

It should:

- inspect BMAD planning and implementation artifacts
- determine the current BMAD phase
- determine whether the project is execution-ready
- identify missing artifacts or readiness gaps
- recommend the next required BMAD workflow when planning is incomplete
- hand off to `$ralph` or `$team` when the project is execution-ready

It should not:

- replicate BMAD brainstorming workflows
- replicate BMAD PRD generation workflows
- replicate BMAD architecture creation workflows
- simulate BMAD menu-driven interactive authoring flows inside OMX

### `$ralph`

In BMAD-aware mode, `$ralph` becomes a story-scoped persistent execution loop.

It should:

- bind to an active or selected BMAD story
- load `project-context.md`, architecture context, and story acceptance criteria
- execute implementation work directly through OMX runtime behavior
- run verification and review loops against BMAD-aware acceptance boundaries
- write back progress summaries explicitly

The first version should prefer OMX-native execution rather than requiring BMAD-native developer workflow invocation.

### `$team`

In BMAD-aware mode, `$team` becomes an epic- or story-aligned parallel executor.

It should:

- decompose work according to BMAD work units where possible
- inject BMAD artifacts into worker instructions
- parallelize implementation, verification, review, and integration-safe lanes
- preserve BMAD delivery boundaries while using OMX's runtime coordination

It should not attempt to parallelize long-form BMAD planning and authoring workflows in the first phase.

### `$autopilot`

In BMAD-aware mode, `$autopilot` becomes the phase-aware meta-orchestrator for the full delivery loop.

It should:

- detect whether BMAD planning artifacts are sufficient
- invoke `$ralplan`-style readiness decisions when needed
- choose between `$ralph` and `$team` for execution
- continue across stories and epics until terminal completion
- stop safely on blockers, hard drift, or missing authority

Conceptually, `$autopilot` should operate as a campaign runner for BMAD-ready projects.

## BMAD-Aware `$autopilot` Campaign Loop

### Entry Gate

Before execution begins, `$autopilot` should verify:

- BMAD project detection succeeded
- planning artifacts are sufficient
- implementation artifacts are discoverable
- active work unit selection is possible
- `project-context.md` and relevant architectural context are available

If readiness is incomplete, `$autopilot` should not begin implementation. It should route to readiness handling and stop before unsafe execution.

### Execution Loop

For BMAD-ready projects, the campaign loop should be:

1. resolve next epic/story
2. bind execution context
3. choose execution path
4. execute
5. verify
6. review
7. write back progress
8. determine story completion
9. determine epic completion
10. continue or terminate

### Execution Path Selection

- use `$ralph` for isolated, sequential story execution
- use `$team` for parallel-safe execution or verification-heavy work

### Stop Conditions

`$autopilot` should stop and surface a blocker when:

- hard drift is detected
- required artifacts are missing or ambiguous
- repeated verification or review failure crosses a threshold
- an external dependency blocks safe continuation
- human-authored BMAD workflow intervention is required

## State Design

### Runtime State

OMX should continue to maintain runtime state under `.omx/state/...`.

### Integration State

BMAD-specific integration state should live under `.omx/state/integrations/...`.

Recommended files:

- `.omx/state/integrations/bmad.json`
- `.omx/state/integrations/bmad-artifact-index.json`
- `.omx/state/integrations/bmad-reconcile-log.json`
- `.omx/state/integrations/bmad-drift-log.json`

### Recommended `bmad.json` Fields

- `detected`
- `version_hint`
- `track`
- `phase`
- `planning_readiness`
- `implementation_readiness`
- `active_epic_ref`
- `active_story_ref`
- `artifact_index_version`
- `last_reconciled_at`
- `drift_status`
- `writeback_status`

### Recommended Artifact Index Fields

- `project_context_path`
- `prd_paths`
- `ux_paths`
- `architecture_paths`
- `epic_paths`
- `story_paths`
- `sprint_status_paths`
- `implementation_artifact_paths`

## Reconciliation Model

The integration should use a reconcile-driven model rather than continuous two-way syncing.

Recommended reconcile points:

- session start
- mode transition
- before story execution
- after story completion
- before writeback
- on resume
- on detected drift

At each reconcile point:

1. rescan relevant BMAD artifacts
2. refresh OMX projection state
3. compare bindings and assumptions
4. classify drift, if any
5. continue, rebind, or stop safely

## Drift Taxonomy

### Soft Drift

Examples:

- cached artifact index is stale
- a new planning artifact appears
- a path moved but is still resolvable

Expected action:

- refresh projection
- continue without escalation

### Medium Drift

Examples:

- OMX believes story A is active, but BMAD now points to story B
- sprint status disagrees with OMX's cached active work unit

Expected action:

- warn
- rebind if safe
- log reconcile action

### Hard Drift

Examples:

- OMX marks a story complete but BMAD artifacts do not support the claim
- writeback target no longer exists
- required artifact becomes ambiguous or deleted
- active work unit cannot be resolved

Expected action:

- stop writeback
- stop autonomous advancement
- require explicit reconciliation

## Delivery Phases

### Phase 1: BMAD Awareness Foundation

Deliverables:

- BMAD detection contract
- artifact discovery and indexing
- projection schema
- integration state persistence
- reconcile trigger points
- initial drift classification

Primary outcome:

- OMX can detect and interpret BMAD project state

### Phase 2: Skill Adaptation

Deliverables:

- BMAD-aware `$ralplan`
- BMAD-aware `$ralph`
- BMAD-aware `$team`
- acceptance-aware verification logic
- explicit writeback interface

Primary outcome:

- OMX execution modes can operate safely inside BMAD delivery context

### Phase 3: Autopilot Campaign Mode

Deliverables:

- next story selection logic
- story execution state machine
- epic completion detection
- terminal completion detection
- escalation and blocker policy
- campaign ledger

Primary outcome:

- `$autopilot` can self-carry a BMAD-ready project through implementation

### Phase 4: Advanced Integration

Deliverables:

- workflow handoff helpers
- richer writeback behavior
- retrospective and status update hooks
- optional BMAD-native execution compatibility
- stronger drift recovery

Primary outcome:

- deeper and more ergonomic OMX/BMAD interoperability

## Epic-Level Task Breakdown

### Epic 1: State and Detection

1. Define the BMAD detection contract.
2. Define the artifact discovery contract.
3. Define the projection schema.
4. Implement integration state persistence.
5. Add reconcile trigger points.
6. Implement drift taxonomy and classification.
7. Add test fixtures for BMAD project shapes.

### Epic 2: Planning and Runtime Behavior

1. Define the BMAD-aware `$ralplan` behavior contract.
2. Implement readiness evaluation.
3. Implement handoff recommendation behavior.
4. Add BMAD context binding to `$ralph`.
5. Add BMAD artifact injection to `$team`.
6. Implement acceptance-aware verification.
7. Add integration tests for mode behavior.

### Epic 3: Writeback and Progress

1. Define writeback authority rules.
2. Implement story progress writeback.
3. Implement verification and review summary writeback.
4. Add conflict-safe writeback behavior.
5. Detect drift during writeback.
6. Add regression tests for writeback behavior.

### Epic 4: Autopilot Campaign Execution

1. Define backlog traversal behavior.
2. Implement next story resolution.
3. Implement the story execution state machine.
4. Implement epic completion detection.
5. Implement terminal completion detection.
6. Implement blocker and escalation rules.
7. Add end-to-end campaign tests.

### Epic 5: Hardening

1. Test stale artifact scenarios.
2. Test partial completion scenarios.
3. Test conflicting state scenarios.
4. Test interrupted session resume.
5. Test multi-epic progression.
6. Test review-fail retry loops.
7. Update docs, skill guidance, and AGENTS-related integration guidance.

## Verification Strategy

Each phase should be validated with:

- unit tests
- integration tests
- reconcile behavior tests
- drift classification tests
- writeback conflict tests
- resume tests

Key end-to-end scenarios:

1. BMAD project detected with no PRD
2. PRD exists but architecture is missing
3. Architecture and stories exist, project is execution-ready
4. Story execution fails review and retries successfully
5. Story completes and writeback succeeds
6. Epic completes and transition to next epic succeeds
7. Drift appears mid-run and is handled safely
8. Interrupted `$autopilot` run resumes correctly

## Open Design Decisions

The following decisions should be resolved explicitly during implementation planning:

1. Which artifact is authoritative for active story selection?
2. Which BMAD-owned files may OMX write back to in the first version?
3. Should retrospective and sprint-status updates be included in the first writeback scope?
4. Should BMAD-native workflow invocation exist in v1 or be deferred to a later phase?
5. How should BMAD quick-flow-style projects be modeled inside `$autopilot`?

## Minimum Viable Product

The initial MVP should include:

- BMAD detection
- artifact indexing
- projection state
- BMAD-aware `$ralplan` readiness behavior
- BMAD-aware `$ralph` story context binding
- minimal explicit writeback
- drift warnings
- foundational tests

The MVP should explicitly exclude:

- full BMAD-native workflow invocation
- advanced retrospective automation
- heavy bidirectional synchronization
- duplicate skill surfaces

## Working Method

This master plan should be executed through phased implementation loops.

For each epic:

1. write or refine the design contract
2. implement the smallest safe slice
3. verify behavior with focused tests
4. evaluate drift and integration safety
5. advance only after the phase is stable

This plan should remain the canonical top-level reference while more detailed per-epic plans and implementation loops are developed.
