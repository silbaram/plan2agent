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
| 5. Review | `p2a-review` | `p2a-quality-reviewer` | spec and task graph | `review_report` |

If the CLI cannot spawn subagents automatically, run the matching skill locally and preserve the same input/output contracts.

## Approval Gates

- **Gate A — Intake decisions:** If any `needs_user_decision.status` is `open` or `deferred`, stop after intake and ask only those decisions. Do not produce a product spec except as a clearly labeled sketch.
- **Gate B — Spec approval:** If `spec_json.approval` is not `approved` or `spec_json.open_decisions` is non-empty, stop before task graph generation.
- **Gate C — Task graph validation:** Before final output, check that every dependency references a task id, the graph is acyclic, and every task has acceptance criteria.
- **Gate D — Review blockers:** If review finds blocking issues, return the blockers and the artifact section that must be revised instead of claiming the plan is ready.

Each gate is a review checkpoint, not a one-shot hand-off. At every gate: (1) persist the stage's artifact files, (2) present a readable summary with per-item rationale and recommendations, (3) explicitly invite both open-ended feedback and structured answers or approval, (4) revise the artifacts and re-present them when the user responds, and (5) advance only after the user explicitly approves. Never infer approval from silence.

## Analysis and Decision Presentation

Before asking the user to decide anything, present a written analysis — do not jump straight to a list of options.

The analysis must include:

- A restatement of the idea and the scope you inferred, separating what is clear from what is unknown.
- Each assumption with its risk level and the reasoning behind it.
- For every `needs_user_decision`: the question, why it matters, each option with its concrete trade-offs, a recommended option with explicit rationale grounded in the stated goals, constraints, and any prior art, and which downstream artifacts or decisions it blocks.

Write this analysis into `intake.md` and summarize it in the conversation. Treat decision-making as a dialogue: invite the user to correct your understanding and give free-form feedback, not only to pick options. Do not collapse several distinct high-impact decisions into a single multi-select that hides their individual rationale; ask in small, clearly explained batches.

## Resume Rules

- When the user answers decisions such as `ND-1` or `ND-4`, merge the answers into `intake_json.needs_user_decision[*].answer`, set those decisions to `answered`, and recompute `intake_json.status`.
- Resume from the earliest stage whose input changed. For example, changed intake answers invalidate spec, implementation plan, task graph, and review.
- Carry forward stable artifact ids (`project_id`, `source_intake`, `sourceSpec`) so later stages can trace their source.
- If an artifact is pasted in Markdown only, reconstruct the matching JSON contract before advancing to the next gate.

## State Passing Contract

Return intermediate artifacts in fenced code blocks named exactly:

- `intake_json`
- `product_spec_markdown`
- `implementation_plan_markdown`
- `spec_json`
- `task_graph_json`
- `review_report`

`intake_json`, `spec_json`, and `task_graph_json` must conform to `schemas/intake.schema.json`, `schemas/spec.schema.json`, and `schemas/task-graph.schema.json` respectively. `intake_json.evidence` and `spec_json.evidence` carry all user, local, and web sources used by the run.

## Artifact Persistence

In addition to the inline state sections, the harness orchestrator writes each artifact to a file so the user can open and review it before any gate. Use a stable `project_id` (kebab-case, derived from the idea or carried forward) and keep all files for one run under `artifacts/<project_id>/`:

- `intake.json` — the `intake_json` artifact
- `intake.md` — the human-readable analysis and decision rationale described in Analysis and Decision Presentation
- `product-spec.md` — the `product_spec_markdown` artifact
- `implementation-plan.md` — the `implementation_plan_markdown` artifact
- `spec.json` — the `spec_json` artifact
- `task-graph.json` — the `task_graph_json` artifact
- `review-report.md` — the `review_report` artifact

Write the files for a stage before stopping at its gate, and tell the user the file paths. Only the harness orchestrator writes files; subagents stay read-only and return their content for the orchestrator to persist. Continue to surface the inline named sections as well so resume and paste-in still work.

## Evidence and Citation Contract

- Use `USER-n` for user-provided source material, `LOCAL-n` for repository/local artifacts, and `WEB-n` for web lookup sources.
- Every `WEB-n` evidence item must include an `https://` or `http://` URL, title, and short `used_for` rationale.
- If web lookup materially affects a question, assumption, product decision, or integration choice, include the source in `evidence` and refer to its `source_id` in nearby rationale text.
- Do not use web lookup for implementation execution; it is only allowed for read-only prior-art or domain grounding.

## Output Modes

- **Blocked intake:** Write `intake.json` and `intake.md`, present the analysis narrative and per-decision recommendations, invite feedback and answers, and stop at Gate A.
- **Draft spec:** Write `product-spec.md`, `implementation-plan.md`, and `spec.json` with `approval: draft`, present them for file-based review, and stop at Gate B before the task graph.
- **Approved planning output:** Write all artifact files and return the state sections after gates pass.
- **Resume output:** Regenerate only the downstream artifact files and sections, plus a short changelog of which decisions were applied.

## Rules

- You MAY create or update Plan2Agent planning artifacts (`.md` / `.json`) under `artifacts/<project_id>/`.
- Do NOT edit application or source code, install dependencies, run shell commands for implementation, or perform git operations.
- Subagents remain strictly read-only; only the harness orchestrator persists artifact files.
- Do not claim that implementation happened.
- Mark unresolved decisions as `needs_user_decision`.
- Keep tasks small enough for one agent or developer to complete independently.
