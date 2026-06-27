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

## Procedure

1. Confirm the target task is ready and inspect its implementation context:

   ```bash
   node .plan2agent/scripts/p2a_tasks.mjs ready --artifacts <dir>
   ```

   Use the task `prompt` to understand the scoped work, acceptance criteria, target area, and relevant constraints.

2. Start a run unless the user provided an existing run id. When using Codex, create an isolated worktree so the write-capable implementer is confined by Codex's `workspace-write` sandbox:

   ```bash
   node .plan2agent/scripts/p2a_runs.mjs start --artifacts <dir> --task <id> --agent-tool codex --isolation worktree --worktree <fresh-worktree-path> --create-isolation
   ```

   The worktree path must be a fresh empty path, following the `project.config.json` `runTracking.worktreePattern` convention (for example, `../.worktrees/<taskId>-<runId>`).

   Codex uses sandbox confinement. Claude write-capable runs require scaffold confinement (deny rules + PreToolUse hook, plus OS sandbox on macOS/Linux) and foreground human supervision for now; do not switch Claude to unattended `permissionMode` auto/background until the cross-OS spike is complete and a human explicitly approves that mode. Gemini is still read-only, so use the main-session fallback for Gemini.

3. Before implementing, ensure the target project has a committed git baseline. If there is pre-existing untracked or scaffolded state, commit it first; otherwise `p2a_runs finish --collect-git` records the entire untracked tree as this task's `changedFiles` instead of only the files this task changed.

4. Implement the task while obeying the writing boundaries below. When possible, spawn the `p2a-implementer` subagent to perform the implementation inside the isolated worktree. Codex uses the `workspace-write` sandbox. Claude uses scaffold confinement for write-capable foreground-supervised runs; unattended `permissionMode` auto/background remains deferred until the cross-OS spike and explicit human decision. Gemini remains read-only, so use the main-session fallback for Gemini.

   The spawned `p2a-implementer` subagent performs scoped file edits only. It may optionally run local checks for self-review, but it must not call `p2a_runs verify`, `p2a_runs finish`, or `p2a_tasks done|block`. Unless lifecycle delegation is explicitly requested, those lifecycle steps belong to the main dev-execution owner running this skill.

5. Verify the run with the required checks by actually executing configured or explicitly requested commands:

   ```bash
   node .plan2agent/scripts/p2a_runs.mjs verify --run-id <id> --artifacts <dir> --test --lint --typecheck
   ```

   `p2a_runs verify` must execute the configured or explicitly requested verification commands and capture their exit codes as `source: config` or `source: command`. Do not self-report verification with a manual record; do not use `source: manual` or `exitCode: null` as a substitute for executed verification.

   If the user provides explicit verification commands, pass them through as explicit commands such as `--test-command`, `--lint-command`, or `--typecheck-command`. Config-only verification flags such as `--test`, `--lint`, and `--typecheck` quietly skip checks when the corresponding `project.config.json` command is empty, so use explicit commands whenever config is empty and real verification is required.

6. Finish the run, collecting git state:

   ```bash
   node .plan2agent/scripts/p2a_runs.mjs finish --run-id <id> --artifacts <dir> --status finished|failed|blocked --collect-git
   ```

   When finishing with `--status failed` or `--status blocked`, include `--failure-class <class>` so the run records a structured `failure` object. The supported classes are `verification_failed`, `test_flake`, `scope_violation`, `missing_dependency`, `environment_failure`, `implementation_incomplete`, and `other`. The CLI fills `retryable`, `needsUserDecision`, and `source` from the class defaults; use `--retryable`, `--needs-user-decision`, or `--failure-source` only when the default is wrong. Use `--failure-class other` only as an escape hatch and always include at least one `--note` explaining why no more specific class applies.

   Only classify a failure as `test_flake` when there is concrete evidence such as a failing verification command passing on rerun without code or environment changes. Without that evidence, use `verification_failed` for verification failures.

7. Run the independent monitor gate before marking the task done. Invoke `p2a-performance-monitor` as a separate subagent when the CLI supports spawning subagents, or perform a separated read-only review pass when spawning is unavailable. Pass the target task id, acceptance criteria, and the latest run log for that task, including `verification`, `changedFiles`, `status`, and `workspaceRef`.

   If the monitor returns `verdict: "block"`, do not mark the task done. First finish the run as blocked with `--failure-source monitor` and a failure class derived from the monitor verdict details: `unmet_acceptance` maps to `implementation_incomplete`, `verification_concerns` maps to `verification_failed`, and `scope_concerns` maps to `scope_violation`. Then record the blocker and follow-up reason:

   ```bash
   node .plan2agent/scripts/p2a_tasks.mjs block --artifacts <dir> <task-id>
   ```

   If the monitor returns `verdict: "confirm_done"`, mark the task done:

   ```bash
   node .plan2agent/scripts/p2a_tasks.mjs done --artifacts <dir> <task-id>
   ```

8. Complete the retrospective gate described below.

## Writing boundaries and prohibitions

- Implement only inside the separate target project. Do not write to the Plan2Agent repository itself, including `.agents/`, `.claude/`, `.codex/`, `.gemini/`, `.plan2agent/scripts/`, `.plan2agent/schemas/`, `plans/`, or `docs/`.
- Limit writes to the run `workspaceRef` or worktree. Refuse requests to write outside that workspace.
- Do not add or rewrite requirements by bypassing planning artifacts.
- Do not install dependencies without grounded evidence from the approved task, existing project conventions, or explicit user approval.
- In a co-located project where harness files live alongside app code, do not run interactive scaffolders that may overwrite or prompt in a non-empty directory, such as `npm create vite .`. Write config files manually and install only dependencies.
- Do not access, print, or exfiltrate `.env` files, credentials, or tokens.
- Do not hide failing verification by marking a task done.
- Do not automatically self-modify skills or agents.

## Output

Return these items to the user:

- Summary of implemented changes.
- `changedFiles` list.
- Verification summary with commands and outcomes.
- Recommended task status: `done`, `blocked`, or keep active.
- Optional skill-proposal schema object file path if the retrospective identifies a reusable process improvement.

## Retrospective

After execution, perform a Hermes-style retrospective gate. Look for repeated mistakes, missing verification, reusable procedures, or unclear boundaries discovered during the run.

If an improvement is warranted, write it as a skill-proposal schema object rather than freeform markdown and save it inside the project at `.plan2agent/proposals/<proposalId>.json`. The object must conform to `.plan2agent/schemas/skill-proposal.schema.json` with `schema_version: "p2a.skill_proposal.v1"`, a stable non-empty `proposalId`, the source run id when available, concrete evidence, target canonical files, risk, and `status: "proposed"`.

Do not edit any skill, agent, planning artifact, CLI mirror, or other canonical file automatically as part of the retrospective. Leave only the proposal object for later review. A human or the read-only skill curator must review the proposal, and any approved patch must happen in a separate turn after human approval.
