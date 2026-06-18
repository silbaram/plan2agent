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
   node scripts/p2a_tasks.mjs ready --artifacts <dir>
   ```

   Use the task `prompt` to understand the scoped work, acceptance criteria, target area, and relevant constraints.

2. Start a run unless the user provided an existing run id:

   ```bash
   node scripts/p2a_runs.mjs start --artifacts <dir> --task <id> --agent-tool codex
   ```

3. Before implementing, ensure the target project has a committed git baseline. If there is pre-existing untracked or scaffolded state, commit it first; otherwise `p2a_runs finish --collect-git` records the entire untracked tree as this task's `changedFiles` instead of only the files this task changed.

4. Implement the task while obeying the writing boundaries below.

5. Verify the run with the required checks by actually executing configured or explicitly requested commands:

   ```bash
   node scripts/p2a_runs.mjs verify --run-id <id> --artifacts <dir> --test --lint --typecheck
   ```

   `p2a_runs verify` must execute the configured or explicitly requested verification commands and capture their exit codes as `source: config` or `source: command`. Do not self-report verification with a manual record; do not use `source: manual` or `exitCode: null` as a substitute for executed verification.

6. Finish the run, collecting git state:

   ```bash
   node scripts/p2a_runs.mjs finish --run-id <id> --artifacts <dir> --status finished|failed|blocked --collect-git
   ```

7. Run the independent monitor gate before marking the task done. Invoke `p2a-performance-monitor` as a separate subagent when the CLI supports spawning subagents, or perform a separated read-only review pass when spawning is unavailable. Pass the target task id, acceptance criteria, and the latest run log for that task, including `verification`, `changedFiles`, `status`, and `workspaceRef`.

   If the monitor returns `verdict: "block"`, do not mark the task done. Record the blocker and follow-up reason instead:

   ```bash
   node scripts/p2a_tasks.mjs block --artifacts <dir> <task-id>
   ```

   If the monitor returns `verdict: "confirm_done"`, mark the task done:

   ```bash
   node scripts/p2a_tasks.mjs done --artifacts <dir> <task-id>
   ```

8. Complete the retrospective gate described below.

## Writing boundaries and prohibitions

- Implement only inside the separate target project. Do not write to the Plan2Agent repository itself, including `.agents/`, `.claude/`, `.codex/`, `.gemini/`, `scripts/`, `schemas/`, `plans/`, or `docs/`.
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
- Optional markdown skill proposal if the retrospective identifies a reusable process improvement.

## Retrospective

After execution, perform a Hermes-style retrospective gate. Look for repeated mistakes, missing verification, reusable procedures, or unclear boundaries discovered during the run.

If an improvement is warranted, write it only as a markdown proposal in the response. Do not edit any skill, agent, planning artifact, or CLI mirror automatically. A human must approve the proposal, and any patch must happen in a separate turn.
