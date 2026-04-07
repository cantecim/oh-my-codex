---
name: autopilot
description: Full autonomous execution from idea to working code
---

<Purpose>
Autopilot takes a brief product idea and autonomously handles the full lifecycle: requirements analysis, technical design, planning, parallel implementation, QA cycling, and multi-perspective validation. It produces working, verified code from a 2-3 line description.

When a project is BMAD-backed and already execution-ready, Autopilot also has a **BMAD campaign mode**: instead of re-running ideation/planning, it consumes BMAD artifacts, resolves the next executable story conservatively, and runs a bounded story-by-story implementation campaign until the currently discoverable backlog is exhausted or a stop condition is hit.

This current BMAD slice is implementation-campaign focused. It does not imply that the full non-BMAD Autopilot phase stack (separate expansion/planning/QA/validation phases) is replayed verbatim inside BMAD campaign mode.
</Purpose>

<Use_When>
- User wants end-to-end autonomous execution from an idea to working code
- User says "autopilot", "auto pilot", "autonomous", "build me", "create me", "make me", "full auto", "handle it all", or "I want a/an..."
- Task requires multiple phases: planning, coding, testing, and validation
- User wants hands-off execution and is willing to let the system run to completion
</Use_When>

<Do_Not_Use_When>
- User wants to explore options or brainstorm -- use `plan` skill instead
- User says "just explain", "draft only", or "what would you suggest" -- respond conversationally
- User wants a single focused code change -- use `ralph` or delegate to an executor agent
- User wants to review or critique an existing plan -- use `plan --review`
- Task is a quick fix or small bug -- use direct executor delegation
</Do_Not_Use_When>

<Why_This_Exists>
Most non-trivial software tasks require coordinated phases: understanding requirements, designing a solution, implementing in parallel, testing, and validating quality. Autopilot orchestrates all of these phases automatically so the user can describe what they want and receive working code without managing each step.
</Why_This_Exists>

<Execution_Policy>
- Each phase must complete before the next begins
- Parallel execution is used within phases where possible (Phase 2 and Phase 4)
- QA cycles repeat up to 5 times; if the same error persists 3 times, stop and report the fundamental issue
- Validation requires approval from all reviewers; rejected items get fixed and re-validated
- Cancel with `/cancel` at any time; progress is preserved for resume
- If a deep-interview spec exists, use it as high-clarity phase input instead of re-expanding from scratch
- If input is too vague for reliable expansion, offer/trigger `$deep-interview` first
- Do not enter expansion/planning/execution-heavy phases until pre-context grounding exists; if fast execution is forced, proceed only with explicit risk notes
- Default to concise, evidence-dense progress and completion reporting unless the user or risk level requires more detail
- Treat newer user task updates as local overrides for the active workflow branch while preserving earlier non-conflicting constraints
- If correctness depends on additional inspection, retrieval, execution, or verification, keep using the relevant tools until the workflow is grounded
- Continue through clear, low-risk, reversible next steps automatically; ask only when the next step is materially branching, destructive, or preference-dependent
- If BMAD is detected, do not invent or rewrite BMAD planning artifacts. Use BMAD artifacts as delivery truth and OMX state as runtime truth.
- If BMAD is detected, run the BMAD routing gate before entering the standard non-BMAD phase stack; do not start expansion/planning-heavy authoring first and "switch later."
- In BMAD campaign mode, execute one story at a time by default.
- In BMAD campaign mode, default backend is `$ralph`; use `$team` only when parallel execution is explicitly selected or when explicit runtime configuration/metadata marks it safe.
- In BMAD campaign mode, `bmad-native` execution is an explicit compatibility backend, not the default path; it must be selected by runtime configuration/metadata and still runs under OMX orchestration.
- In BMAD campaign mode, never guess the active story when multiple candidates remain unresolved; stop and report ambiguity instead.
- In BMAD campaign mode, do not write BMAD story/sprint artifacts directly; delegate bounded writeback to `$ralph` or `$team`, then re-read BMAD artifacts to confirm completion.
- In BMAD campaign mode, implementation-side hooks may write OMX-authored story/epic summaries under the configured BMAD `output_folder` implementation-artifacts directory; these enrich evidence but do not replace BMAD delivery truth.
</Execution_Policy>

<Steps>
0. **Pre-context Intake (required before Phase 0 starts)**:
   - Derive a task slug from the request.
   - Load the latest relevant snapshot from `.omx/context/{slug}-*.md` when available.
   - If no snapshot exists, create `.omx/context/{slug}-{timestamp}.md` (UTC `YYYYMMDDTHHMMSSZ`) with:
     - Task statement
     - Desired outcome
     - Known facts/evidence
     - Constraints
     - Unknowns/open questions
     - Likely codebase touchpoints
   - If ambiguity remains high, run `explore` first for brownfield facts, then run `$deep-interview --quick <task>` before proceeding.
   - Carry the snapshot path into autopilot artifacts/state so all phases share grounded context.

0.5 **BMAD routing gate (evaluate before entering the standard non-BMAD phase stack when BMAD artifacts are present)**:
   - Detect BMAD from `_bmad/`, `_bmad/core/config.yaml`, the configured `output_folder` (fallback `_bmad-output`), `project-context.md`, planning artifacts, and implementation artifacts.
   - Reconcile BMAD integration state before choosing a path.
   - Treat `.omx/state/integrations/bmad.json` and `.omx/state/integrations/bmad-artifact-index.json` as the canonical BMAD runtime boundary for all BMAD-aware autopilot work.
   - If BMAD is detected but **not** execution-ready:
     - stop before expansion/planning-heavy implementation flow begins
     - report the missing BMAD workflow category:
       - `create-prd`
       - `create-architecture`
       - `create-epics-and-stories`
       - `manual-bmad-resolution`
   - If BMAD is detected and execution-ready:
     - skip the standard non-BMAD expansion/planning/linear pipeline path
     - enter **BMAD campaign mode**
   - If BMAD is not detected:
     - continue with the standard non-BMAD phase stack below

1. **Phase 0 - Expansion (non-BMAD path)**: Turn the user's idea into a detailed spec
   - If `.omx/specs/deep-interview-*.md` exists for this task: reuse it and skip redundant expansion work
   - If prompt is highly vague: route to `$deep-interview` for Socratic ambiguity-gated clarification
   - Analyst (THOROUGH tier): Extract requirements
   - Architect (THOROUGH tier): Create technical specification
   - Output: `.omx/plans/autopilot-spec.md`

2. **Phase 1 - Planning (non-BMAD path)**: Create an implementation plan from the spec
   - Architect (THOROUGH tier): Create plan (direct mode, no interview)
   - Critic (THOROUGH tier): Validate plan
   - Output: `.omx/plans/autopilot-impl.md`

3. **Phase 2 - Execution**
   - Non-BMAD path: implement the plan using Ralph + Ultrawork
   - LOW-tier executor/search roles: Simple tasks
   - STANDARD-tier executor roles: Standard tasks
   - THOROUGH-tier executor/architect roles: Complex tasks
   - Run independent tasks in parallel
   - BMAD campaign path:
     1. Reconcile BMAD state
     2. Resolve the next story conservatively
     3. If ambiguous, stop with an explicit ambiguity result
     4. Select backend (`$ralph` by default, `$team` only when explicitly enabled by runtime configuration/metadata)
        - `bmad-native` is a compatibility backend used only when explicitly selected
     5. Execute exactly one story
     6. Reconcile BMAD state again
     7. Confirm completion from BMAD-side artifacts
     8. Emit implementation-side hook artifacts when story/epic completion is confirmed
     9. Continue to the next story only when completion is confirmed

4. **Phase 3 - QA**:
   - Non-BMAD path: cycle until all tests pass (UltraQA mode)
   - Build, lint, test, fix failures
   - Repeat up to 5 cycles
   - Stop early if the same error repeats 3 times (indicates a fundamental issue)
   - BMAD campaign path: do not assume a separate global QA phase exists. Treat verification evidence as part of each story execution/completion loop unless a later BMAD-specific phase adds broader QA orchestration.

5. **Phase 4 - Validation**:
   - Non-BMAD path: multi-perspective review in parallel
   - Architect: Functional completeness
   - Security-reviewer: Vulnerability check
   - Code-reviewer: Quality review
   - All must approve; fix and re-validate on rejection
   - BMAD campaign path: do not assume a separate campaign-wide validation phase exists in the current implementation slice. Any broader BMAD validation layer should be treated as a later-phase extension unless explicitly implemented.

6. **Phase 5 - Cleanup**: Clear all mode state via OMX MCP tools on successful completion
   - `state_clear({mode: "autopilot"})`
   - `state_clear({mode: "ralph"})`
   - `state_clear({mode: "ultrawork"})`
   - `state_clear({mode: "ultraqa"})`
   - Or run `/cancel` for clean exit
</Steps>

<Tool_Usage>
- Before first MCP tool use, call `ToolSearch("mcp")` to discover deferred MCP tools
- Use `ask_codex` with `agent_role: "architect"` for Phase 4 architecture validation
- Use `ask_codex` with `agent_role: "security-reviewer"` for Phase 4 security review
- Use `ask_codex` with `agent_role: "code-reviewer"` for Phase 4 quality review
- Agents form their own analysis first, then consult Codex for cross-validation
- If ToolSearch finds no MCP tools or Codex is unavailable, proceed without it -- never block on external tools
- For BMAD-backed repositories, prefer existing OMX BMAD integration helpers/state over ad-hoc artifact interpretation.
</Tool_Usage>

## State Management

Use `omx_state` MCP tools for autopilot lifecycle state.

- **On start**:
  `state_write({mode: "autopilot", active: true, current_phase: "expansion", started_at: "<now>", state: {context_snapshot_path: "<snapshot-path>"}})`
- **On phase transitions**:
  `state_write({mode: "autopilot", current_phase: "planning"})`
  `state_write({mode: "autopilot", current_phase: "execution"})`
  `state_write({mode: "autopilot", current_phase: "qa"})`
  `state_write({mode: "autopilot", current_phase: "validation"})`
- **In BMAD campaign mode**:
  `state_write({mode: "autopilot", current_phase: "bmad-campaign", state: {bmad_detected: true, bmad_campaign_active: true, bmad_active_story_path: "<story-path>", bmad_active_epic_path: "<epic-path>", bmad_backend: "ralph", bmad_campaign_iteration: <current>}})`

  Typical additive BMAD runtime fields include:
  - `bmad_detected`
  - `bmad_phase`
  - `bmad_ready_for_execution`
  - `bmad_campaign_active`
  - `bmad_active_story_path`
  - `bmad_active_epic_path`
  - `bmad_remaining_story_paths`
  - `bmad_completed_story_paths`
  - `bmad_stop_reason`
  - `bmad_backend`
  - `bmad_context_blocked_by_ambiguity`
  - `bmad_writeback_blocked`
  - `bmad_campaign_iteration`
  - `bmad_execution_family`
  - `bmad_drift_recovery_attempted`
  - `bmad_drift_recovery_succeeded`
  - `bmad_drift_recovery_reason`
  - `bmad_last_hook_artifact_paths`

  These are OMX runtime/projection fields. They do not replace BMAD artifact authority, and they must stay consistent with canonical BMAD integration state under `.omx/state/integrations/`.
- **On completion**:
  `state_write({mode: "autopilot", active: false, current_phase: "complete", completed_at: "<now>"})`
- **On cancellation/cleanup**:
  run `$cancel` (which should call `state_clear(mode="autopilot")`)


## Scenario Examples

**Good:** The user says `continue` after the workflow already has a clear next step. Continue the current branch of work instead of restarting or re-asking the same question.

**Good:** The user changes only the output shape or downstream delivery step (for example `make a PR`). Preserve earlier non-conflicting workflow constraints and apply the update locally.

**Bad:** The user says `continue`, and the workflow restarts discovery or stops before the missing verification/evidence is gathered.

<Examples>
<Good>
User: "autopilot A REST API for a bookstore inventory with CRUD operations using TypeScript"
Why good: Specific domain (bookstore), clear features (CRUD), technology constraint (TypeScript). Autopilot has enough context to expand into a full spec.
</Good>

<Good>
User: "build me a CLI tool that tracks daily habits with streak counting"
Why good: Clear product concept with a specific feature. The "build me" trigger activates autopilot.
</Good>

<Bad>
User: "fix the bug in the login page"
Why bad: This is a single focused fix, not a multi-phase project. Use direct executor delegation or ralph instead.
</Bad>

<Bad>
User: "what are some good approaches for adding caching?"
Why bad: This is an exploration/brainstorming request. Respond conversationally or use the plan skill.
</Bad>
</Examples>

<Escalation_And_Stop_Conditions>
- Stop and report when the same QA error persists across 3 cycles (fundamental issue requiring human input)
- Stop and report when validation keeps failing after 3 re-validation rounds
- Stop when the user says "stop", "cancel", or "abort"
- If requirements were too vague and expansion produces an unclear spec, pause and redirect to `$deep-interview` before proceeding
- In BMAD campaign mode, stop immediately on:
  - hard BMAD drift
  - ambiguous active story
  - backend failure
  - writeback blocked with no confirmable completion
  - story still incomplete after a bounded execution attempt
</Escalation_And_Stop_Conditions>

<Final_Checklist>
- [ ] All 5 phases completed (Expansion, Planning, Execution, QA, Validation)
- [ ] All validators approved in Phase 4
- [ ] Tests pass (verified with fresh test run output)
- [ ] Build succeeds (verified with fresh build output)
- [ ] State files cleaned up
- [ ] User informed of completion with summary of what was built
</Final_Checklist>

<Advanced>
## Configuration

Optional settings in `~/.codex/config.toml`:

```toml
[omx.autopilot]
maxIterations = 10
maxQaCycles = 5
maxValidationRounds = 3
pauseAfterExpansion = false
pauseAfterPlanning = false
skipQa = false
skipValidation = false
```

## Resume

If autopilot was cancelled or failed, run `/autopilot` again to resume from where it stopped.

## Recommended Clarity Pipeline

For ambiguous requests, prefer:

```
deep-interview -> ralplan -> autopilot
```

- `deep-interview`: ambiguity-gated Socratic requirements
- `ralplan`: consensus planning (planner/architect/critic)
- `autopilot`: execution + QA + validation

## Best Practices for Input

1. Be specific about the domain -- "bookstore" not "store"
2. Mention key features -- "with CRUD", "with authentication"
3. Specify constraints -- "using TypeScript", "with PostgreSQL"
4. Let it run -- avoid interrupting unless truly needed

## Pipeline Orchestrator (v0.8+)

Autopilot can be driven by the configurable pipeline orchestrator (`src/pipeline/`), which
sequences stages through a uniform `PipelineStage` interface:

```
RALPLAN (consensus planning) -> team-exec (Codex CLI workers) -> ralph-verify (architect verification)
```

Pipeline configuration options:

```toml
[omx.autopilot.pipeline]
maxRalphIterations = 10    # Ralph verification iteration ceiling
workerCount = 2            # Number of Codex CLI team workers
agentType = "executor"     # Agent type for team workers
```

The pipeline persists state via `pipeline-state.json` and supports resume from the last
incomplete stage. See `src/pipeline/orchestrator.ts` for the full API.

## BMAD Campaign Mode (v0.11+)

When BMAD artifacts are present and execution-ready, autopilot may use a dedicated BMAD campaign runner instead of the generic stage-linear pipeline.

Behavior:
- consumes BMAD artifacts as execution context
- runs sequential story traversal
- defaults to `$ralph`
- treats `$team` as opt-in
- confirms completion by re-reading BMAD artifacts after each story run
- stops conservatively on ambiguity or drift instead of guessing
- this describes the current implementation slice, not a promise that all classic Autopilot phases are replayed inside BMAD mode

## Troubleshooting

**Stuck in a phase?** Check TODO list for blocked tasks, run `state_read({mode: "autopilot"})`, or cancel and resume.

**QA cycles exhausted?** The same error 3 times indicates a fundamental issue. Review the error pattern; manual intervention may be needed.

**Validation keeps failing?** Review the specific issues. Requirements may have been too vague -- cancel and provide more detail.
</Advanced>
