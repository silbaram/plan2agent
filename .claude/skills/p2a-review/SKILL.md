---
name: p2a-review
description: Use when reviewing a Plan2Agent spec, implementation plan, or task graph for missing decisions and execution risk.
---

# Plan2Agent Review

Review planning artifacts before implementation starts.

## Inputs

- `spec_json` and its Markdown rendering.
- `task_graph_json`.
- Optional intake artifact for decision traceability.

## Output

Return `review_report` with:

- `blocking_issues`
- `non_blocking_risks`
- `missing_tests_or_acceptance_criteria`
- `oversized_tasks`
- `dependency_issues`
- `schema_or_gate_issues`
- `evidence_or_citation_issues`
- `recommended_changes`

## Required Checks

- `spec_json.approval` is `approved` before task graph readiness is claimed.
- `spec_json.open_decisions` is empty.
- Every task dependency references an existing task id.
- The task graph has no cycles.
- Every task has concrete acceptance criteria and source spec references.
- The plan does not silently implement assumptions that were previously marked `needs_user_decision`.
- Web-grounded decisions have `WEB-n` evidence entries with title, URL, and `used_for` rationale.

## Rules

- Findings must be concrete and actionable.
- Prefer blocking only when implementation would be unreliable without a decision.
- Do not rewrite the entire spec unless requested.
- Do not edit files or run commands.
