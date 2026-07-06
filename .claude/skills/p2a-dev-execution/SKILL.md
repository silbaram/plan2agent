---
name: p2a-dev-execution
description: Use when implementing a single ready Plan2Agent task into real code changes and recording the run, without touching planning artifacts.
---

# Plan2Agent Dev Execution

Implement one approved, ready Plan2Agent task as real code changes in its target project, record the run, and hand back verification results. This skill is for execution only: it does not author planning artifacts, change gates, or broaden the approved task scope.

## When to use

Use this skill only when all of these conditions are true before starting:

- The task is exposed by `p2a_tasks ready`.
- The Gate B spec is approved and `open_decisions` is empty.
- The Gate D review has no blockers.
- The task has acceptance criteria.
- The user explicitly asks for implementation execution.

If any condition is missing, stop and report the missing prerequisite instead of implementing.

## Inputs

Use these inputs:

- Artifact root, or `--graph` when operating from an explicit task graph.
- Ready task id.
- `agent-tool`, usually `codex`.
- Optional existing run id.


## Provider Confinement Policy

Codex write-capable runs use native `workspace-write` sandbox confinement inside the assigned run workspace or isolated worktree. Claude write-capable runs require scaffold confinement with deny rules, a PreToolUse hook, and the macOS/Linux OS sandbox, and they must stay on the foreground, human-supervised approval path for now. Do not switch Claude to unattended `permissionMode` auto/background until the cross-OS spike is complete and a human explicitly approves that mode. Gemini remains read-only; do not pursue write-capable Gemini implementers, and use the main-session fallback when execution is needed. For every provider, writes remain limited to the assigned workspace/worktree, and harness files or paths outside that workspace are forbidden.

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

   Use `p2a_execute start`, not raw `p2a_runs start`, because it creates the run and marks the task `in_progress` in one lifecycle step. If the project has a supervised orchestration plan, pass `--orchestration-plan <path>` so the monitor gate sidecar is attached to the run.

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

7. Run the independent monitor gate before finish when the run has an orchestration sidecar. Invoke `p2a-performance-monitor` as a separate subagent when the CLI supports spawning subagents, or perform a separated read-only review pass when spawning is unavailable. Pass the target task id, acceptance criteria, and the latest run log for that task, including `verification`, `changedFiles`, `status`, and `workspaceRef`.

   Write the monitor result to the run's `runs/<runId>.monitor-verdict.json` path using this shape:

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

   Use `verdict: "block"` and fill the relevant concern array when the task should not be accepted. When multiple concern arrays are populated, failure-class mapping priority is `scope_concerns` → `verification_concerns` → `unmet_acceptance` → `needs_user_decision`. `p2a_execute finish` and `p2a_runs finish` both enforce this verdict when an orchestration sidecar requires a monitor gate.

8. Run the optional style-rating pass before finish when the target project contains `.plan2agent/style.md` with at least one filled section. Invoke `p2a-style-rater` as a separate read-only subagent when the CLI supports spawning subagents, or perform a separated read-only review pass when spawning is unavailable. Pass the target task id, the run's `changedFiles` list, and the complete `.plan2agent/style.md` contents.

   Write the style-rating result to the run's `runs/<runId>.style-verdict.json` path using this shape:

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
     "violationCount": 0,
     "note": ""
   }
   ```

   This style verdict is informational only and must never affect `p2a_execute finish`, `p2a_runs finish`, `p2a_tasks done`, `p2a_tasks block`, monitor verdicts, failure classes, or any done/block decision. If `.plan2agent/style.md` is absent or has no filled sections, skip the pass or record a `not_applicable` result. If `violationCount > 0`, carry the violations forward as candidate evidence for the step 10 retrospective style proposal with `target: "project"` and `targetFiles: [".plan2agent/style.md"]`.

9. Finish the run through `p2a_execute`, collecting git state and letting the CLI mark the task done or blocked:

   ```bash
   node .plan2agent/scripts/p2a_execute.mjs finish --run-id <id> --artifacts <dir> --status finished|failed|blocked --collect-git
   ```

   You can also pass `--test`, `--lint`, `--typecheck`, or explicit `--*-command` flags to this finish command instead of running step 6 separately.

   When finishing with `--status failed` or `--status blocked`, include `--failure-class <class>` and structured debug detail: at least one `--repro-step` or `--repro-command`, at least one `--localization` or `--localized-file`, and at least one `--guard` or `--guard-note`. The supported classes are `verification_failed`, `test_flake`, `scope_violation`, `missing_dependency`, `environment_failure`, `implementation_incomplete`, and `other`. The CLI fills `retryable`, `needsUserDecision`, and `source` from the class defaults; use `--retryable`, `--needs-user-decision`, or `--failure-source` only when the default is wrong. Use `--failure-class other` only as an escape hatch and always include at least one `--note` explaining why no more specific class applies.

   Only classify a failure as `test_flake` when there is concrete evidence such as a failing verification command passing on rerun without code or environment changes. Without that evidence, use `verification_failed` for verification failures.

   If the monitor verdict blocks the run, do not call `p2a_tasks done`. Finish through `p2a_execute finish` with monitor-sourced failure metadata and structured detail. The CLI maps `unmet_acceptance` to `implementation_incomplete`, `verification_concerns` to `verification_failed`, `scope_concerns` to `scope_violation`, and `needs_user_decision` to `missing_dependency`.

10. Complete the retrospective gate described below.

## Writing boundaries and prohibitions

- Implement only inside the separate target project. Do not write to the Plan2Agent repository itself, including `.agents/`, `.claude/`, `.codex/`, `.gemini/`, `.plan2agent/scripts/`, `.plan2agent/schemas/`, `plans/`, or `docs/`.
- Limit writes to the run `workspaceRef` or worktree. Refuse requests to write outside that workspace.
- Do not add or rewrite requirements by bypassing planning artifacts.
- Do not install dependencies without grounded evidence from the approved task, existing project conventions, or explicit user approval.
- In a co-located project where harness files live alongside app code, do not run interactive scaffolders that may overwrite or prompt in a non-empty directory, such as `npm create vite .`. Write config files manually and install only dependencies.
- Do not access, print, or exfiltrate `.env` files, credentials, or tokens.
- Do not hide failing verification by marking a task done.
- Do not automatically self-modify skills or agents.
- Do not modify `.plan2agent/style.md` during implementation; it is updated only by direct user edits or through the approved proposal path.

## Output

Return these items to the user:

- Summary of implemented changes.
- `changedFiles` list.
- Verification summary with commands and outcomes.
- Recommended task status: `done`, `blocked`, or keep active.
- Optional skill-proposal schema object file path if the retrospective identifies a reusable process improvement.

## Retrospective

After execution, perform a Hermes-style retrospective gate. Look for repeated mistakes, missing verification, reusable procedures, or unclear boundaries discovered during the run. Explicitly ask: did the user correct code style during this run?

If an improvement is warranted, write it as a skill-proposal schema object rather than freeform markdown and save it inside the project at `.plan2agent/proposals/<proposalId>.json`. If the user corrected code style, write a proposal with `target: "project"` and `targetFiles: [".plan2agent/style.md"]`; record concrete evidence describing what the user asked to change and how they wanted the style adjusted. The object must conform to `.plan2agent/schemas/skill-proposal.schema.json` with `schema_version: "p2a.skill_proposal.v1"`, a stable non-empty `proposalId`, the source run id when available, concrete evidence, target canonical files, risk, and `status: "proposed"`.

Do not edit any skill, agent, planning artifact, CLI mirror, or other canonical file automatically as part of the retrospective. Leave only the proposal object for later review. A human or the read-only skill curator must review the proposal, and any approved patch must happen in a separate turn after human approval.
