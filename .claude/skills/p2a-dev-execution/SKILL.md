---
name: p2a-dev-execution
description: Use when implementing one ready Plan2Agent task or a bounded batch of independent ready tasks into real code changes and recording each run, without touching planning artifacts.
---

# Plan2Agent Dev Execution

Implement one approved ready Plan2Agent task, or a bounded batch from one ready snapshot, as real code changes in its target project. Record every task as its own run and hand back verification and integration results. This skill is for execution only: it does not author planning artifacts, change gates, or broaden any approved task scope.

## When to use

Use this skill only when all of these conditions are true before starting:

- Every selected task is exposed by the same `p2a tasks ready` snapshot.
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
   p2a tasks ready --artifacts <dir>
   ```

   Use the task `prompt` to understand the scoped work, acceptance criteria, target area, and relevant constraints.

   If this is a retry after the same task's latest run ended `failed` or `blocked`, inspect that run's failure class and localization before starting the new run. When Memory is configured, run one same-project hybrid search using the task title, failure class, and localization, filter to relevant run history when useful, and save the report beside the failed run as `<failed-run-id>.memory-recall.json`. Do not query Memory for a normal first attempt.

   Use a retrieved failure only when it is materially similar. After starting the retry, add one run note in the form `MEMORY_RETRY: sourceRun=<id>; report=<path>; applied=<mitigation or none>; status=<succeeded|fallback|failed|skipped>`. If retrieval falls back or fails, preserve that status and continue unless the user explicitly requires Memory history; never claim that no similar failure exists.

2. Start a run unless the user provided an existing run id. When using Codex, create an isolated worktree so the write-capable implementer is confined by Codex's `workspace-write` sandbox:

   ```bash
   p2a execute start --artifacts <dir> --task <id> --agent-tool codex --isolation worktree --worktree <fresh-worktree-path> --create-isolation
   ```

   Preserve one run identity across start retries. An explicit `--run-id` always wins. When `project.config.json.runTracking.runIdStrategy` is `task-sequence`, omit `--run-id` on the first start so the CLI atomically reserves the next id from `runIdPattern`; if isolation setup fails, correct the cause and use the printed retry command with that same explicit id. Do not invoke a fresh implicit start after failure because it intentionally allocates the next attempt id. Projects that keep the default `timestamp` strategy retain timestamp-based ids.

   Use `p2a execute start`, not raw `p2a runs start`, because it creates the run and marks the task `in_progress` in one lifecycle step. If the task requires independent monitor evidence, pass `--require-monitor` so the run records a monitor gate requirement.

   The worktree path must be a fresh empty path, following the `project.config.json` `runTracking.worktreePattern` convention (for example, `../.worktrees/<taskId>-<runId>`).
   Run this command from an existing git workspace; the fresh worktree path does not need to exist before `--create-isolation`.
   Let `--create-isolation` create the worktree; do not pre-create it as a manual workaround. For a direct CLI call that passes the same fresh path to both `--workspace` and `--worktree`, invoke the command from the existing git workspace so the CLI can use that current directory as the creation base and validate the new workspace after creation.

   Follow the Provider Confinement Policy in this skill for Codex, Claude, and Gemini execution modes.

3. Before implementing, ensure the target project has a committed source-code git baseline, excluding local `.plan2agent/` state. If there is pre-existing untracked application source, commit or intentionally ignore it first; otherwise `p2a runs finish --collect-git` records the entire untracked source tree as this task's `changedFiles` instead of only the files this task changed.

4. Before implementing, check whether the target project contains `.plan2agent/style.md`. If it exists, read it and pass the style contract to the implementer, including any spawned `p2a-implementer` subagent, and require the implementation to follow it. When possible, spawn the `p2a-implementer` subagent to perform the implementation inside the isolated worktree.

5. Implement the task while obeying the writing boundaries below, the project style contract when present, and the Provider Confinement Policy in this skill.

   The spawned `p2a-implementer` subagent performs scoped file edits only. It may optionally run local checks for self-review, but it must not call `p2a runs verify`, `p2a runs finish`, or `p2a tasks done|block`. Unless lifecycle delegation is explicitly requested, those lifecycle steps belong to the main dev-execution owner running this skill.

6. Verify the run with the required checks by actually executing configured or explicitly requested commands. You may verify before finish:

   ```bash
   p2a runs verify --run-id <id> --artifacts <dir> --test --lint --typecheck
   ```

   `p2a runs verify` must execute the configured or explicitly requested verification commands and capture their exit codes as `source: config` or `source: command`. Do not self-report verification with a manual record; do not use `source: manual` or `exitCode: null` as a substitute for executed verification.

   If the user provides explicit verification commands, pass them through as explicit commands such as `--test-command`, `--lint-command`, or `--typecheck-command`. Config-only verification flags such as `--test`, `--lint`, and `--typecheck` auto-detect project commands when config is empty, then skip only if no command can be detected. Use explicit commands whenever config is empty and real verification is required.

   For supplemental `--verify-command` checks, use only the supported verification types `test`, `lint`, `typecheck`, and `custom`. Record checks outside the three primary types with the `custom:<command>` form:

   ```bash
   p2a runs verify --run-id <id> --artifacts <dir> --verify-command 'custom:git diff --check'
   ```

   Do not invent labels such as `format:`, `repeatability:`, or `dependency-policy:` as metadata. An unrecognized prefix remains part of the executable command, so `format:npm run format:check` attempts to execute that full string as a custom command. A failed or unavailable verification record is immutable evidence; correct the syntax and start a new retry run instead of rewriting the original record.

   Verification shell composition must preserve failures from every command that provides evidence. Do not use `test -z "$(command)"` directly: if `command` cannot execute, the substitution can become an empty string and the outer `test` can still exit zero. Capture the output only after propagating the producer's status:

   ```bash
   p2a runs verify --run-id <id> --artifacts <dir> --verify-command "custom:sh -c 'output=\$(gofmt -l <files>) || exit \$?; test -z \"\$output\"'"
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

   Use `verdict: "block"` and fill the relevant concern array when the task should not be accepted. When multiple concern arrays are populated, failure-class mapping priority is `scope_concerns` → `verification_concerns` → `unmet_acceptance` → `needs_user_decision`. `p2a execute finish` and `p2a runs finish` both enforce this verdict when the run requires a monitor gate.

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

   Silent omission is forbidden. This style review is informational only and must never affect `p2a execute finish`, `p2a runs finish`, `p2a tasks done`, `p2a tasks block`, monitor verdicts, failure classes, or any done/block decision. Once a positive style-verdict is recorded, its `sections`, `violations`, and `violationCount` are historical record and must never be edited. Existing zero-violation verdict files are also historical records: do not delete or rewrite them when adopting this prospective policy. If a violation is resolved later, append a dated `RESOLUTION:` line to the verdict `note` field or leave a fresh verdict from a later run's re-rating; do not rewrite the original finding fields. Retroactive rating is allowed when a run session omitted the pass: persist a sidecar only if the retroactive result has violations, and state that the rating is retroactive in the sidecar note or clean-result run note. If `violationCount > 0`, carry the violations forward as candidate evidence for the step 10 retrospective style proposal with `target: "project"` and `targetFiles: [".plan2agent/style.md"]`. When the user decides to fix recorded violations, the default path is to register the work as a maintenance task with `p2a iteration maintenance add` and execute it with run history. If an exception requires an immediate ad-hoc fix, include the rationale and the source style-verdict path in the commit message.

9. Finish the run through `p2a execute`, collecting git state and letting the CLI mark the task done or blocked:

   ```bash
   p2a execute finish --run-id <id> --artifacts <dir> --status finished|failed|blocked --collect-git
   ```

   You can also pass `--test`, `--lint`, `--typecheck`, or explicit `--*-command` flags to this finish command instead of running step 6 separately.

   When finishing with `--status failed` or `--status blocked`, include `--failure-class <class>` and structured debug detail: at least one `--repro-step` or `--repro-command`, at least one `--localization` or `--localized-file`, and at least one `--guard` or `--guard-note`. The supported classes are `verification_failed`, `test_flake`, `scope_violation`, `missing_dependency`, `environment_failure`, `implementation_incomplete`, and `other`. The CLI fills `retryable`, `needsUserDecision`, and `source` from the class defaults; use `--retryable`, `--needs-user-decision`, or `--failure-source` only when the default is wrong. Use `--failure-class other` only as an escape hatch and always include at least one `--note` explaining why no more specific class applies.

   Only classify a failure as `test_flake` when there is concrete evidence such as a failing verification command passing on rerun without code or environment changes. Without that evidence, use `verification_failed` for verification failures.

   If the monitor verdict blocks the run, do not call `p2a tasks done`. Finish through `p2a execute finish` with monitor-sourced failure metadata and structured detail. The CLI maps `unmet_acceptance` to `implementation_incomplete`, `verification_concerns` to `verification_failed`, `scope_concerns` to `scope_violation`, and `needs_user_decision` to `missing_dependency`.

10. After finish has updated the task graph, evaluate and, when eligible, run the milestone review checkpoint described below. This checkpoint is informational and does not change the just-finished run or task status.

11. Complete the retrospective gate described below.

## Supervised Batch Owner Procedure

Read this procedure only when running two or more independent ready tasks in parallel.
If executing a single task, do not read it.

When parallel execution is confirmed, read `references/batch-execution.md`.

## Writing boundaries and prohibitions

- Implement only inside the separate target project. Do not write to the Plan2Agent repository itself, including `.agents/`, `.claude/`, `.codex/`, `.gemini/`, `.plan2agent/scripts/`, `.plan2agent/schemas/`, `plans/`, or `docs/`.
- Limit implementation writes to the run `workspaceRef` or worktree. In supervised batch mode, the main dev-execution owner may also create task-scoped local commits or patches and write to the approved canonical integration worktree plus the owner-only integration-candidate worktree created from its latest head. The main owner may write the lifecycle artifacts explicitly defined by this skill: retry Memory reports and notes, run verdicts, milestone-review JSON, and retrospective proposals. Spawned implementation and review subagents remain unable to write integration or lifecycle artifacts.
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

Read this procedure only after `p2a execute finish` makes a task done and `done >= ceil(total / 2)` (midpoint) or `done == total` (pre_close).
During any other task execution, do not read it.
For maintenance tasks or explicit standalone graphs, do not read it.

When a checkpoint condition is met, read `references/milestone-review.md`.

## Retrospective

Read this procedure only after execution reaches the retrospective gate.
Before execution finishes or when no retrospective is being performed, do not read it.

When the gate is reached, read `references/retrospective.md`.
