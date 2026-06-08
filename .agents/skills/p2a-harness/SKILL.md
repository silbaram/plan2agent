---
name: p2a-harness
description: Use when turning a one-sentence product idea into a Plan2Agent spec, implementation plan, task graph, and review report.
---

# Plan2Agent Harness

Use this workflow to convert an early product idea into development-ready planning artifacts.

## Inputs

- A one-sentence product or feature idea.
- Optional clarification answers, constraints, audience, or existing specs.

## Process

1. Intake: identify known facts, unknowns, assumptions, and blocking decisions.
2. Spec: create a product spec only after important assumptions are explicit.
3. Implementation plan: turn the approved product spec into a build plan.
4. Task graph: split the plan into agent-executable tasks with dependencies.
5. Review: find missing decisions, oversized tasks, unclear acceptance criteria, and unsafe execution assumptions.

## Output

Return these sections:

- `clarifying_questions`
- `product_spec_markdown`
- `implementation_plan_markdown`
- `task_graph_json`
- `review_report`

## Rules

- Do not edit source code.
- Do not run shell commands.
- Do not install dependencies.
- Do not claim that implementation happened.
- Mark unresolved decisions as `needs_user_decision`.
- Keep tasks small enough for one agent or developer to complete independently.
