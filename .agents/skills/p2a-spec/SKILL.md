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
- `spec_json` conforming to `.plan2agent/schemas/spec.schema.json`
- `open_decisions`
- `clarifying_question_disposition` inside `spec_json`, with one disposition for every intake `CQ-n`
- `evidence` inside `spec_json`, preserving intake sources and adding any new `WEB-n` or `LOCAL-n` sources
- The harness persists these as `gate-b-spec/product-spec.md`, `gate-b-spec/implementation-plan.md`, and `gate-b-spec/spec.json` under `.plan2agent/artifacts/<project_id>/` for file-based review at Gate B. Set `spec_json.source_intake` to the Gate A folder path, for example `.plan2agent/artifacts/<project_id>/gate-a-intake/intake.json`, when the source is a persisted artifact.

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

## Technology Reconnaissance

During Gate B, before finalizing `implementation.architecture`, run a lightweight technology landscape scan when:

- the implementation depends on a library, framework, runtime, protocol, package, database, cloud service, or external API choice;
- the user asks for recommendations or current/latest options;
- the agent may have stale knowledge or the ecosystem changes frequently;
- the choice affects architecture, security, cost, licensing, deployment, performance, compatibility, or long-term maintenance.

Use primary sources first: official docs, release notes, standards documents, package registries, source repositories, or vendor documentation. Use web lookup only for read-only research; do not install dependencies, run implementation commands, or treat popularity signals as sufficient proof.

The Gate B output must compare viable options, explain trade-offs, recommend one option when justified, and state the rationale in the product or implementation spec section it affects. Record every material source in `spec_json.evidence` as `WEB-n` with title, URL, and `used_for`, and cite the source id near the recommendation. If the choice changes product scope or major constraints, keep `approval: draft` and add the relevant `ND-n` to `open_decisions` instead of silently choosing.

`spec_json.clarifying_question_disposition` must include exactly one item for each intake `clarifying_questions[*].id`. Each item has `id`, `status`, `rationale`, and `affects`, plus the field required by its status:

- `answered` requires `resolved_by`.
- `assumed` requires `assumption`.
- `deferred_non_goal` requires `non_goal`.
- `promoted_to_decision` requires `promoted_decision_id`.

Do not include detail fields from other statuses in the same disposition item.

Only `ND-n` ids may appear in `open_decisions`; never put raw `CQ-n` ids there. If a clarifying question is still a blocker, promote it to a new `ND-n` decision, list that `ND-n` in `open_decisions`, and keep `approval: draft`. If the promoted decision is already resolved, include `resolution` in its disposition and omit it from `open_decisions`.

## Recommended Markdown Section Skeleton

Use this as a narrative-first soft template, not a fixed blank form. Each section should contain explanatory prose first, with tables only as supporting structure; a table must not replace the explanation. Keep JSON field names and schema unchanged. Render section titles and labels in the user's language while preserving the underlying English JSON field names.

Each Markdown section should state the corresponding `spec_json` field in one line so the JSON-to-Markdown mapping is explicit. Optional helper sections, such as an overview diagram or unresolved Gate B decisions, may be added, but they must not replace the field-mapped sections below.

`product-spec.md` mirrors `spec_json.product` in field order, one section per field:

1. problem
2. target_users
3. goals
4. non_goals
5. core_flows
6. screens_or_interfaces
7. data_model_draft
8. external_integrations
9. success_criteria
10. constraints

Suggested Korean section labels for product specs: 문제 정의, 대상 사용자, 목표, 비목표, 핵심 흐름, 인터페이스, 데이터 모델, 외부 연동, 성공 기준, 제약.

`implementation-plan.md` mirrors `spec_json.implementation` in field order, one section per field:

1. architecture
2. interfaces
3. data_flow
4. dependencies
5. edge_cases
6. verification

Suggested Korean section labels for implementation plans: 아키텍처, 인터페이스, 데이터 흐름, 의존성, 엣지 케이스, 검증.

## Approval Contract

- Use `approval: draft` until the user explicitly approves the product and implementation spec.
- Use `approval: approved` only when every intake `CQ-n` is disposed, promoted decisions are resolved, `open_decisions` is empty, and the user has approved the spec.
- After approval, the harness must record the Gate B approval audit in top-level `status.md` with `Approved by`, `Approved at`, `Approved artifacts`, and `Approval note`, while preserving the required `Progress:` line, Gate A-D sections, and numbered `## 1.` through `## 5.` structure.
- Do not advance to task breakdown while `approval` is `draft`.
- Present the written product and implementation specs as files and request explicit user approval before advancing past Gate B.

## Rules

- If a required field is unknown, add the related decision id to `open_decisions` and keep approval as `draft`.
- Keep non-goals explicit.
- Do not invent API providers, storage engines, or UI frameworks unless the user already selected them.
- Do not rely on stale model memory for current technology recommendations; use Technology Reconnaissance when the choice materially affects the plan.
- Preserve intake evidence and add citation entries for web or local sources that materially affect the spec.
- Do not edit files or run commands.
