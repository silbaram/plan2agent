---
name: p2a-harness
description: Use when turning a one-sentence product idea into a gated Plan2Agent intake, spec, implementation plan, task graph, and review report.
---

# Plan2Agent Harness

Use this workflow to convert an early product idea into development-ready planning artifacts. The harness is an orchestrator, not a checklist: it decides which Plan2Agent role owns each stage, enforces approval gates, and resumes from the latest completed artifact.

## Inputs

- A one-sentence product or feature idea.
- Optional clarification answers, constraints, audience, or existing artifacts.
- Optional resume point such as `resume_from: intake`, `resume_from: spec`, or answered decision ids like `ND-1`.

## Stage to Role Mapping

| Stage | Skill | Subagent owner | Input artifact | Output artifact |
| --- | --- | --- | --- | --- |
| 1. Intake | `p2a-intake` | `p2a-requirements` | raw idea and notes | `intake_json` (`p2a.intake.v1`) |
| 2. Product spec | `p2a-spec` | `p2a-spec-author` | intake plus answered decisions | `spec_json.product` (`p2a.spec.v1`) |
| 3. Implementation plan | `p2a-spec` | `p2a-implementation-planner` | product spec draft plus Gate A constraints | `spec_json.implementation` (`p2a.spec.v1`) |
| 4. Task graph | `p2a-task-breakdown` | `p2a-task-graph` | approved implementation spec | `task_graph_json` (`p2a.task_graph.v1`) |
| 5. Review | `p2a-review` | `p2a-quality-reviewer` | spec and task graph | `review_json` (`p2a.review.v1`) |

If the CLI cannot spawn subagents automatically, run the matching skill locally and preserve the same input/output contracts.

## Approval Gates

- **Gate A — Intake decisions:** If any `needs_user_decision.status` is `open` or `deferred`, stop after intake and ask only those decisions. Do not produce a product spec except as a clearly labeled sketch.
- **Gate B — Spec approval:** If `spec_json.approval` is not `approved`, `spec_json.approval_audit` is missing, or `spec_json.open_decisions` is non-empty, stop before task graph generation. When Gate B selects or recommends a library, framework, runtime, protocol, or external service, apply the `p2a-spec` Technology Reconnaissance rules before approval. When Gate B is approved, record the Gate B approval audit in `spec_json.approval_audit`.
- **Gate C — Task graph validation:** Before final output, check that every dependency references a task id, the graph is acyclic, and every task has acceptance criteria.
- **Gate D — Review blockers:** If review finds blocking issues, return the blockers and the artifact section that must be revised instead of claiming the plan is ready.

Each gate is a review checkpoint, not a one-shot hand-off. At every gate: (1) persist the stage's canonical JSON artifact files and optionally refresh generated Markdown views, (2) present a readable summary with per-item rationale and recommendations, (3) explicitly invite both open-ended feedback and structured answers or approval, (4) revise the JSON artifacts and re-present them when the user responds, and (5) advance only after the user explicitly approves. Never infer approval from silence.

## Clarifying Question Disposition

`clarifying_questions` (`CQ-n`) are lightweight intake prompts. They do not block Gate A by themselves, but every intake `CQ-n` must be explicitly disposed in `spec_json.clarifying_question_disposition` before Gate B can pass.

Use exactly one disposition per intake `CQ-n`:

- `answered` — the spec incorporates a user answer or an already-resolved decision; include `resolved_by`.
- `assumed` — the spec proceeds with a low-risk explicit assumption; include `assumption`.
- `deferred_non_goal` — the question is intentionally out of v1 scope; include `non_goal`.
- `promoted_to_decision` — the question is high-impact and must be tracked as a formal decision; include `promoted_decision_id`.

Do not put raw `CQ-n` ids in `spec_json.open_decisions`. If a clarifying question blocks product or implementation correctness, promote it to an `ND-n` decision. An unresolved promoted decision remains in `open_decisions` and keeps the spec in `draft`; a resolved promoted decision records `resolution` in the disposition and is removed from `open_decisions`.

## Gate A/B Technology Boundary

Gate A identifies product scope, hard constraints, and architecture-changing choices; it does not design the full stack. If a technology choice changes the product boundary or major implementation model, such as runtime, deployment shape, persistence requirement, protocol compatibility, cloud dependency, or library-vs-service posture, ask it as a Gate A `needs_user_decision`.

Gate B chooses or recommends the concrete stack within the approved Gate A constraints. Use read-only technology reconnaissance in Gate B when current ecosystem knowledge matters, compare viable options, record material sources in `spec_json.evidence`, and leave high-impact unresolved choices in `spec_json.open_decisions` instead of silently deciding.

## Analysis and Decision Presentation

Before asking the user to decide anything, present a written analysis — do not jump straight to a list of options.

The analysis must include:

- A restatement of the idea and the scope you inferred, separating what is clear from what is unknown.
- Each assumption with its risk level and the reasoning behind it.
- For every `needs_user_decision`: the question, why it matters, each option with its concrete trade-offs, a recommended option with explicit rationale grounded in the stated goals, constraints, and any prior art, and which downstream artifacts or decisions it blocks.

Write this analysis into the conversation and the structured `intake_json` fields. Generate `intake.md` only as an optional view/export when the user or UI needs a Markdown document. Treat decision-making as a dialogue: invite the user to correct your understanding and give free-form feedback, not only to pick options. Do not collapse several distinct high-impact decisions into a single multi-select that hides their individual rationale; ask in small, clearly explained batches.

If `intake.md` is generated, it should follow this recommended soft template, mapping each narrative section to the matching `intake_json` field without changing JSON field names:

1. **Understanding** — restate the idea and inferred scope from `known_facts`, separating what is clear from what remains unknown.
2. **Assumptions** — cover `assumptions` using each item's `id`, `statement`, `risk`, reasoning, and `confirmation_needed`.
3. **Decisions** — cover `needs_user_decision` with the question, why it matters, options and concrete trade-offs, recommended option and rationale, downstream artifacts or decisions it blocks, and current status (`open`, `answered`, or `deferred`). If status is `answered`, explicitly show the selected option/answer, for example `선택: <option label>` or `Selected: <option label>`.
4. **Clarifying questions** — cover `clarifying_questions` with each `id`, question, and current handling or default.
5. **Next** — state `status` and what is needed from the user.

This is a narrative-first recommended structure, not a blank form. Preserve the existing requirements for explanation, evidence, trade-off analysis, and recommendations. Tables may help scan the content, but they are supplemental and must not replace the written explanation. Render section headings and labels in the user's language when appropriate (for example Korean: `1. 이해`, `2. 가정`, `3. 결정`, `4. 소프트 질문`, `5. 다음`), while preserving the English JSON field names such as `assumptions` and the label meaning of **Assumptions/가정**; do not rename it to a different concept such as "proposal."

## Resume Rules

- When the user answers decisions such as `ND-1` or `ND-4`, merge the answers into `intake_json.needs_user_decision[*].answer`, set those decisions to `answered`, and recompute `intake_json.status`. If a generated `gate-a-intake/intake.md` view exists, refresh it from JSON instead of editing it as a second source of truth.
- Resume from the earliest stage whose input changed. For example, changed intake answers invalidate spec, implementation plan, task graph, and review.
- Carry forward stable artifact ids (`project_id`, `source_intake`, `sourceSpec`) so later stages can trace their source. Use the gate-folder paths for cross-artifact references, for example `.plan2agent/artifacts/<project_id>/gate-a-intake/intake.json` for `source_intake` and `.plan2agent/artifacts/<project_id>/gate-b-spec/spec.json` for `sourceSpec`.
- If an artifact is pasted in Markdown only, reconstruct the matching JSON contract before advancing to the next gate.

## State Passing Contract

Return intermediate artifacts in fenced code blocks named exactly:

- `intake_json`
- `spec_json`
- `task_graph_json`
- `review_json`

`intake_json`, `spec_json`, `task_graph_json`, and `review_json` must conform to `.plan2agent/schemas/intake.schema.json`, `.plan2agent/schemas/spec.schema.json`, `.plan2agent/schemas/task-graph.schema.json`, and `.plan2agent/schemas/review.schema.json` respectively. `intake_json.evidence` and `spec_json.evidence` carry all user, local, and web sources used by the run.

## Artifact Persistence

In addition to the inline state sections, the harness orchestrator writes canonical JSON artifacts to files so the user and tools can review them before any gate. Use a stable `project_id` (kebab-case, derived from the idea or carried forward) and keep all files for one run under `.plan2agent/artifacts/<project_id>/` using gate-specific folders:

- `gate-a-intake/intake.json` — the `intake_json` artifact
- `gate-b-spec/spec.json` — the `spec_json` artifact
- `gate-c-task-graph/task-graph.json` — the `task_graph_json` artifact
- `gate-d-review/review.json` — the `review_json` artifact

Optional/generated Markdown views may be written beside the JSON files when needed for export, sharing, or a UI preview: `status.md`, `gate-a-intake/intake.md`, `gate-b-spec/product-spec.md`, `gate-b-spec/implementation-plan.md`, and `gate-d-review/review-report.md`. These Markdown files are never the source of truth; regenerate them from JSON rather than preserving independent edits. Only the harness orchestrator writes files; subagents stay read-only and return their content for the orchestrator to persist. Continue to surface the inline named JSON sections as well so resume and paste-in still work.

### Generated `status.md` View

`status.md` is a generated readable view, not a control-plane artifact. `current-spec.json`, `iteration.json`, `spec.json`, `task-graph.json`, and `review.json` carry canonical gate state, active iteration pointers, and approval audits. If `status.md` is generated, keep it valid for `.plan2agent/scripts/validate_artifacts.mjs --status`: it must include a literal `Progress:` line, Gate A, Gate B, Gate C, and Gate D sections, plus numbered `## 1.` through `## 5.` sections. Use this standard skeleton:

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

### Facts From Tools

Do not retype gate status facts from memory. Pull gate status, task counts, `ready` / `in_progress` state, approval state, and blocking counts from the artifacts and tools: `spec.json` (`approval`, `open_decisions`), `task-graph.json`, `p2a_tasks` (`list` / `ready`), `validate_artifacts`, and `review.json.blocking_issues`. If a fact cannot be derived from those sources, mark it as unknown or pending rather than inventing it.

## Evidence and Citation Contract

- Use `USER-n` for user-provided source material, `LOCAL-n` for repository/local artifacts, and `WEB-n` for web lookup sources.
- Every `WEB-n` evidence item must include an `https://` or `http://` URL, title, and short `used_for` rationale.
- If web lookup materially affects a question, assumption, product decision, or integration choice, include the source in `evidence` and refer to its `source_id` in nearby rationale text.
- Do not use web lookup for implementation execution; it is only allowed for read-only prior-art or domain grounding.

## Output Modes

- **Blocked intake:** Write `gate-a-intake/intake.json`, optionally generate `gate-a-intake/intake.md`, present the analysis narrative and per-decision recommendations, invite feedback and answers, and stop at Gate A.
- **Draft spec:** Write `gate-b-spec/spec.json` with `approval: draft`, optionally generate product/implementation Markdown views, present it for review, and stop at Gate B before the task graph.
- **Approved planning output:** Write all canonical JSON artifact files, optionally refresh generated Markdown views, and return the state sections after gates pass. In a co-located scaffold project, make the next action `node .plan2agent/scripts/p2a_iteration.mjs init --artifacts .plan2agent/artifacts/<project_id> --iteration-id v1-mvp` and explicitly state that development must not start from the root `gate-c-task-graph/task-graph.json`.
- **Resume output:** Regenerate only the downstream JSON artifacts and optional generated views, plus a short changelog of which decisions were applied.

## Rules

- You MAY create or update Plan2Agent planning artifacts (`.md` / `.json`) under `.plan2agent/artifacts/<project_id>/`.
- Do NOT edit application or source code, install dependencies, run shell commands for implementation, or perform git operations.
- Subagents remain strictly read-only; only the harness orchestrator persists artifact files.
- Treat JSON as canonical. Markdown files are generated views/exports and must not be used as independent state.
- Do not claim that implementation happened.
- Mark unresolved decisions as `needs_user_decision`.
- Keep tasks small enough for one agent or developer to complete independently.
- After Gate D passes in a co-located scaffold project, stop before development execution and direct the user to convert the greenfield gate bundle with `p2a_iteration init`; do not set or recommend `.plan2agent/project.config.json.taskGraph` to the root `gate-c-task-graph/task-graph.json`.
