---
name: p2a-spec
description: Use when converting Plan2Agent intake output and user answers into product and implementation specs.
---

# Plan2Agent Spec

Create a development-ready product and implementation specification from approved intake information.

## Inputs

- `intake_json` with `status: ready_for_spec` and a valid Gate A `approval_audit`. Treat a legacy `interview` object as opaque compatibility data; do not use it to route or block Gate B.
- User answers for every high-impact `needs_user_decision`.
- Explicit constraints and non-goals.
- Optional `intake_json.baseline_context` with an immutable baseline `spec_ref`/`spec_sha256` and prior answers/question dispositions that may be reused when the current change does not affect them.
- Optional prior `spec_json` when resuming.
- Optional Feature Radar preflight research from `.plan2agent/artifacts/<project_id>/preflight-research/`.
- Optional same-project, conditional cross-project, or targeted Gate B Memory recall reports prepared by the harness.

## Ownership

- Product spec authorship belongs to `p2a-spec-author`.
- Implementation planning belongs to `p2a-implementation-planner`.
- If subagents are unavailable, produce both sections locally but keep the two responsibilities separate.

## Output

Return:

- `spec_json` conforming to `p2a` package schema `spec.schema.json`
- `open_decisions`
- `clarifying_question_disposition` inside `spec_json`, with one disposition for every intake `CQ-n`
- `evidence` inside `spec_json`, preserving intake sources and adding any new `WEB-n` or `LOCAL-n` sources
- Optional `reference_reconnaissance` inside `spec_json` when Gate B compares reusable technologies, local patterns, prior artifacts, or external implementation approaches
- Optional generated Markdown views may be returned when useful for export or review, but `spec_json` is the source of truth. The harness persists `gate-b-spec/spec.json` under `.plan2agent/artifacts/<project_id>/` for Gate B. Set `spec_json.source_intake` to the Gate A folder path, for example `.plan2agent/artifacts/<project_id>/gate-a-intake/intake.json`, when the source is a persisted artifact.
- When `intake_json.interview` exists, compute the SHA-256 of the exact persisted `intake.json` bytes and record it as `spec_json.source_intake_sha256`. Recompute it only when regenerating Gate B from the changed intake; never update the hash merely to make a stale spec validate.

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

`spec_json` must include an `evidence` array that follows the Evidence and Citation Contract in `.agents/skills/p2a-harness/SKILL.md`.

Newly authored specs must also include `spec_json.visual_experience` with:

- `has_visual_interface`
- `design_scope`: `none`, `minimal`, `reuse`, or `full`
- `design_timing`: `not_applicable`, `current_iteration`, or `deferred_iteration`
- a concrete `rationale`
- `experience_spec_ref` for `full + current_iteration`
- `experience_spec_sha256` for the exact approved visual experience bytes in `full + current_iteration`
- `design_system_refs` for `reuse + current_iteration`

Treat this as an iteration-scoped decision. Function-first work may choose `minimal` now or `full + deferred_iteration`; a later iteration can choose `full + current_iteration`. When `full + current_iteration` is selected, invoke `p2a-visual-experience` and keep Gate B draft until its HTML prototype and experience contract are explicitly approved.

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

When the scan compares concrete reusable patterns or implementation references, add `spec_json.reference_reconnaissance` instead of overloading `evidence`. Use `evidence` for source metadata and `reference_reconnaissance` for decision metadata:

- `triggers`: why reconnaissance was needed, such as a material dependency choice, stale ecosystem risk, or request for current options.
- `candidates`: `REF-n` entries that point to an existing `evidence[].source_id`, summarize the option, and record `decision` as `selected`, `rejected`, `deferred`, `context`, or `open`. Use optional `origin` when a known adapter generated the candidate, such as `feature_radar_preflight`.
- `selected_patterns`: patterns to reuse, with the source `candidate_id`, target spec fields in `applies_to`, and rationale.
- `rejected_patterns`: patterns intentionally not reused, with the source `candidate_id` and rationale.
- `open_questions`: unresolved reference or trade-off questions that should remain visible before Gate B approval.

Feature Radar preflight research follows the same evidence model:

- Copy Markdown/JSON Radar artifacts into `spec_json.evidence` as `LOCAL-n` sources, preserving file paths in `url`.
- Convert Radar source URLs into `WEB-n` evidence when they materially ground a product or implementation recommendation.
- Add `next-iteration-recommendations.md`, `capability-gap-analysis.md`, or `p2a-context.json` recommendations as `reference_reconnaissance.candidates` with `decision: "context"` and `origin: "feature_radar_preflight"` until Gate B explicitly changes them to `selected`, `rejected`, or `deferred`.
- Do not treat a Radar recommendation as approved scope by itself; it only becomes task-generating scope after Gate B approval records the decision.

## Baseline Answer Reuse

For iterative Gate B synthesis, inspect `intake_json.baseline_context` before generating a new decision or disposition.

- Reuse a prior answer or disposition when the current change does not affect its recorded scope.
- Preserve `source_intake` or `source_spec` provenance in the explanation and evidence.
- If the current interview explicitly overrides a prior answer, prefer the current answer and state the conflict and resolution. Do not mutate or silently replace the baseline record.
- Treat the approved intake as scope evidence, not as a patch language. Build the complete baseline-shaped spec from the confirmed scope and validated baseline, preserve explicit exclusions and unresolved decisions, and record material changes in the spec's own canonical fields and evidence.
- Generate a new question only for changed or newly ambiguous scope. Do not re-ask an already answered baseline question merely because a new iteration started.
- Keep the canonical `p2a.spec.v1` full-shaped for compatibility. In iterative Markdown review views, show the delta and affected fields first and omit unchanged baseline values, while making clear that `spec.json` remains complete.

## Clarifying Question Disposition Contract

`spec_json.clarifying_question_disposition` is the canonical disposition record for every intake `CQ-n`. It must include exactly one item for each intake `clarifying_questions[*].id`. Each item has `id`, `status`, `rationale`, and `affects`, plus exactly the supporting field required by its status:

- `answered` requires `resolved_by` when the spec incorporates a user answer or an already-resolved decision.
- `assumed` requires `assumption` when the spec proceeds with a low-risk explicit assumption.
- `deferred_non_goal` requires `non_goal` when the question is intentionally outside v1 scope.
- `promoted_to_decision` requires `promoted_decision_id` when the question is high-impact and must be tracked as a formal `ND-n` decision.

Do not include detail fields from other statuses in the same disposition item. Only `ND-n` ids may appear in `open_decisions`; never put raw `CQ-n` ids there. If a clarifying question is still a blocker, promote it to a new `ND-n` decision, list that `ND-n` in `open_decisions`, and keep `approval: draft`. If the promoted decision is already resolved, include `resolution` in its disposition and omit it from `open_decisions`.

When an interview-aware intake gives a `CQ-n` the status `answered`, `assumed`, or `not_applicable`, map its recorded answer directly to the corresponding Gate B disposition instead of replacing it with a generic assumption.

## Optional Markdown View

Generate Markdown only as a view/export from `spec_json`, not as a second artifact to maintain by hand. Use this as a narrative-first soft template, not a fixed blank form. Each section should contain explanatory prose first, with tables only as supporting structure; a table must not replace the explanation. Keep JSON field names and schema unchanged. Render section titles and labels in the user's language while preserving the underlying English JSON field names.

Each Markdown section should state the corresponding `spec_json` field in one line so the JSON-to-Markdown mapping is explicit. Optional helper sections, such as an overview diagram or unresolved Gate B decisions, may be added, but they must not replace the field-mapped sections below.

For a baseline-aware iteration, a delta-first Markdown view may replace the repeated full field rendering: list the changed `product.*` or `implementation.*` refs and concise added/removed values, then state that unchanged baseline fields are omitted from the view and remain present in canonical `spec.json`.

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

- Do not start Gate B when Gate A lacks `status: ready_for_spec` or `intake_json.approval_audit`. Ignore legacy `interview` state when making that decision.
- Use `approval: draft` until the user explicitly approves the product and implementation spec.
- Use `approval: approved` only when every intake `CQ-n` is disposed, promoted decisions are resolved, `open_decisions` is empty, and the user has approved the spec.
- When `approval: approved`, include `spec_json.approval_audit` with `approved_by`, `approved_at`, `approved_artifacts`, and `approval_note`. Use `approved_artifacts: ["gate-b-spec/spec.json"]` for a greenfield Gate B bundle unless a more specific project-relative JSON path is known.
- For `visual_experience.design_scope: full` with `design_timing: current_iteration`, include the approved `experience-spec.json` in `approval_audit.approved_artifacts`; schema-valid prose alone is not sufficient for Gate B approval.
- Do not advance to task breakdown while `approval` is `draft`.
- Present the structured spec and any generated views for review, and request explicit user approval before advancing past Gate B.

## Rules

- If a required field is unknown, add the related decision id to `open_decisions` and keep approval as `draft`.
- Route every answered `needs_user_decision` into each canonical `spec.product.*` or `spec.implementation.*` field named by that decision's `affected_fields`; fall back to `blocks` only for a legacy interview item that omits `affected_fields`. Do not place every decision into generic constraints or architecture fields.
- Keep non-goals explicit.
- Do not invent API providers, storage engines, or UI frameworks unless the user already selected them.
- Do not rely on stale model memory for current technology recommendations; use Technology Reconnaissance when the choice materially affects the plan.
- Preserve intake evidence and follow the Evidence and Citation Contract in `.agents/skills/p2a-harness/SKILL.md` for sources that materially affect the spec.
- Apply the Planning Memory Recall contract from `p2a-harness`: reuse both Gate A layers, run a targeted Gate B recall only when needed, and cite every consumed report as `LOCAL-n` with its query, requested/effective mode, fallback, and actual result reference. Treat retrieved history as context until the spec explicitly selects or rejects it, and preserve relevant prior failure signals for Gate C.
- Do not edit files or run commands.
