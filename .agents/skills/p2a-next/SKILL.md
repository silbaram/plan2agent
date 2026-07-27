---
name: p2a-next
description: Use when a Plan2Agent user asks what to do next, wants to resume a project, or needs one state-based next action in an agent session.
---

# Plan2Agent Next

Use the CLI result as the only decision authority. Do not infer, list, or encode project-state rules in this skill.

## Procedure

1. Run `node .plan2agent/scripts/p2a.mjs next --json` from the target project. Pass `--project-id <id>` only when the user selected an artifact explicitly.
2. Parse the one returned `command`, `reason`, and `state`.
3. Present the result in the conversation using the returned reason.

## Handle the returned command

- For `kind: cli`, show the command and wait for the user's approval before running it.
- For `kind: skill`, continue in this agent session with the named P2A skill. Carry over only the context needed by that skill; do not re-decide the next action.
- For `kind: approval`, show the returned artifact or approval instruction and wait for the user's decision.

Never execute a CLI command just because `p2a next` suggested it. If the CLI requests project selection, ask the user to choose the displayed project id and run this skill again with that id.
