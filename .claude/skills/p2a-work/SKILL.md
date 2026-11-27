---
name: p2a-work
description: Use when drafting a Plan2Agent work plan in .plan2agent/work.json, implementing approved tasks, running real verification, and keeping resume state current.
---

# Plan2Agent Work

Manage one focused development effort through `.plan2agent/work.json` so work can pause and resume cleanly across sessions without creating extra Markdown or sidecar files.

## 1. Plan Draft & One-Time Confirmation (`draft_needs_plan`)

1. Inspect the repository first so the plan is grounded in real code, files, and tests.
2. Ask the user **only** about decisions that materially change the outcome.
3. Update `.plan2agent/work.json` directly (conforming to `p2a.work.v1`) with:
   - `goal`, `scope`, `non_goals`, `constraints`
   - `tasks[]`: 1 task for a small cohesive change, or multiple ordered tasks (`T1`, `T2`, ...) with `depends_on` and concrete `acceptance[]` criteria when splitting helps progress or recovery.
4. Run `p2a validate` to confirm the JSON and task DAG are valid.
5. Present the goal, scope, constraints, and task list concisely and ask the user to confirm once.
6. After confirmation, record it with `p2a approve --quote "<exact user utterance>"`. Never edit product code before approval.

## 2. Task Execution, Verification & Resume (`task_in_progress` / `ready_task`)

1. If no task is active, start the next ready task with `p2a task start <id> --summary "<what you are doing>"`.
2. Read the task's `acceptance`, prior `verification` (if failed), `notes`, and `resume.summary`.
3. Implement the change inside the approved scope. Fix ordinary code or test failures autonomously.
   - If finishing requires changing product meaning, scope, or acceptance criteria, stop and update the plan for reconfirmation (`p2a approve`).
   - Do not run external writes, pushes, deploys, or irreversible actions without explicit user permission.
4. Checkpoint context before stopping or after meaningful discoveries with:
   `p2a task note <id> --note "<key fact or remaining step>" --summary "<2-3 sentence resume handoff>"`
5. Run real verification with `p2a verify --task <id>` (pass `--cmd "<command>"` if `config.json` has no default command). Never claim completion without a real passing exit code (`0`) on the current code.
6. When verified, complete the task with `p2a task done <id> --summary "<what is done and what comes next>"`.
7. Repeat via `p2a next --json` until all tasks are `done`.

## 3. Completion (`ready_to_finish`)

Report the completed outcomes, changed files, and verification results. When the user confirms finishing, run `p2a done` to clear `.plan2agent/work.json` (history stays in Git and optional BuildLore).
