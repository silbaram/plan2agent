---
name: p2a-task-breakdown
description: Use when splitting an approved Plan2Agent implementation spec into a dependency-aware task graph.
---

# Plan2Agent Task Breakdown

Break an approved implementation spec into tasks that an agent or developer can execute.

## Inputs

- Approved product spec.
- Approved implementation plan.
- Known constraints.

## Output

Return a `task_graph_json` object with:

- `projectId`
- `version`
- `tasks`

Each task must include:

- `id`
- `title`
- `description`
- `status`
- `dependencies`
- `acceptanceCriteria`
- `targetArea`
- `suggestedAgentPrompt`
- `sourceSpecRefs`

## Rules

- Use `todo` as the default status.
- Dependencies must reference task ids.
- Split oversized tasks before returning.
- Do not include implementation code.
- Do not edit files or run commands.
