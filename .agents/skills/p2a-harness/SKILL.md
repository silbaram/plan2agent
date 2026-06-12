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
| 2. Product spec | `p2a-spec` | `p2a-spec-author` | intake plus answered decisions | `product_spec_markdown`, `spec_json` (`p2a.spec.v1`) |
| 3. Implementation plan | `p2a-spec` | `p2a-implementation-planner` | approved product spec | `implementation_plan_markdown`, updated `spec_json` |
| 4. Task graph | `p2a-task-breakdown` | `p2a-task-graph` | approved implementation spec | `task_graph_json` (`p2a.task_graph.v1`) |
| 5. Review | `p2a-review` | `p2a-quality-reviewer` | spec and task graph | `review_report`, `review_json` (`p2a.review.v1`) |

If the CLI cannot spawn subagents automatically, run the matching skill locally and preserve the same input/output contracts.

## Approval Gates

- **Gate A — Intake decisions:** If any `needs_user_decision.status` is `open` or `deferred`, stop after intake and ask only those decisions. Do not produce a product spec except as a clearly labeled sketch.
- **Gate B — Spec approval:** If `spec_json.approval` is not `approved` or `spec_json.open_decisions` is non-empty, stop before task graph generation.
- **Gate C — Task graph validation:** Before final output, check that every dependency references a task id, the graph is acyclic, and every task has acceptance criteria.
- **Gate D — Review blockers:** If review finds blocking issues, return the blockers and the artifact section that must be revised instead of claiming the plan is ready.

Each gate is a review checkpoint, not a one-shot hand-off. At every gate: (1) persist the stage's artifact files **and refresh top-level `status.md`** (progress line, this gate's section, open decisions, next action, change-log entry), (2) present a readable summary with per-item rationale and recommendations, (3) explicitly invite both open-ended feedback and structured answers or approval, (4) revise the artifacts and re-present them when the user responds, and (5) advance only after the user explicitly approves. Never infer approval from silence.

## Analysis and Decision Presentation

Before asking the user to decide anything, present a written analysis — do not jump straight to a list of options.

The analysis must include:

- A restatement of the idea and the scope you inferred, separating what is clear from what is unknown.
- Each assumption with its risk level and the reasoning behind it.
- For every `needs_user_decision`: the question, why it matters, each option with its concrete trade-offs, a recommended option with explicit rationale grounded in the stated goals, constraints, and any prior art, and which downstream artifacts or decisions it blocks.

Write this analysis into `intake.md` and summarize it in the conversation. Treat decision-making as a dialogue: invite the user to correct your understanding and give free-form feedback, not only to pick options. Do not collapse several distinct high-impact decisions into a single multi-select that hides their individual rationale; ask in small, clearly explained batches.

`intake.md` should follow this recommended soft template, mapping each narrative section to the matching `intake_json` field without changing JSON field names:

1. **Understanding** — restate the idea and inferred scope from `known_facts`, separating what is clear from what remains unknown.
2. **Assumptions** — cover `assumptions` using each item's `id`, `statement`, `risk`, reasoning, and `confirmation_needed`.
3. **Decisions** — cover `needs_user_decision` with the question, why it matters, options and concrete trade-offs, recommended option and rationale, downstream artifacts or decisions it blocks, and status.
4. **Clarifying questions** — cover `clarifying_questions` with each `id`, question, and current handling or default.
5. **Next** — state `status` and what is needed from the user.

This is a narrative-first recommended structure, not a blank form. Preserve the existing requirements for explanation, evidence, trade-off analysis, and recommendations. Tables may help scan the content, but they are supplemental and must not replace the written explanation. Render section headings and labels in the user's language when appropriate (for example Korean: `1. 이해`, `2. 가정`, `3. 결정`, `4. 소프트 질문`, `5. 다음`), while preserving the English JSON field names such as `assumptions` and the label meaning of **Assumptions/가정**; do not rename it to a different concept such as "proposal."

## Resume Rules

- When the user answers decisions such as `ND-1` or `ND-4`, merge the answers into `intake_json.needs_user_decision[*].answer`, set those decisions to `answered`, and recompute `intake_json.status`.
- Resume from the earliest stage whose input changed. For example, changed intake answers invalidate spec, implementation plan, task graph, and review.
- Carry forward stable artifact ids (`project_id`, `source_intake`, `sourceSpec`) so later stages can trace their source. Use the gate-folder paths for cross-artifact references, for example `artifacts/<project_id>/gate-a-intake/intake.json` for `source_intake` and `artifacts/<project_id>/gate-b-spec/spec.json` for `sourceSpec`.
- If an artifact is pasted in Markdown only, reconstruct the matching JSON contract before advancing to the next gate.

## State Passing Contract

Return intermediate artifacts in fenced code blocks named exactly:

- `intake_json`
- `product_spec_markdown`
- `implementation_plan_markdown`
- `spec_json`
- `task_graph_json`
- `review_report`
- `review_json`

`intake_json`, `spec_json`, `task_graph_json`, and `review_json` must conform to `schemas/intake.schema.json`, `schemas/spec.schema.json`, `schemas/task-graph.schema.json`, and `schemas/review.schema.json` respectively. `intake_json.evidence` and `spec_json.evidence` carry all user, local, and web sources used by the run.

## Artifact Persistence

In addition to the inline state sections, the harness orchestrator writes each artifact to a file so the user can open and review it before any gate. Use a stable `project_id` (kebab-case, derived from the idea or carried forward) and keep all files for one run under `artifacts/<project_id>/` using gate-specific folders:

- `status.md` — top-level standing progress status and decision index. Refresh it at every gate transition.
- `gate-a-intake/intake.json` — the `intake_json` artifact
- `gate-a-intake/intake.md` — the human-readable analysis and decision rationale described in Analysis and Decision Presentation
- `gate-b-spec/product-spec.md` — the `product_spec_markdown` artifact
- `gate-b-spec/implementation-plan.md` — the `implementation_plan_markdown` artifact
- `gate-b-spec/spec.json` — the `spec_json` artifact
- `gate-c-task-graph/task-graph.json` — the `task_graph_json` artifact
- `gate-d-review/review-report.md` — the `review_report` artifact
- `gate-d-review/review.json` — the `review_json` artifact

The orchestrator writes each stage's outputs into its matching `gate-*` folder before stopping at that gate, and tells the user the file paths. `status.md` remains directly under `artifacts/<project_id>/` because it is the standing cross-gate progress and decision index. Whenever the orchestrator writes any gate artifact, refresh `status.md` in the same turn; do not treat it as a Gate-A-only or optional file. Only the harness orchestrator writes files; subagents stay read-only and return their content for the orchestrator to persist. Continue to surface the inline named sections as well so resume and paste-in still work.

### `status.md` Standing Document

`status.md` should mirror the narrative-first pattern used by `intake.md`: it is a readable standing document, not a blank form. Preserve English JSON field names when referencing source fields, but render headings and labels in the user's language when appropriate (for example Korean: `1. 진행 상태`, `2. 게이트별`, `3. 열린 결정`, `4. 다음`, `5. 변경 이력`). Use this standard skeleton:

1. **Progress line** — show the current gate marker across `[A] → [B] → [C] → [D]`, indicating which gates are complete, current, blocked, or pending.
2. **Per-gate sections** — summarize each gate's latest state and point to the canonical artifact files for that gate.
3. **Open decisions / questions** — preserve the former cross-gate question-index content here, including unresolved decisions, answered decisions that affect downstream work, and follow-up questions.
4. **Next** — state exactly one next action needed from the user or orchestrator.
5. **Change log** — append dated bullets for each gate transition or decision/status update.

### Facts From Tools

Do not retype gate status facts from memory. Pull gate status, task counts, `ready` / `in_progress` state, approval state, and blocking counts from the artifacts and tools: `spec.json` (`approval`, `open_decisions`), `task-graph.json`, `p2a_tasks` (`list` / `ready`), `validate_artifacts`, and `review.json.blocking_issues`. If a fact cannot be derived from those sources, mark it as unknown or pending rather than inventing it.

## Evidence and Citation Contract

- Use `USER-n` for user-provided source material, `LOCAL-n` for repository/local artifacts, and `WEB-n` for web lookup sources.
- Every `WEB-n` evidence item must include an `https://` or `http://` URL, title, and short `used_for` rationale.
- If web lookup materially affects a question, assumption, product decision, or integration choice, include the source in `evidence` and refer to its `source_id` in nearby rationale text.
- Do not use web lookup for implementation execution; it is only allowed for read-only prior-art or domain grounding.

## Output Modes

- **Blocked intake:** Write `gate-a-intake/intake.json` and `gate-a-intake/intake.md`, refresh top-level `status.md`, present the analysis narrative and per-decision recommendations, invite feedback and answers, and stop at Gate A.
- **Draft spec:** Write `gate-b-spec/product-spec.md`, `gate-b-spec/implementation-plan.md`, and `gate-b-spec/spec.json` with `approval: draft`, refresh top-level `status.md`, present them for file-based review, and stop at Gate B before the task graph.
- **Approved planning output:** Write all artifact files, refresh top-level `status.md`, and return the state sections after gates pass.
- **Resume output:** Regenerate only the downstream artifact files and sections, refresh top-level `status.md`, plus a short changelog of which decisions were applied.

## Rules

- You MAY create or update Plan2Agent planning artifacts (`.md` / `.json`) under `artifacts/<project_id>/`.
- Do NOT edit application or source code, install dependencies, run shell commands for implementation, or perform git operations.
- Subagents remain strictly read-only; only the harness orchestrator persists artifact files.
- Refresh `status.md` in the same turn as every gate artifact write, using facts pulled from the artifacts and tools rather than memory.
- Do not claim that implementation happened.
- Mark unresolved decisions as `needs_user_decision`.
- Keep tasks small enough for one agent or developer to complete independently.
