---
name: p2a-intake
description: Use when extracting requirements, assumptions, and clarification questions from a one-sentence Plan2Agent product idea.
---

# Plan2Agent Intake

Convert an early idea into structured planning input.

## Inputs

- One-sentence product or feature idea.
- Optional user notes.
- Optional prior `intake_json`, newly answered `CQ-n` or `ND-n` ids, and a user request to continue, summarize, pause, or accept recommended assumptions when resuming.
- Optional same-project and conditional cross-project Memory recall reports prepared by the harness for an iterative project.
- Optional `baseline_context` prepared by `p2a iteration draft`, containing prior answered decisions and question dispositions with source provenance.

## Output

Return an `intake_json` object conforming to `p2a` package schema `intake.schema.json` with:

- `schema_version`: `p2a.intake.v1`
- `idea`: original idea
- `summary`: one paragraph restating the idea
- `known_facts`: facts stated by the user
- `assumptions`: objects with `id`, `statement`, `risk`, and `confirmation_needed`
- `clarifying_questions`: objects with `id`, `question`, `why_it_matters`, and potential canonical impacts in `blocks`, plus `status`, `answer`, explicit resolved `canonical_effect` (`change` or `preserve_baseline`), and actual canonical changes in `affected_fields` while the discovery interview is active
- `needs_user_decision`: objects with `id`, `question`, `options`, `impact`, non-empty potential canonical spec field refs in `blocks`, explicit answered `canonical_effect`, actual canonical changes in `affected_fields` after resolution, `default`, `status`, and optional `answer`
- optional `interview`: bounded working state with the current state, round counters, discovery dimension dispositions with canonical `affected_fields`, canonical `spec_updates`, asked/current question ids, remaining-question signal, blocker signal, and stop reason
- optional `baseline_context`: immutable baseline `spec_ref` plus `spec_sha256` and source-aware prior answers/dispositions supplied by an iterative baseline; preserve the hash and reuse relevant entries without silently overwriting them
- optional `approval_audit`: explicit Gate A confirmation recorded only after the user confirms the understanding summary
- `evidence`: source objects with `source_id`, `title`, `url`, and `used_for`
- `status`: for interview-aware intake, `blocked_on_user` until `interview.state` is `gate_a_confirmed`, then `ready_for_spec`; legacy intake without `interview` retains the existing decision-based status rule

- Also produce a conversation-ready response. During an active interview, make it a natural reply to the user's latest message rather than a Markdown intake report: acknowledge or answer first, offer a recommendation with brief rationale when useful, ask at most 1 to 3 questions in prose, and invite free-form answers or follow-up questions. During a paused interview, do not generate a new question batch or auto-resume; present the current blockers and confirmation-needed recommendations and offer the choices to continue, accept a recommendation, answer an existing blocker, or remain paused. During a blocked interview, do not generate a new question batch or offer automatic continuation; present materialized blockers and let the user answer an existing item directly, accept a recommendation, or defer it. At `hard_limit`, clear `has_unasked_high_impact_questions` and `new_blocker` only after representing every remaining blocker as an open CQ, ND, or discovery dimension. When the harness invokes this skill, return the complete `intake_json` privately to the harness for silent persistence. When the user invokes this skill directly without a parent harness, include the complete state in a named `intake_json` fenced block after the conversational response so the resumable state is not lost. Produce the full human-readable analysis only for the Gate A summary or an explicitly requested export; then include the restated understanding, each assumption with reasoning, and every `needs_user_decision` with option trade-offs, recommendation, rationale, blocked artifacts, and current status.

When `status` is `blocked_on_user`, explain the immediate blocker conversationally and offer the relevant choices without dumping the complete intake. Reserve headings, decision tables, and the full structured inventory for the Gate A summary or an explicitly requested export.

## Decision IDs

- Use stable ids like `ND-1`, `ND-2`, `CQ-1`, and `A-1`.
- Do not renumber existing ids during resume.
- Do not create a semantically duplicate question under a new id. Keep an unanswered question on its existing id, and keep answered ids in `interview.asked_question_ids`.
- For `clarifying_questions`, set `status` to `open`, `answered`, `assumed`, or `not_applicable`. `answered`, `assumed`, and `not_applicable` require a non-empty `answer`.
- Mark a decision `answered` only when the user's answer selects or clearly overrides an option.
- On resume, when you set a decision to `answered` in `intake_json.needs_user_decision`, update the conversational response and any previously user-requested `intake.md` export from the JSON. Do not create a new Markdown view during an active round or maintain Markdown as a second editable source.
- `intake_json` is canonical for each `needs_user_decision` status and selected answer.

## Discovery Interview

Treat the first idea as the start of an adaptive planning conversation, not a request for the user to author or review a requirements document.

1. Respond to the idea naturally. Offer a useful interpretation or recommendation with a brief reason before asking for more detail; do not announce artifact creation or present the full structured intake.
2. Select only the 1 to 3 highest-impact unanswered questions for the round.
3. Weave the questions into conversational prose, explain why they matter, and invite free-form answers and the user's own questions. For a formal `ND-n`, keep concrete options, trade-offs, a recommended default, and affected canonical fields in the returned JSON, but do not force the user through a comparison table or form.
4. Merge free-form answers into the existing stable ids, facts, assumptions, and discovery dimension dispositions. Keep `blocks` as the question's potential impact. For every resolved CQ/ND, set `canonical_effect: change` and record the exact changed fields in `affected_fields`, or set `canonical_effect: preserve_baseline` with empty `affected_fields` only when the answer explicitly preserves an existing baseline. Record the exact changed canonical fields in each dimension's `affected_fields`. For every resolved question, decision, or affected dimension, record one deterministic `interview.spec_updates` entry per affected canonical field: `append`, `replace`, or `remove`, the exact canonical values, all contributing `source_question_ids`, and any contributing `source_dimension_ids`. Without `baseline_context`, use `replace`; `append` and `remove` require a baseline canonical field.
5. Recompute readiness. If the interview remains active, return the next conversational response and bounded question batch while the harness silently persists `intake.json`. If it is paused or blocked, return the current blockers, confirmation-needed recommendations, and state-appropriate human choices without generating a new batch. If ready, present the organized Gate A understanding summary.

The required discovery dimensions are:

- `target_users`
- `core_problem`
- `expected_outcome`
- `mvp_scope`
- `non_goals`
- `success_criteria`
- `constraints_and_risks`
- `integrations_and_compatibility`

Dispose each dimension as `confirmed`, `assumed`, `not_applicable`, or `open`. Set `affected_fields` to the canonical fields changed by that disposition; use an empty array when the dimension explicitly preserves an existing baseline. In greenfield work without `baseline_context`, every `confirmed` or `assumed` dimension must declare at least one affected field; use `not_applicable` when the dimension does not apply. Do not ask all dimensions as a fixed questionnaire. A detailed input may reach summary readiness after zero or one follow-up round.

Normal readiness requires all of the following:

- no discovery dimension is `open`;
- no high-impact `ND-n` or retained `CQ-n` remains unresolved;
- `has_unasked_high_impact_questions` is false;
- `new_blocker` is false.

Before readiness, remove an unasked low-impact `CQ-n` that is no longer needed or dispose it as `assumed` with a concrete recommended answer. Never carry an `open` CQ into the Gate A summary or use the question text itself as its assumed answer.

Every actual `affected_fields` entry of an `answered`, `assumed`, or `not_applicable` `CQ-n`, every answered `ND-n`, and every non-open discovery dimension must be covered by `interview.spec_updates`. For compatibility, a resolved legacy interview item without `affected_fields` treats `blocks` as its actual fields. Every resolved interview-aware CQ/ND must record `canonical_effect`: `change` requires non-empty actual `affected_fields`, while `preserve_baseline` requires `baseline_context`, empty `affected_fields`, and no no-op update. A question-free ready interview must still record at least one dimension-sourced canonical update. Greenfield updates without `baseline_context` must use `replace`. Use `replace` or `remove` when current input supersedes baseline content; never preserve a conflicting baseline value by merely appending the answer text. A field may have only one update, but that update may cite multiple contributing question and dimension ids. Every update must materially change its Gate B field; do not append an existing value or remove a missing value merely to satisfy completeness.

When readiness is met, clear `current_question_ids`, set `state: ready_for_gate_a_summary`, and record `stop_reason: readiness`. Present the compact Gate A understanding summary, then set `state: awaiting_gate_a_confirmation`. Do not produce Gate B until the user explicitly confirms the summary.

Do not propose or generate `intake.md` while `interview.state` is `interview_active`, `paused`, or `blocked_on_user` unless the user explicitly requests a Markdown export. An explicit export must start with `<!-- plan2agent:intake-md-export=explicit -->` so the harness can preserve it across resumes without retaining legacy automatic views. The harness still persists `intake.json` after every round for safe resume. First expose the organized structured understanding with the Gate A summary.

If the user says to summarize, stop, or accept the recommendations, stop asking automatically. Apply explicitly accepted recommendations as assumptions. If readiness is then met, present the Gate A summary with `stop_reason: user_requested`; otherwise set `state: blocked_on_user` and show the remaining blockers and the choices to answer, accept a recommendation, defer, or pause.

Guardrails:

- soft limit: 3 rounds; show the current summary, remaining blockers, and recommended assumptions, then ask whether to continue. Set `soft_limit_acknowledged: true` only after the user explicitly chooses to continue; do not infer it from another answer or resume request;
- hard limit: 5 rounds; stop automatically;
- no progress: 2 consecutive rounds without a new fact, answer, or disposition change; stop automatically;
- hard-limit or no-progress stop with blockers remains `blocked_on_user`; never claim Gate A completion.

When blockers remain at round 5, record `hard_limit` even if another stop condition is also true. Before round 5, two no-progress rounds require `no_progress`; do not relabel either automatic guard as `user_requested` or `soft_limit`.

The transition is deterministic from `intake_json.interview`; question wording may be generated by the model, but readiness and guard state are not subjective model judgments.

## Gate A Confirmation

After the user explicitly confirms the presented Gate A summary:

- set `interview.state` to `gate_a_confirmed`;
- set `status` to `ready_for_spec`;
- record `approval_audit` with the actual approver label, date, `approved_artifacts` containing `gate-a-intake/intake.json`, and an `approval_note` that quotes or references the confirmation;
- hand the compact confirmed intake to Gate B in the same harness session.

Never infer confirmation from silence, from a request to start development, or from acceptance of an individual interview default. Interview completion, Gate A confirmation, and Gate B approval are three separate transitions.

For iterative work, read relevant `baseline_context.reused_answers` and `reused_question_dispositions` before creating a new question. Reuse a prior answer when the affected scope is unchanged and retain its source provenance. If the new answer conflicts with a reused answer, create or reuse a current-iteration decision id and record the override; do not mutate the baseline record.

## Rules

- Ask only questions that materially change product scope, data shape, UI flow, or implementation risk.
- Keep active rounds conversational: answer or acknowledge first, explain recommendations briefly, invite free-form replies, and avoid headings, questionnaires, tables, artifact inventories, and JSON dumps.
- Prefer defaults for low-risk details and label them as assumptions.
- Stop at intake when high-impact decisions remain open or deferred, the interview is paused/blocked, or Gate A confirmation is pending.
- Do not design the full implementation yet.
- Follow the Evidence and Citation Contract in `.agents/skills/p2a-harness/SKILL.md` for `USER-n`, `LOCAL-n`, `WEB-n`, Feature Radar, and web-lookup evidence. If prior-art or domain lookup changes a question or assumption, cite the source id in the rationale.
- Consume harness-provided Memory recall reports under the Planning Memory Recall contract. Preserve their recorded state and failure/fallback disclosure. Cite each consumed report as `LOCAL-n`, including query, requested/effective mode, fallback, and the actual result reference in `used_for`; keep it as context unless it materially changes a question or assumption. Do not independently rerun equivalent queries.
- Do not edit files or run commands.
- Do not write files yourself. When invoked by the harness, return `intake_json` and the conversation-ready response so the harness orchestrator can persist the JSON silently and control when any Markdown view is generated. In a direct invocation with no parent harness, surface the same canonical state in a named `intake_json` fenced block after the response.
