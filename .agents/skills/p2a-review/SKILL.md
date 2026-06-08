---
name: p2a-review
description: Use when reviewing a Plan2Agent spec, implementation plan, or task graph for missing decisions and execution risk.
---

# Plan2Agent Review

Review planning artifacts before implementation starts.

## Inputs

- Product spec.
- Implementation plan.
- Task graph.

## Output

Return:

- `blocking_issues`
- `non_blocking_risks`
- `missing_tests_or_acceptance_criteria`
- `oversized_tasks`
- `dependency_issues`
- `recommended_changes`

## Rules

- Findings must be concrete and actionable.
- Prefer blocking only when implementation would be unreliable without a decision.
- Do not rewrite the entire spec unless requested.
- Do not edit files or run commands.
