---
name: p2a-next
description: Use when a Plan2Agent user asks what to do next, wants to resume a project, or needs one state-based next action in an agent session.
---

# Plan2Agent Next

Use the CLI result as the only decision authority. Do not infer, list, or encode project-state rules in this skill.

## Procedure

1. Run `p2a next --json` from the target project. Pass `--project-id <id>` only when the user selected an artifact explicitly.
2. Parse the one returned `command`, `reason`, and `state`.
3. Present the result in the conversation using the returned reason.

## Handle the returned command

- For `kind: cli` with `requiresApproval: true`, show the command and wait for the user's approval before running it.
- For `kind: cli` with `requiresApproval: false`, run it immediately. This flag is emitted only for read-only repair inspection or the post-Gate B development/verification/close loop already authorized by the approved contract.
- After an autonomous `ready_task_available` start or `run_started` resume, continue in this session with `p2a-dev-execution` and the run's Gate-derived execution envelope. Do not ask for task-by-task approval or implementation choices.
- After an autonomous final visual or acceptance review start, complete the corresponding evidence loop from `p2a-dev-execution`. After autonomous iteration close or layout initialization, run `p2a next --json` again.
- For `kind: skill`, continue in this agent session with the named P2A skill. Carry over only the context needed by that skill; do not re-decide the next action.
- For `gate_b_approved_needs_execution_prepare`, pass the returned `--prepare-mode` to `p2a-dev-execution`. The skill selects and records the concrete adaptive mode; do not ask the user to choose from a mode menu or approve the synthetic compatibility work item.
- For `kind: approval`, show the returned artifact or approval instruction and wait for the user's decision.

Never execute a CLI command when `requiresApproval` is true. If the CLI requests project selection, ask the user to choose the displayed project id and run this skill again with that id.
