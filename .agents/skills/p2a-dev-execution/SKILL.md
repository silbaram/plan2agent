---
name: p2a-dev-execution
description: Use when implementing one ready Plan2Agent task or a bounded batch of independent ready tasks into real code changes and recording each run, without touching planning artifacts.
---

# Plan2Agent Dev Execution

Implement one approved ready Plan2Agent task, or a bounded batch from one ready snapshot, as real code changes in its target project. Record every task as its own run and hand back verification and integration results. This skill is for execution only: it does not author planning artifacts, change gates, or broaden any approved task scope.

## When to use

Use this skill only when all of these conditions are true before starting:

- Every selected task is exposed by the same `p2a_tasks ready` snapshot.
- The Gate B spec is approved and `open_decisions` is empty.
- The Gate D review has no blockers.
- Every selected task has acceptance criteria.
- The user explicitly asks for implementation execution.

If any condition is missing, stop and report the missing prerequisite instead of implementing.

Use single-task mode unless the user asks to execute multiple ready tasks, or explicitly accepts a proposed bounded batch. Batch mode is supervised orchestration inside one foreground session, not permission to start a headless scheduler.

## Inputs

Use these inputs:

- Artifact root, or `--graph` when operating from an explicit task graph.
- One ready task id, or an exact list selected from one ready snapshot.
- `agent-tool`, usually `codex`.
- Optional existing run id per task.
- Optional maximum batch concurrency, capped by the foreground provider's available write-capable subagent slots.
- For batch mode, a user-approved canonical integration branch/worktree, an owner-only per-task integration-candidate worktree/branch strategy, and its committed base ref.


## Provider Confinement Policy

Codex write-capable runs use native `workspace-write` sandbox confinement inside the assigned run workspace or isolated worktree. Claude write-capable runs require scaffold confinement with deny rules, a PreToolUse hook, and the macOS/Linux OS sandbox, and they must stay on the foreground, human-supervised approval path for now. Do not switch Claude to unattended `permissionMode` auto/background until the cross-OS spike is complete and a human explicitly approves that mode. Gemini remains read-only; do not pursue write-capable Gemini implementers. For Gemini, main-session fallback means stopping write execution and handing the ready task or frozen batch to a foreground write-capable Codex or approved Claude owner; it is not a single-task write fallback inside Gemini. For every provider, writes remain limited to the assigned workspace/worktree, and harness files or paths outside that workspace are forbidden.

Batch mode must use one write-capable provider within one foreground supervised session. Do not mix providers in one write batch. When the provider cannot create independently confined write-capable subagents, or available capacity is one, fall back to the single-task procedure.

## Procedure

1. Confirm the target task is ready and inspect its implementation context:

   ```bash
   node .plan2agent/scripts/p2a_tasks.mjs ready --artifacts <dir>
   ```

   Use the task `prompt` to understand the scoped work, acceptance criteria, target area, and relevant constraints.

2. Start a run unless the user provided an existing run id. When using Codex, create an isolated worktree so the write-capable implementer is confined by Codex's `workspace-write` sandbox:

   ```bash
   node .plan2agent/scripts/p2a_execute.mjs start --artifacts <dir> --task <id> --agent-tool codex --isolation worktree --worktree <fresh-worktree-path> --create-isolation
   ```

   Preserve one run identity across start retries. An explicit `--run-id` always wins. When `project.config.json.runTracking.runIdStrategy` is `task-sequence`, omit `--run-id` on the first start so the CLI atomically reserves the next id from `runIdPattern`; if isolation setup fails, correct the cause and use the printed retry command with that same explicit id. Do not invoke a fresh implicit start after failure because it intentionally allocates the next attempt id. Projects that keep the default `timestamp` strategy retain timestamp-based ids.

   Use `p2a_execute start`, not raw `p2a_runs start`, because it creates the run and marks the task `in_progress` in one lifecycle step. If the task requires independent monitor evidence, pass `--require-monitor` so the run records a monitor gate requirement.

   The worktree path must be a fresh empty path, following the `project.config.json` `runTracking.worktreePattern` convention (for example, `../.worktrees/<taskId>-<runId>`).
   Run this command from an existing git workspace; the fresh worktree path does not need to exist before `--create-isolation`.

   Follow the Provider Confinement Policy in this skill for Codex, Claude, and Gemini execution modes.

3. Before implementing, ensure the target project has a committed source-code git baseline, excluding local `.plan2agent/` state. If there is pre-existing untracked application source, commit or intentionally ignore it first; otherwise `p2a_runs finish --collect-git` records the entire untracked source tree as this task's `changedFiles` instead of only the files this task changed.

4. Before implementing, check whether the target project contains `.plan2agent/style.md`. If it exists, read it and pass the style contract to the implementer, including any spawned `p2a-implementer` subagent, and require the implementation to follow it. When possible, spawn the `p2a-implementer` subagent to perform the implementation inside the isolated worktree.

5. Implement the task while obeying the writing boundaries below, the project style contract when present, and the Provider Confinement Policy in this skill.

   The spawned `p2a-implementer` subagent performs scoped file edits only. It may optionally run local checks for self-review, but it must not call `p2a_runs verify`, `p2a_runs finish`, or `p2a_tasks done|block`. Unless lifecycle delegation is explicitly requested, those lifecycle steps belong to the main dev-execution owner running this skill.

6. Verify the run with the required checks by actually executing configured or explicitly requested commands. You may verify before finish:

   ```bash
   node .plan2agent/scripts/p2a_runs.mjs verify --run-id <id> --artifacts <dir> --test --lint --typecheck
   ```

   `p2a_runs verify` must execute the configured or explicitly requested verification commands and capture their exit codes as `source: config` or `source: command`. Do not self-report verification with a manual record; do not use `source: manual` or `exitCode: null` as a substitute for executed verification.

   If the user provides explicit verification commands, pass them through as explicit commands such as `--test-command`, `--lint-command`, or `--typecheck-command`. Config-only verification flags such as `--test`, `--lint`, and `--typecheck` auto-detect project commands when config is empty, then skip only if no command can be detected. Use explicit commands whenever config is empty and real verification is required.

   For supplemental `--verify-command` checks, use only the supported verification types `test`, `lint`, `typecheck`, and `custom`. Record checks outside the three primary types with the `custom:<command>` form:

   ```bash
   node .plan2agent/scripts/p2a_runs.mjs verify --run-id <id> --artifacts <dir> --verify-command 'custom:git diff --check'
   ```

   Do not invent labels such as `format:`, `repeatability:`, or `dependency-policy:` as metadata. An unrecognized prefix remains part of the executable command, so `format:npm run format:check` attempts to execute that full string as a custom command. A failed or unavailable verification record is immutable evidence; correct the syntax and start a new retry run instead of rewriting the original record.

   Verification shell composition must preserve failures from every command that provides evidence. Do not use `test -z "$(command)"` directly: if `command` cannot execute, the substitution can become an empty string and the outer `test` can still exit zero. Capture the output only after propagating the producer's status:

   ```bash
   node .plan2agent/scripts/p2a_runs.mjs verify --run-id <id> --artifacts <dir> --verify-command "custom:sh -c 'output=\$(gofmt -l <files>) || exit \$?; test -z \"\$output\"'"
   ```

   Preflight an absolute executable path with `test -x <path>` before using it. Avoid pipelines that can hide an earlier command failure behind the last process's exit code; use an explicit status-preserving wrapper or a project script with strict pipeline handling. Before finish, audit executed verification entries for non-empty `stderrTail` or evidence that a required executable did not run, even when an outer shell command returned zero. The runtime classifies POSIX shell executable-resolution errors as `unavailable`, including errors hidden inside compound commands.

7. Run the independent monitor gate before finish when the run was started with `--require-monitor`. Invoke `p2a-performance-monitor` as a separate subagent when the CLI supports spawning subagents, or perform a separated read-only review pass when spawning is unavailable. Pass the target task id, acceptance criteria, and the latest run log for that task, including `verification`, `changedFiles`, `status`, and `workspaceRef`.

   Write the monitor result beside the run file, normally `runs/<iterationId>/<runId>.monitor-verdict.json` (legacy flat runs remain readable), using this shape:

   ```json
   {
     "verdict": "confirm_done",
     "unmet_acceptance": [],
     "verification_concerns": [],
     "scope_concerns": [],
     "needs_user_decision": [],
     "note": ""
   }
   ```

   Use `verdict: "block"` and fill the relevant concern array when the task should not be accepted. When multiple concern arrays are populated, failure-class mapping priority is `scope_concerns` → `verification_concerns` → `unmet_acceptance` → `needs_user_decision`. `p2a_execute finish` and `p2a_runs finish` both enforce this verdict when the run requires a monitor gate.

8. Run the style-rating pass before finish when the target project contains `.plan2agent/style.md` with at least one filled section. If `.plan2agent/style.md` exists and has any filled section, this pass is required before finish. Invoke `p2a-style-rater` as a separate read-only subagent when the CLI supports spawning subagents, or perform a separated read-only review pass when spawning is unavailable. Pass the target task id, the run's `changedFiles` list, and the complete `.plan2agent/style.md` contents.

   Persist a style-verdict sidecar only when the result contains a concrete violation (`violationCount > 0`). Write that result beside the run file, normally `runs/<iterationId>/<runId>.style-verdict.json` (legacy flat runs remain readable), using this shape:

   ```json
   {
     "sections": [
       {
         "section": "...",
         "verdict": "followed|violated|not_applicable",
         "violations": [
           { "file": "...", "line": 0, "note": "..." }
         ]
       }
     ],
     "violationCount": 1,
     "note": ""
   }
   ```

   Do not create a style-verdict file for a clean or non-applicable result. Instead, append exactly one of these durable run-note forms so absence of a sidecar never ambiguously means that the review was omitted:

   - `STYLE_REVIEW: pass; violationCount=0`
   - `STYLE_REVIEW: not_applicable; reason=<reason>`
   - `STYLE_REVIEW: skipped; reason=<reason>`
   - `STYLE_REVIEW: violations; violationCount=<count>; ref=<artifact-root-relative-style-verdict-path>`

   Silent omission is forbidden. This style review is informational only and must never affect `p2a_execute finish`, `p2a_runs finish`, `p2a_tasks done`, `p2a_tasks block`, monitor verdicts, failure classes, or any done/block decision. Once a positive style-verdict is recorded, its `sections`, `violations`, and `violationCount` are historical record and must never be edited. Existing zero-violation verdict files are also historical records: do not delete or rewrite them when adopting this prospective policy. If a violation is resolved later, append a dated `RESOLUTION:` line to the verdict `note` field or leave a fresh verdict from a later run's re-rating; do not rewrite the original finding fields. Retroactive rating is allowed when a run session omitted the pass: persist a sidecar only if the retroactive result has violations, and state that the rating is retroactive in the sidecar note or clean-result run note. If `violationCount > 0`, carry the violations forward as candidate evidence for the step 10 retrospective style proposal with `target: "project"` and `targetFiles: [".plan2agent/style.md"]`. When the user decides to fix recorded violations, the default path is to register the work as a maintenance task with `p2a.mjs iteration maintenance add` and execute it with run history. If an exception requires an immediate ad-hoc fix, include the rationale and the source style-verdict path in the commit message.

9. Finish the run through `p2a_execute`, collecting git state and letting the CLI mark the task done or blocked:

   ```bash
   node .plan2agent/scripts/p2a_execute.mjs finish --run-id <id> --artifacts <dir> --status finished|failed|blocked --collect-git
   ```

   You can also pass `--test`, `--lint`, `--typecheck`, or explicit `--*-command` flags to this finish command instead of running step 6 separately.

   When finishing with `--status failed` or `--status blocked`, include `--failure-class <class>` and structured debug detail: at least one `--repro-step` or `--repro-command`, at least one `--localization` or `--localized-file`, and at least one `--guard` or `--guard-note`. The supported classes are `verification_failed`, `test_flake`, `scope_violation`, `missing_dependency`, `environment_failure`, `implementation_incomplete`, and `other`. The CLI fills `retryable`, `needsUserDecision`, and `source` from the class defaults; use `--retryable`, `--needs-user-decision`, or `--failure-source` only when the default is wrong. Use `--failure-class other` only as an escape hatch and always include at least one `--note` explaining why no more specific class applies.

   Only classify a failure as `test_flake` when there is concrete evidence such as a failing verification command passing on rerun without code or environment changes. Without that evidence, use `verification_failed` for verification failures.

   If the monitor verdict blocks the run, do not call `p2a_tasks done`. Finish through `p2a_execute finish` with monitor-sourced failure metadata and structured detail. The CLI maps `unmet_acceptance` to `implementation_incomplete`, `verification_concerns` to `verification_failed`, `scope_concerns` to `scope_violation`, and `needs_user_decision` to `missing_dependency`.

10. After finish has updated the task graph, evaluate and, when eligible, run the milestone review checkpoint described below. This checkpoint is informational and does not change the just-finished run or task status.

11. Complete the retrospective gate described below.

## Supervised Batch Owner Procedure

Batch mode wraps the single-task lifecycle; it does not create a batch run, change schemas, or delegate lifecycle ownership. Each task keeps its own run id, worktree, verification evidence, monitor verdict, style result, finish, milestone eligibility check, and retrospective.

### 1. Freeze one ready snapshot and select a bounded batch

Run `p2a_tasks ready` once and freeze that result as the current ready snapshot. Select at most the user-approved concurrency limit and never add tasks that become ready while the batch is running. Because ready tasks already have every declared dependency in `done`, no selected task can directly depend on another selected task.

Before starting, inspect task descriptions, target areas, acceptance criteria, and known implementation surfaces. Remove tasks from the batch, or reduce concurrency to one, when they are likely to overlap on the same files, shared configuration, database schema, generated artifacts, API contracts, or another integration-sensitive resource. Worktrees isolate edits; they do not eliminate integration conflicts or hidden semantic dependencies.

Establish a committed `batchBase`, a user-approved canonical integration branch/worktree, and a fresh owner-only integration-candidate worktree/branch strategy. Do not use a dirty user checkout as either integration target. The canonical integration branch is the only base that may open the next dependency batch; a task worktree or integration candidate by itself is never canonical.

### 2. Start every run serially

The main dev-execution owner calls `p2a_execute start` once per selected task, one at a time. Use a fresh worktree and branch for each task and pass the same committed `--base-ref <batch-base>`:

```bash
node .plan2agent/scripts/p2a_execute.mjs start \
  --artifacts <dir> \
  --task <task-id> \
  --agent-tool codex \
  --isolation worktree \
  --worktree <fresh-task-worktree> \
  --base-ref <batch-base> \
  --create-isolation
```

Maintain an owner-side mapping for `taskId`, `runId`, `branch`, `worktree`, `baseRef`, and implementer. Do not spawn an implementer when its start failed. A failed start does not require canceling runs that were already started for other independent tasks.

Only the main owner may call `p2a_execute start`, `p2a_runs record|verify|finish`, `p2a_execute finish`, or `p2a_tasks done|block`. This remains true even when lifecycle CLIs are internally lock-safe.

### 3. Spawn implementations in parallel

After the selected runs have started, spawn one `p2a-implementer` per task inside its assigned worktree, up to the approved concurrency limit. Pass each implementer only its task prompt, acceptance criteria, constraints, style contract, run identity, and worktree boundary.

Each implementer performs scoped file edits and optional local self-checks only. It must return changed files, checks, results, and blockers to the main owner. It must not edit planning artifacts, harness files, another worktree, the canonical integration worktree, or lifecycle state. Agent completion order does not control harvest order.

### 4. Harvest and integrate one task at a time

The main owner harvests one completed result at a time:

1. Inspect the task worktree diff and reject scope drift or boundary violations.
2. Freeze the task-specific changed-file list before creating a commit or patch. Do not attribute the cumulative integration worktree status to one task.
3. Materialize a reproducible task-scoped commit or patch under main-owner control.
4. Apply it to an integration candidate based on the latest canonical integration head. Do not auto-resolve conflicts and do not advance the canonical integration branch yet.
5. Run configured or explicit verification against the integrated candidate. Task-worktree self-checks do not replace integrated-state verification.
6. Record the exact task changed files and an `INTEGRATION:` run note containing the candidate base, integrated commit or patch identity, and verification workspace. When verification runs outside the original task worktree, pass `--workspace <integration-candidate>` explicitly.
7. Run the existing monitor gate and style-rating passes against the task evidence and integrated candidate when they apply.
8. Advance the canonical integration branch only after the candidate is conflict-free, required verification passed, and required monitor evidence accepts it.
9. Only after the canonical integration branch contains the accepted task result, call `p2a_execute finish` and allow the task to transition to `done`.

In batch mode, do not rely on `--collect-git` from the cumulative integration worktree for task attribution. Record the frozen task-specific changed files explicitly. A clean integration worktree after committing is valid when the run already contains the correct changed-file evidence.

If spawn, scope review, integration, verification, or a required monitor gate fails, do not advance the canonical integration branch for that task and do not mark it `done`. Close it through the existing structured `failed` or `blocked` contract when the cause is known, or keep it active when user input is required before a truthful close. Other independent task results may continue through serial harvest.

### 5. Recompute ready only after the batch harvest

After every selected task has been harvested or given a truthful non-done disposition, run `p2a_tasks ready` again. Start the next batch from the latest canonical integration head. A dependent task must not start from its predecessor's isolated task branch or from the old batch base.

Evaluate milestone review eligibility after each successful serial finish, using the task-graph state at that point. Do not run milestone passes concurrently and do not use their informational findings as a substitute for integrated-state verification.

### 6. Preserve recoverability and clean up safely

Never force-remove a dirty, unmerged, failed, or blocked task or integration-candidate worktree. An accepted task or integration-candidate worktree becomes a cleanup candidate only after its task result is durably present on the canonical integration branch and its run evidence contains the recovery references. A failed or blocked integration candidate remains recoverable until the user explicitly chooses a cleanup path. Cleanup still requires explicit user confirmation or an already approved project cleanup policy.

Do not use destructive reset, forced branch movement, automatic conflict resolution, remote push, PR creation, or remote merge as part of this batch procedure.

## Writing boundaries and prohibitions

- Implement only inside the separate target project. Do not write to the Plan2Agent repository itself, including `.agents/`, `.claude/`, `.codex/`, `.gemini/`, `.plan2agent/scripts/`, `.plan2agent/schemas/`, `plans/`, or `docs/`.
- Limit implementation writes to the run `workspaceRef` or worktree. In supervised batch mode, the main dev-execution owner may also create task-scoped local commits or patches and write to the approved canonical integration worktree plus the owner-only integration-candidate worktree created from its latest head. The main owner may write the lifecycle artifacts explicitly defined by this skill: run verdicts, milestone-review JSON, and retrospective proposals. Spawned implementation and review subagents remain unable to write integration or lifecycle artifacts.
- Do not add or rewrite requirements by bypassing planning artifacts.
- Do not install dependencies without grounded evidence from the approved task, existing project conventions, or explicit user approval.
- In a co-located project where harness files live alongside app code, do not run interactive scaffolders that may overwrite or prompt in a non-empty directory, such as `npm create vite .`. Write config files manually and install only dependencies.
- Do not access, print, or exfiltrate `.env` files, credentials, or tokens.
- Do not hide failing verification by marking a task done.
- Do not mark an isolated-worktree task done before its accepted result is present on the approved canonical integration branch.
- Do not perform remote push, PR creation, or remote merge from this skill.
- Do not automatically self-modify skills or agents.
- Do not modify `.plan2agent/style.md` during implementation; it is updated only by direct user edits or through the approved proposal path.

## Output

Return these items to the user:

- Summary of implemented changes.
- `changedFiles` list.
- Verification summary with commands and outcomes.
- For batch mode, the ready snapshot, task/run/worktree mapping, harvest disposition, and canonical integration ref for every selected task.
- Recommended task status: `done`, `blocked`, or keep active.
- Optional skill-proposal schema object file path if the retrospective identifies a reusable process improvement.

## Milestone Review Pass

A milestone review pass is a recommended lightweight, read-only review for catching cross-cutting defects during an iteration. It is informational only and must not block close readiness, task completion, or any done/block decision; apply the same non-blocking principle used for the style-rating pass.

### Checkpoint selection and duplicate prevention

Evaluate checkpoint eligibility after each successful `p2a_execute finish` that marks a feature-iteration task done:

- `midpoint` is eligible when `done >= ceil(total / 2)` and `done < total`.
- `pre_close` is eligible when `done == total`, immediately before the user performs close-ready verification.
- Maintenance and explicit standalone graphs do not create feature-iteration milestone reviews.

Use exactly one stable path per iteration/checkpoint:

- `iterations/<iteration-id>/milestone-reviews/midpoint.json`
- `iterations/<iteration-id>/milestone-reviews/pre_close.json`

If the eligible checkpoint's file already exists, validate it with `validate_artifacts.mjs --milestone-review` and skip the pass. Never overwrite, append a dated duplicate, or silently repair an existing checkpoint file. If an existing file is invalid, report the invalid informational artifact and continue the task/close flow without treating it as a gate. If the midpoint window has already passed because all tasks are done, do not backfill it; evaluate only `pre_close`.

### Required context injection (맥락 주입)

Before invoking the reviewer, the main dev-execution owner must build one evidence envelope from a single task-graph snapshot and pass all of it to the reviewer:

- The full current iteration task graph, including every task status, preserved as `task_graph_snapshot`, plus a `task_snapshot` of each task's id/title/status, a task-count snapshot, the raw task-graph file `task_graph_sha256`, and the schema-defined deterministic `task_graph_snapshot_sha256`.
- The approved product and implementation spec and its reference.
- The complete `.plan2agent/style.md` contents and reference when the file has at least one filled section; otherwise use `style_ref: null`.
- For every `done` task, evidence from its latest successful finished run: `task_id`, `task_title`, `run_id`, artifact-root-relative `run_ref` formed as `runs/<run-index entry runRef>` (normally `runs/<iteration_id>/<run_id>.json`, with legacy flat refs still readable), raw run-file `run_sha256`, the complete parsed `p2a.run.v1` object preserved as immutable `run_snapshot`, deterministic `run_snapshot_sha256 = sha256(JSON.stringify(run_snapshot))`, `run_finished_at`, the complete `changedFiles` list normalized as `changed_files`, and the complete verification summary normalized to `type`, `command`, `status`, `exit_code`, and `source`.
- The ids of every remaining `todo`, `in_progress`, or `blocked` task.
- A clear instruction that only completed scope is under review and every suspected gap must be compared against remaining tasks before classification.

Each completed task must have a resolvable successful run whose raw file matches `run_sha256`, whose parsed object exactly matches `run_snapshot` and `run_snapshot_sha256` at draft validation time, and whose finish time matches `run_finished_at`. It also needs an explicit changed-file list (which may be empty) and at least one executed `source: config|command` verification that passed with exit code 0. The immutable snapshot keeps the checkpoint historically valid if a finished run later receives a legal `record` or `verify` evidence append; mutable current evidence must not rewrite the checkpoint snapshot. If any completed-task evidence is missing, do not invoke a partial review and do not create the canonical checkpoint file. Record the non-blocking skip reason in the current response or run notes and retry the still-eligible checkpoint after evidence is repaired.

Invoke `p2a-milestone-reviewer` as a separate read-only subagent when available, or perform an otherwise separated read-only review using the same contract. Split review perspectives across at most two instances when useful, then have the main owner deduplicate their results into one checkpoint artifact.

### Persistence and result handling

The main owner, not the reviewer, combines the immutable source envelope with the reviewer result and adds `schema_version: "p2a.milestone_review.v1"`, `project_id`, `iteration_id`, and `generated_at`. The complete object must match `.plan2agent/schemas/milestone-review.schema.json`.

Write first to a unique draft in the checkpoint directory, using `iterations/<iteration-id>/milestone-reviews/<checkpoint>.<unique-id>.draft.json`. Never use one shared draft filename and never rename a draft into the stable path yourself. Promote through the iteration CLI, which validates the unique draft and then atomically claims the stable checkpoint path with a hard-link create that fails if another owner has already won:

```bash
node .plan2agent/scripts/p2a_iteration.mjs promote-milestone \
  --artifacts <artifact-root> \
  --draft <artifact-root>/iterations/<iteration-id>/milestone-reviews/<checkpoint>.<unique-id>.draft.json
```

On success the CLI creates `<checkpoint>.json` atomically and removes the winning unique draft. If the stable path already exists, the CLI never overwrites it and leaves the losing draft untouched; validate the stable artifact before discarding that draft. Invalid drafts are not canonical and must not be promoted. This single promotion command replaces the non-atomic check-then-rename sequence.

Consume `confirmed_findings` as maintenance-task candidates only after checking the remaining feature tasks and existing maintenance graph again. Preserve `planned_todo_not_findings` in the JSON so planned work is not duplicated. When registering a confirmed finding, cite `milestone-review:iterations/<iteration-id>/milestone-reviews/<checkpoint>.json#<finding_id>` in maintenance `sourceSpecRefs`/`--ref` evidence. The milestone JSON is the stable informational source; do not create a competing Markdown source and do not edit Gate D decision records such as `review.json`.

## Retrospective

After execution, perform a Hermes-style retrospective gate. Look for repeated mistakes, missing verification, reusable procedures, or unclear boundaries discovered during the run. Explicitly ask: did the user correct code style during this run?

If an improvement is warranted, write it as a skill-proposal schema object rather than freeform markdown and save it inside the project at `.plan2agent/proposals/<proposalId>.json`. If the user corrected code style, write a proposal with `target: "project"` and `targetFiles: [".plan2agent/style.md"]`; record concrete evidence describing what the user asked to change and how they wanted the style adjusted. The object must conform to `.plan2agent/schemas/skill-proposal.schema.json` with `schema_version: "p2a.skill_proposal.v1"`, a stable non-empty `proposalId`, the source run id when available, concrete evidence, target canonical files, risk, and `status: "proposed"`.

Do not edit any skill, agent, planning artifact, CLI mirror, or other canonical file automatically as part of the retrospective. Leave only the proposal object for later review. A human or the read-only skill curator must review the proposal, and any approved patch must happen in a separate turn after human approval.
