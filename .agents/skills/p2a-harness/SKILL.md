---
name: p2a-harness
description: Use when turning a one-sentence product idea into a gated Plan2Agent intake, spec, implementation plan, task graph, and review report.
---

# Plan2Agent Harness

Use this workflow to convert an early product idea into development-ready planning artifacts. The harness is an orchestrator, not a checklist: it decides which Plan2Agent role owns each stage, enforces approval gates, and resumes from the latest completed artifact.

## Inputs

- A one-sentence product or feature idea.
- Optional clarification answers, constraints, audience, or existing artifacts.
- Optional Feature Radar preflight research under `.plan2agent/artifacts/<project_id>/preflight-research/`.
- Optional resume point such as `resume_from: interview`, `resume_from: gate-a-summary`, `resume_from: spec`, or answered question/decision ids like `CQ-1` or `ND-1`.

## Stage to Role Mapping

| Stage | Skill | Subagent owner | Input artifact | Output artifact |
| --- | --- | --- | --- | --- |
| 1. Discovery and intake | `p2a-intake` | `p2a-requirements` | raw idea, notes, and optional baseline context | interview-aware `intake_json` (`p2a.intake.v1`) |
| 2. Product spec | `p2a-spec` | `p2a-spec-author` | intake plus answered decisions | `spec_json.product` (`p2a.spec.v1`) |
| 3. Implementation plan | `p2a-spec` | `p2a-implementation-planner` | product spec draft plus Gate A constraints | `spec_json.implementation` (`p2a.spec.v1`) |
| 4. Task graph | `p2a-task-breakdown` | `p2a-task-graph` | approved implementation spec | `task_graph_json` (`p2a.task_graph.v1`) |
| 5. Review | `p2a-review` | `p2a-quality-reviewer` | spec and task graph | `review_json` (`p2a.review.v1`) |

If the CLI cannot spawn subagents automatically, run the matching skill locally and preserve the same input/output contracts.

## Approval Gates

- **Gate A — Understanding confirmation:** Run the bounded discovery interview until its readiness/guard contract stops it. If any high-impact question or decision remains unresolved, or `interview.state` is not `gate_a_confirmed`, stop at Gate A. Present a compact understanding summary and require explicit confirmation recorded in `intake_json.approval_audit`. Do not produce Gate B before confirmation.
- **Gate B — Spec approval:** If any intake `CQ-n` is not disposed in `spec_json.clarifying_question_disposition`, `spec_json.approval` is not `approved`, `spec_json.approval_audit` is missing, or `spec_json.open_decisions` is non-empty, stop before task graph generation. When Gate B selects or recommends libraries, frameworks, runtimes, protocols, packages, databases, cloud services, external APIs, or external services, apply the `p2a-spec` Technology Reconnaissance rules before approval and record material sources in `spec_json.evidence`. Missing Technology Reconnaissance evidence for a material Gate B technology choice is a blocking Gate B issue. When Gate B is approved, record the Gate B approval audit in `spec_json.approval_audit`.
- **Gate C — Task graph validation:** Before final output, check that every dependency references a task id in the same graph, the graph is acyclic, and every task has acceptance criteria. Repository validation also requires each task to carry source spec references. Inspect `context.planning_memory` before decomposition. When retrieved history changes a task boundary, dependency, acceptance criterion, or failure mitigation, add a `memory:<report path or source reference>` ref and any applicable `decision:ND-n` ref alongside at least one real effective-spec field.
- **Gate D — Review blockers:** The canonical Gate D artifact is `review_json` persisted as `gate-d-review/review.json`; `review_report` / `review-report.md` is an optional Markdown rendering of the same findings. Gate D passes only when `review.json.blocking_issues` is `[]`. Validate claimed Memory report/citation integrity and confirm that tasks address any material prior failure carried into Gate C. Memory being disabled, unavailable, or irrelevant is not itself a blocker; an invalid claim of use or an ignored material failure is. If review finds blocking issues, return the blockers and the artifact section that must be revised instead of claiming the plan is ready.

Each gate is a review checkpoint, not a one-shot hand-off. At every gate: (1) persist the stage's canonical JSON artifact files and optionally refresh generated Markdown views, (2) present a readable summary with per-item rationale and recommendations, (3) explicitly invite both open-ended feedback and structured answers or approval, (4) revise the JSON artifacts and re-present them when the user responds, and (5) advance only after the user explicitly approves. Never infer approval from silence.

## Discovery Interview Loop

The user experience from a one-line idea through Gate B is one continuous planning session:

```text
one-line idea
  -> adaptive discovery rounds
  -> Gate A understanding summary
  -> explicit Gate A confirmation
  -> same-session Gate B synthesis
  -> explicit Gate B approval
```

Gate A and Gate B remain separate canonical artifacts and approvals. Do not add a gate, merge `intake.json` and `spec.json`, or approve an unseen Gate B together with Gate A.

Use `intake_json.interview` as the bounded working snapshot. Do not preserve or repeatedly inject the full transcript. Each round consumes the latest snapshot, the newest user answer, open decisions, and material evidence only.

For each round:

1. Merge the user's free-form answer into existing stable `CQ-n`, `ND-n`, facts, assumptions, and discovery dimension dispositions. Keep CQ/ND `blocks` as potential impacts. Set resolved CQ/ND `canonical_effect` to `change` with exact non-empty actual canonical `affected_fields`, or to `preserve_baseline` with empty `affected_fields` only for an explicit existing-baseline preservation answer.
2. Count the round as progress only when a fact, answer, or disposition changed.
3. Recompute readiness from the structured state.
4. If not ready, ask only the 1 to 3 highest-impact remaining questions.
5. If ready, present the Gate A summary and wait for explicit confirmation.

The eight required discovery dimensions and their dispositions are defined in `p2a-intake`. Readiness requires every dimension disposed, no unresolved high-impact question/decision, no unasked high-impact candidate, and no newly introduced blocker.

Enforce these guardrails:

- soft limit at 3 rounds: present the current summary, blockers, and recommended assumptions; ask whether to continue. Continue questioning only after the user explicitly chooses continue and record `soft_limit_acknowledged: true`;
- hard limit at 5 rounds: stop automatic questioning;
- no-progress limit at 2 consecutive rounds: stop automatic questioning;
- hard/no-progress stop with blockers: `blocked_on_user`, never Gate A complete or Gate B entry.

If the user asks to stop or summarize, stop the interview and present the candidate summary. With blockers, offer answer, explicit recommended-assumption acceptance, defer/pause, or later resume. Without blockers, move to `awaiting_gate_a_confirmation`.

After explicit confirmation, write `intake_json.approval_audit`, set `interview.state: gate_a_confirmed` and `status: ready_for_spec`, then continue directly to Gate B in this same session. Do not require the user to invoke another command or open another agent session.

For iterative work, inspect `intake_json.baseline_context` before asking new questions. Preserve its immutable `spec_ref` and `spec_sha256`, and reuse relevant prior answers and question dispositions with provenance. Ask again only when the change affects their scope or conflicts with the baseline. Never silently overwrite a reused answer; record the current-iteration override under a current stable decision id.

## Clarifying Question Disposition

The canonical `CQ-n` disposition statuses and required fields are owned by `.agents/skills/p2a-spec/SKILL.md` under "Clarifying Question Disposition Contract". Harness Gate B blocks unless every intake `CQ-n` is disposed there, no raw `CQ-n` appears in `spec_json.open_decisions`, and unresolved blocking clarifying questions are promoted to `ND-n` decisions that keep the spec in `draft`.

## Gate A/B Technology Boundary

Gate A identifies product scope, hard constraints, and architecture-changing choices; it does not design the full stack. If a technology choice changes the product boundary or major implementation model, such as runtime, deployment shape, persistence requirement, protocol compatibility, cloud dependency, or library-vs-service posture, ask it as a Gate A `needs_user_decision`.

Gate B chooses or recommends the concrete stack within the approved Gate A constraints. Use read-only technology reconnaissance in Gate B when current ecosystem knowledge matters, compare viable options, record material sources in `spec_json.evidence`, and leave high-impact unresolved choices in `spec_json.open_decisions` instead of silently deciding.

## Planning Memory Recall

Read this procedure only for an iterative artifact root with at least one closed iteration and configured Memory.
For a first iteration or unconfigured Memory, do not read it.

When both conditions hold, read `references/memory-recall.md`.

## Analysis and Decision Presentation

Before asking the user to decide anything, present a written analysis — do not jump straight to a list of options.

The analysis must include:

- A restatement of the idea and the scope you inferred, separating what is clear from what is unknown.
- Each assumption with its risk level and the reasoning behind it.
- For every `needs_user_decision`: the question, why it matters, each option with its concrete trade-offs, a recommended option with explicit rationale grounded in the stated goals, constraints, and any prior art, and non-empty canonical `spec.product.*` or `spec.implementation.*` field refs in `blocks`.

Write this analysis into the conversation and the structured `intake_json` fields. Generate `intake.md` only as an optional view/export when the user or UI needs a Markdown document. Treat decision-making as a dialogue: invite the user to correct your understanding and give free-form feedback, not only to pick options. Do not collapse several distinct high-impact decisions into a single multi-select that hides their individual rationale; ask 1 to 3 high-impact questions per round.

If `intake.md` is generated, it should follow this recommended soft template, mapping each narrative section to the matching `intake_json` field without changing JSON field names:

1. **Understanding** — restate the idea and inferred scope from `known_facts`, separating what is clear from what remains unknown.
2. **Assumptions** — cover `assumptions` using each item's `id`, `statement`, `risk`, reasoning, and `confirmation_needed`.
3. **Decisions** — cover `needs_user_decision` with the question, why it matters, options and concrete trade-offs, recommended option and rationale, downstream artifacts or decisions it blocks, and current status (`open`, `answered`, or `deferred`). If status is `answered`, explicitly show the selected option/answer, for example `선택: <option label>` or `Selected: <option label>`.
4. **Clarifying questions** — cover `clarifying_questions` with each `id`, question, and current handling or default.
5. **Next** — state `status` and what is needed from the user.

This is a narrative-first recommended structure, not a blank form. Preserve the existing requirements for explanation, evidence, trade-off analysis, and recommendations. Tables may help scan the content, but they are supplemental and must not replace the written explanation. Render section headings and labels in the user's language when appropriate (for example Korean: `1. 이해`, `2. 가정`, `3. 결정`, `4. 소프트 질문`, `5. 다음`), while preserving the English JSON field names such as `assumptions` and the label meaning of **Assumptions/가정**; do not rename it to a different concept such as "proposal."

## Resume Rules

- When the user answers `CQ-n` or `ND-n`, merge the answer into the existing item, update its status and affected discovery dimensions, update round/no-progress counters, and recompute `intake_json.interview`. Do not renumber or recreate answered ids. If a generated `gate-a-intake/intake.md` view exists, refresh it from JSON instead of editing it as a second source of truth.
- On `resume_from: interview`, continue only the current interview batch or select the next 1 to 3 questions after merging new answers.
- On `resume_from: gate-a-summary`, present the compact summary and set `awaiting_gate_a_confirmation`; do not synthesize Gate B in advance.
- On `resume_from: spec`, require a validated `gate_a_confirmed` state and Gate A `approval_audit`, then synthesize Gate B in the same session.
- Resume from the earliest stage whose input changed. For example, changed intake answers invalidate spec, implementation plan, task graph, and review.
- Carry forward stable artifact ids (`project_id`, `source_intake`, `sourceSpec`) so later stages can trace their source. Use the gate-folder paths for cross-artifact references, for example `.plan2agent/artifacts/<project_id>/gate-a-intake/intake.json` for `source_intake` and `.plan2agent/artifacts/<project_id>/gate-b-spec/spec.json` for `sourceSpec`. For interview-aware Gate B, bind `spec_json` to the exact persisted Gate A bytes with `source_intake_sha256`; if Gate A changes, regenerate Gate B instead of refreshing the hash on the stale spec.
- If an artifact is pasted in Markdown only, reconstruct the matching JSON contract before advancing to the next gate.

## Starting From Existing Documents

Read this procedure only when starting from existing planning documents or prior Plan2Agent artifacts.
When starting from a product idea without existing documents, do not read it.

When existing-document input is present, read `references/existing-documents.md`.

## State Passing Contract

Return intermediate artifacts in fenced code blocks named exactly:

- `intake_json`
- `spec_json`
- `task_graph_json`
- `review_json`

`intake_json`, `spec_json`, `task_graph_json`, and `review_json` must conform to `p2a` package schema `intake.schema.json`, `p2a` package schema `spec.schema.json`, `p2a` package schema `task-graph.schema.json`, and `p2a` package schema `review.schema.json` respectively. `intake_json.evidence` and `spec_json.evidence` carry all user, local, and web sources used by the run.

## Artifact Persistence

In addition to the inline state sections, the harness orchestrator writes canonical JSON artifacts to files so the user and tools can review them before any gate. In a scaffold project, use `.plan2agent/project.config.json.projectId` as the canonical `project_id`; if it is missing, fall back to `.plan2agent/manifest.json.projectId`, then an existing artifact/spec/task graph project id, then the target/project root basename normalized to kebab-case. Treat the directory basename as a fresh-scaffold seed, not the source of truth. Only derive a kebab-case id from the idea when no scaffold config, manifest, or existing artifact id exists. Keep all files for one run under `.plan2agent/artifacts/<project_id>/` using gate-specific folders:

- `gate-a-intake/intake.json` — the `intake_json` artifact
- `gate-b-spec/spec.json` — the `spec_json` artifact
- `gate-c-task-graph/task-graph.json` — the `task_graph_json` artifact
- `gate-d-review/review.json` — the `review_json` artifact
- `preflight-research/` — optional copied Feature Radar artifacts. Treat these as read-only input evidence, not gate state.

Optional/generated Markdown views may be written beside the JSON files when needed for export, sharing, or a UI preview: `status.md`, `gate-a-intake/intake.md`, `gate-b-spec/product-spec.md`, `gate-b-spec/implementation-plan.md`, and `gate-d-review/review-report.md`. These Markdown files are never the source of truth; regenerate them from JSON rather than preserving independent edits. Only the harness orchestrator writes files; subagents stay read-only and return their content for the orchestrator to persist. Continue to surface the inline named JSON sections as well so resume and paste-in still work.

### Generated `status.md` View

`status.md` is a generated readable view, not a control-plane artifact. `current-spec.json`, `iteration.json`, `spec.json`, `task-graph.json`, and `review.json` carry canonical gate state, active iteration pointers, and approval audits. If `status.md` is generated, keep it valid for `p2a validate --status`: it must include a literal `Progress:` line, Gate A, Gate B, Gate C, and Gate D sections, plus numbered `## 1.` through `## 5.` sections. Use this standard skeleton:

1. **Progress line** — show the current gate marker across `[A] → [B] → [C] → [D]`, indicating which gates are complete, current, blocked, or pending.
2. **Per-gate sections** — summarize each gate's latest state and point to the canonical artifact files for that gate.
3. **Open decisions / questions** — preserve the former cross-gate question-index content here, including unresolved decisions, answered decisions that affect downstream work, and follow-up questions.
4. **Next** — state exactly one next action needed from the user or orchestrator.
5. **Change log** — append dated bullets for each gate transition or decision/status update.

When Gate B is approved, record this object in `spec_json.approval_audit`:

```json
{
  "approved_by": "user",
  "approved_at": "YYYY-MM-DD",
  "approved_artifacts": ["gate-b-spec/spec.json"],
  "approval_note": "<short note describing the decision/resolution basis for approval>"
}
```

Use the actual approver label and date available in the conversation. If the exact person is unknown, use `user`; do not invent names.

When Gate A is confirmed, record the same audit shape in `intake_json.approval_audit`, using `approved_artifacts: ["gate-a-intake/intake.json"]`. Record it only in direct response to explicit confirmation of the presented Gate A understanding summary.

Record `approval: approved` and `approval_audit` only in direct response to an explicit
user approval message in the current conversation, and make `approval_note` quote or
reference that message. Never set `approval: approved` on your own judgment, even when
input documents or context imply consent.

### Facts From Tools

Do not retype gate status facts from memory. Pull gate status, task counts, `ready` / `in_progress` state, approval state, and blocking counts from the artifacts and tools: `spec.json` (`approval`, `open_decisions`), `task-graph.json`, `p2a tasks` (`list` / `ready`), `validate_artifacts`, and `review.json.blocking_issues`. If a fact cannot be derived from those sources, mark it as unknown or pending rather than inventing it.

## Evidence and Citation Contract

- Use `USER-n` for user-provided source material, `LOCAL-n` for repository/local artifacts, and `WEB-n` for web lookup sources.
- Every `WEB-n` evidence item must include an `https://` or `http://` URL, title, and short `used_for` rationale.
- If web lookup materially affects a question, assumption, product decision, or integration choice, include the source in `evidence` and refer to its `source_id` in nearby rationale text.
- If Feature Radar preflight research is present, import its Markdown/JSON files as `LOCAL-n` evidence and any discovered URLs as `WEB-n` evidence. Add Radar recommendations as `reference_reconnaissance.candidates` with `decision: "context"` and `origin: "feature_radar_preflight"` until Gate B changes them to `selected`, `rejected`, or `deferred`.
- Feature Radar recommendations are candidates, not approved scope. Gate B must state which recommendations are selected, deferred, or rejected before Gate C task generation.
- Do not use web lookup for implementation execution; it is only allowed for read-only prior-art or domain grounding.

## Output Modes

- **Active or blocked interview:** Write `gate-a-intake/intake.json`, optionally generate `gate-a-intake/intake.md`, present the current understanding and the bounded question batch or blockers, invite free-form answers, and stop at Gate A.
- **Gate A confirmation:** Present the compact understanding summary, invite corrections or explicit confirmation, and stop without creating Gate B. After confirmation is received in the next user turn, persist the Gate A audit and create only the Gate B draft in that turn.
- **Draft spec:** Write `gate-b-spec/spec.json` with `approval: draft`, optionally generate product/implementation Markdown views, present it for review, and stop at Gate B before the task graph.
- **Approved planning output:** Write all canonical JSON artifact files, optionally refresh generated Markdown views, and return the state sections after gates pass. In a co-located scaffold project, make the next action `p2a iteration init --artifacts .plan2agent/artifacts/<project_id> --iteration-id v1-mvp` and explicitly state that development must not start from the root `gate-c-task-graph/task-graph.json`.
- **Resume output:** Regenerate only the downstream JSON artifacts and optional generated views, plus a short changelog of which decisions were applied.

## Rules

- You MAY create or update Plan2Agent planning artifacts (`.md` / `.json`) under `.plan2agent/artifacts/<project_id>/`.
- Do NOT edit application or source code, install dependencies, run shell commands for implementation, or perform git operations.
- Subagents remain strictly read-only; only the harness orchestrator persists artifact files.
- Treat JSON as canonical. Markdown files are generated views/exports and must not be used as independent state.
- Do not claim that implementation happened.
- Mark unresolved decisions as `needs_user_decision` with non-empty canonical spec field refs in `blocks`.
- Before Gate A confirmation, require every resolved CQ/ND to declare `canonical_effect`: `change` requires non-empty actual `affected_fields`, while `preserve_baseline` requires an existing baseline and empty `affected_fields`. Cover every actual CQ/ND and non-open discovery dimension `affected_fields` entry with deterministic `interview.spec_updates`. In greenfield work, every confirmed/assumed dimension must affect at least one canonical field or be marked `not_applicable`, and every update must use `replace` because no baseline canonical field exists. Cite contributing questions and dimensions, use replace/remove rather than append when current input overrides the baseline, and reject no-op updates.
- Existing design or plan documents in the target repository, however complete, are
  `LOCAL-n` input evidence only. They never justify skipping a gate, producing more than
  one gate's artifacts, or treating any gate as approved.
- Broad instructions such as "let's develop this" authorize starting at the earliest
  applicable gate only; they are not approval for later gates or for implementation.
- Never produce artifacts for more than one gate in a single turn. After presenting a
  gate, stop and wait for the user's explicit response.
- Keep tasks small enough for one agent or developer to complete independently.
- After Gate D passes in a co-located scaffold project, stop before development execution and direct the user to convert the greenfield gate bundle with `p2a iteration init`; do not set or recommend `.plan2agent/project.config.json.taskGraph` to the root `gate-c-task-graph/task-graph.json`.
