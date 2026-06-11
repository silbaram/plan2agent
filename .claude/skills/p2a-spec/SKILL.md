---
name: p2a-spec
description: Use when converting Plan2Agent intake output and user answers into product and implementation specs.
---

# Plan2Agent Spec

Create a development-ready product and implementation specification from approved intake information.

## Inputs

- `intake_json` with `status: ready_for_spec`.
- User answers for every high-impact `needs_user_decision`.
- Explicit constraints and non-goals.
- Optional prior `spec_json` when resuming.

## Ownership

- Product spec authorship belongs to `p2a-spec-author`.
- Implementation planning belongs to `p2a-implementation-planner`.
- If subagents are unavailable, produce both sections locally but keep the two responsibilities separate.

## Output

Return:

- `product_spec_markdown`
- `implementation_plan_markdown`
- `spec_json` conforming to `schemas/spec.schema.json`
- `open_decisions`
- `evidence` inside `spec_json`, preserving intake sources and adding any new `WEB-n` or `LOCAL-n` sources
- The harness persists these as `gate-b-spec/product-spec.md`, `gate-b-spec/implementation-plan.md`, and `gate-b-spec/spec.json` under `artifacts/<project_id>/` for file-based review at Gate B. Set `spec_json.source_intake` to the Gate A folder path, for example `artifacts/<project_id>/gate-a-intake/intake.json`, when the source is a persisted artifact.

## Required Spec Fields

`spec_json.product` must include:

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

`spec_json` must include an `evidence` array. Each item must have `source_id`, `title`, `url`, and `used_for`; web-derived items use `WEB-n` ids and include an http(s) URL.

`spec_json.implementation` must include:

- architecture
- interfaces
- data_flow
- dependencies
- edge_cases
- verification

## Approval Contract

- Use `approval: draft` until the user explicitly approves the product and implementation spec.
- Use `approval: approved` only when `open_decisions` is empty and the user has approved the spec.
- Do not advance to task breakdown while `approval` is `draft`.
- Present the written product and implementation specs as files and request explicit user approval before advancing past Gate B.

## Rules

- If a required field is unknown, add the related decision id to `open_decisions` and keep approval as `draft`.
- Keep non-goals explicit.
- Do not invent API providers, storage engines, or UI frameworks unless the user already selected them.
- Preserve intake evidence and add citation entries for web or local sources that materially affect the spec.
- Do not edit files or run commands.
