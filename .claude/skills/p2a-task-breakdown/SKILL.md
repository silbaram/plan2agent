---
name: p2a-task-breakdown
description: Use when splitting an approved Plan2Agent implementation spec into a dependency-aware task graph.
---

# Plan2Agent Task Breakdown

Break an approved implementation spec into tasks that an agent or developer can execute.

## Inputs

- `spec_json` conforming to `p2a` package schema `spec.schema.json`.
- `spec_json.approval: approved`.
- `spec_json.open_decisions: []`.
- Every intake `CQ-n` has a valid `spec_json.clarifying_question_disposition`.
- Known constraints.
- Optional `planning_memory` context containing recall status, report references, relevant results, and prior failure signals.

## Output

Return a `task_graph_json` object conforming to `p2a` package schema `task-graph.schema.json` with:

- `schema_version`: `p2a.task_graph.v1`
- `projectId`
- `version`
- `sourceSpec` (use the Gate B folder path, for example `.plan2agent/artifacts/<project_id>/gate-b-spec/spec.json`, when the source is a persisted artifact)
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

## Validation Gates

- Reject task breakdown if the spec is not approved.
- Reject task breakdown if any unresolved decision remains.
- Reject task breakdown if Gate B clarifying question dispositions are missing or invalid.
- Dependencies must reference task ids in the same graph.
- The dependency graph must be acyclic.

## Rules

- Use `todo` as the default status.
- Split oversized tasks before returning.
- Each task's acceptance criteria must be self-satisfiable from that task's explicit scope; do not require prior or later task work to satisfy an AC.
- A task that adds a framework dependency which triggers auto-configuration must either include the minimal configuration that auto-configuration requires (for example, a datasource URL) in the same task, or explicitly defer build-green acceptance criteria to the later task that handles that configuration.
- Inspect `planning_memory` before decomposition. If history materially changes a task boundary, dependency, acceptance criterion, or mitigation, include a `memory:<report path or result reference>` entry and any applicable `decision:ND-n` entry in `sourceSpecRefs`, alongside at least one real product or implementation spec field.
- Convert a relevant prior failed/blocked run into a concrete mitigation or regression acceptance criterion. Do not create work from irrelevant results, and do not block merely because Memory is unavailable or unconfigured.
- Do not include implementation code.
- Do not edit files or run commands.
