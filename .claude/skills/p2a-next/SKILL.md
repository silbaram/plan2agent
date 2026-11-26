---
name: p2a-next
description: Use when starting or resuming Plan2Agent development in a project to check .plan2agent/work.json and follow the single next action.
---

# Plan2Agent Next

Use `p2a next --json` as the single source of truth for starting or resuming development. Do not create extra Markdown plans, status files, or duplicate tracking docs.

## Procedure

1. Run `p2a next --json` in the target project.
   - For a new development request when no work is active, run `p2a next --idea "<user request>" --json` (or `--entry <path>`).
   - If the user only asked a read-only question (review, explanation, status, git check), answer it directly without changing `.plan2agent/work.json` or advancing tasks.
2. Inspect the returned `state`, `action`, and `work` summary:
   - `uninitialized`: run `p2a init`, then rerun `p2a next --json`.
   - `draft_needs_plan`: continue with `p2a-work` to inspect the codebase and populate `.plan2agent/work.json`.
   - `draft_needs_approval` or `plan_drifted`: present the compact goal, scope, non-goals, constraints, and task list in plain language and ask for one-time confirmation. Once confirmed, run `p2a approve --quote "<exact user utterance>"` and proceed.
   - `task_in_progress`: resume the active task immediately using its recorded `acceptance`, `verification`, `notes`, and `resume.summary` via `p2a-work`.
   - `ready_task`: run `p2a task start <id>` and implement via `p2a-work`.
   - `tasks_blocked`: explain the blocker and the smallest decision needed from the user.
   - `ready_to_finish`: summarize completed tasks, changed files, and verification outcomes, then ask to run `p2a done` (which clears `work.json`).
3. Keep internal JSON paths and hashes out of ordinary replies unless the user asks for details.
