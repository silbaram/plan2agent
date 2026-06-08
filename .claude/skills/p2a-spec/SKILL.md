---
name: p2a-spec
description: Use when converting Plan2Agent intake output and user answers into product and implementation specs.
---

# Plan2Agent Spec

Create a development-ready specification from approved intake information.

## Inputs

- Idea summary.
- Clarification answers.
- Assumptions.
- Explicit constraints.

## Output

Return:

- `product_spec_markdown`
- `implementation_spec_markdown`
- `spec_json`
- `open_decisions`

## Required Spec Fields

- problem
- target_users
- goals
- non_goals
- core_flows
- screens_or_interfaces
- data_model_draft
- external_integrations
- success_criteria
- constraints

## Rules

- If a required field is unknown, mark it as `needs_user_decision`.
- Keep non-goals explicit.
- Do not invent API providers, storage engines, or UI frameworks unless the user already selected them.
- Do not edit files or run commands.
