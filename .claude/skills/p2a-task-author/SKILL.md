---
name: p2a-task-author
description: Use when authoring and validating a Gate C task graph draft from a Plan2Agent context bundle before canonical promotion.
---

# Plan2Agent Task Author

Author a reviewable Gate C draft from an approved active iteration. This skill proposes and validates a complete draft; only `promote-tasks` creates canonical `task-graph.json`.

## Preconditions and ownership

Use only when Gate B is approved, open decisions are empty, and Orchestrated execution actually benefits from a dependency/ownership graph.

The skill owner obtains context, authors or reviews the draft, persists it, and runs validation/promotion. Use the read-only `p2a-task-author` agent when independent authorship materially helps; it returns JSON and never owns persistence.

## Progressive reference routing

The canonical conditions live in `.agents/context-routes.json`.

1. Required, on-demand; stages: gate-c — `references/draft-contract.md` — A new Gate C task graph draft is about to be authored from validated task context.
2. Required, conditional; stages: gate-c — `references/replacement-and-promotion.md` — A canonical graph already exists, or a draft is ready for validation and promotion.

## Procedure

1. Run `p2a iteration context --artifacts <root>` and validate the returned `p2a.task_context.v2` bundle.
2. Inspect the effective spec, changed fields, code signals, active/maintenance task summaries, and relevant BuildLore-derived evidence selected by the spec.
3. Choose cohesive, independently verifiable work boundaries. Task count is not a quality target.
4. Author or obtain one complete `p2a.task_graph.v1` draft using the shared draft contract.
5. Persist only `iterations/<active_iteration>/gate-c-task-graph/task-graph.draft.json`.
6. Validate `gate-c-draft`; promote only validator-clean content.

## Principles

The graph only divides approved work for execution and recovery; it never decides what the product is.

- **Every task traces to the approved spec.** Back each task with actual effective-spec fields and concrete acceptance criteria. Work that would add product scope or change product meaning returns to a new feature iteration instead of becoming a task.
- **Tasks stay inside this iteration and do not repeat finished work.** Keep dependencies within the draft and check code signals and existing tasks for duplicates.
- **Intent explains; acceptance decides.** Add a one-sentence human `intent` in the approved product spec's primary language after the contract is complete; it never replaces acceptance criteria or validation evidence.
- **The CLI owns canonical state.** Change only the draft file; application code, dependencies, approval artifacts, and canonical graph bytes change through their own owners. The CLI refuses to replace a graph once execution history exists.

Return the draft path, validation outcome, promotion outcome when applicable, and any exact blocker.
