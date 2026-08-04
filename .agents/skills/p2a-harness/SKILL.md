---
name: p2a-harness
description: Use when turning a concise product document into a gated Plan2Agent scope, specification, validated task graph, and execution-ready iteration.
---

# Plan2Agent Harness

Turn an entry document into durable planning artifacts. The harness is a decision ledger: agents propose and validate artifacts, while humans approve product scope, the persistent project constitution, and the product/implementation specification.

## Inputs

Require a readable entry document supplied through `p2a next --entry <path>` or an equivalent explicit file reference. Do not initialize a new harness from chat text alone.

The entry document should identify the problem, intended users, desired outcome, important constraints, and any known exclusions. Missing detail may be recorded as an assumption or open decision; it must not trigger a separate conversational workflow.

On resume, inspect canonical artifacts first:

- `status.md`
- `.plan2agent/constitution.json`
- `current-spec.json`
- `iterations/<id>/iteration.json`
- `iterations/<id>/gate-a-intake/intake.json`
- `iterations/<id>/gate-b-spec/spec.json`
- `iterations/<id>/gate-c-task-graph/task-graph.json`

Continue from the earliest incomplete or invalid artifact. Never rebuild later artifacts over an unapproved earlier decision.

## Roles and stages

| Stage | Skill or agent | Input | Canonical result |
|---|---|---|---|
| Entry confirmation and scope | `p2a-harness` | entry document, optional baseline | `intake.json` (`p2a.intake.v1`) |
| Project shape (Gate ②) | `p2a-harness` | approved intake, repository evidence, legacy style | `.plan2agent/constitution.json` |
| Product and implementation specification | `p2a-spec` with `p2a-spec-author` and `p2a-implementation-planner` | approved intake, evidence, optional baseline | `spec.json` plus readable spec documents |
| Visual experience, when required | `p2a-visual-experience` | approved visual scope | experience spec, prototypes, visual approval evidence |
| Task decomposition | `p2a-task-author` or `p2a-task-breakdown` with `p2a-task-graph` | approved spec and planning memory | `task-graph.json` after `p2a validate` |

Development execution begins only after the canonical task graph validates. Milestone and final execution reviews remain execution evidence; they are not planning approval gates.

## Human approval gates

There are three human gates.

### Scope approval

Before specification work, present a concise understanding summary containing:

- problem and users;
- in-scope outcome and exclusions;
- assumptions and unresolved decisions;
- evidence or baseline used;
- a clear statement that approval authorizes specification work.

Persist the approved scope in `gate-a-intake/intake.json` with `status: "ready_for_spec"` and an `approval_audit`. The audit must identify the approver, date, approved artifact path, and approval note. Without that record, keep `status: "blocked_on_user"` and stop before Gate ②.

### Project-shape approval (Gate ②)

After Gate A and before a first Gate B specification, establish the project-wide constitution at `.plan2agent/constitution.json`. Keep this discussion compact: architecture, stack, prohibitions, and style should each express durable project constraints, not restate feature requirements. Inspect the repository and current authoritative technical sources before proposing a material stack choice.

Present one reviewable Gate ② proposal containing:

- up to 10 architecture rules, each with a stable `ARCH-n` id, scope, rationale, and the practical trade-off it creates;
- up to 10 stack choices, each with a stable `STACK-n` id, rationale, and evidence ids for any current external choice;
- up to 10 prohibitions, each with a stable `NO-n` id, rationale, and enforcement level;
- the project coding-style contract, importing a substantive legacy `.plan2agent/style.md` into `style.contract_markdown` when present.

Use `advisory` when a prohibition omits `enforcement`. Use `review` for judgment-based constraints. Use `validator` only when the prohibition also declares `targets` (`spec` and/or `task_graph`) and concrete `forbidden_terms`; positive selections or introduction work containing those terms are mechanically rejected by `p2a validate`, while declarative negated constraints and removal work remain valid. Do not label an unenforceable natural-language preference as validator-enforced.

Explain the important alternatives and trade-offs, then ask the user to approve the complete constitution. First write a schema-valid draft without `approval_audit` and run:

```bash
p2a validate --constitution .plan2agent/constitution.json
```

Approval must preserve the user's verbatim utterance. After explicit approval, run:

```bash
p2a shape approve --quote "<exact user utterance>"
```

Never fabricate, summarize, or omit the quote. `p2a shape approve` writes the user/date/artifact audit and rejects a missing quote. Confirm the approved result with `p2a validate --constitution .plan2agent/constitution.json --require-approved-constitution` before Gate B.

An approved constitution is project-level state, not iteration state. Reuse it across later iterations. Reopen Gate ② only when the newly approved Gate A scope materially changes architecture, foundational stack, a project-wide prohibition, or coding-style policy. A normal feature or maintenance iteration must not re-ask for shape approval. To amend it, present a focused diff and trade-offs, replace it with a draft that omits the old `approval_audit`, and require a new quoted approval before Gate B.

Legacy projects may continue with `.plan2agent/style.md` and no constitution. Do not block their existing Gate B or execution path. Offer `p2a shape migrate-style` as an explicit migration that creates an unapproved draft; migration is optional and never implies approval.

### Specification approval

Before task decomposition, present the complete product specification and implementation plan together. Highlight consequential choices, trade-offs, open decisions, selected or rejected external recommendations, and verification strategy.

Persist approval in `gate-b-spec/spec.json`. An approved spec must have `approval: "approved"`, no open decisions, and a valid `approval_audit`. Visual work that is required for the current iteration must also have explicit selected-prototype approval before decomposition.

Task decomposition has no separate human approval state. The authoring agent writes a complete draft, `p2a validate` checks its schema, source references, dependencies, acyclicity, acceptance criteria, and execution contracts, and only a valid graph becomes canonical.

## Entry Document Confirmation Dialogue

Use this only when `p2a next` reports `gate_what` with a validated `--entry` document and no canonical planning artifacts. If the document and canonical planning artifacts coexist, compare the document metadata with recorded evidence and resume the earliest affected stage instead of restarting.

1. Run `p2a validate --entry <path>`, read the entire primary document, and preserve its relative path, SHA-256, type, size, and preview in the command context. For a Feature Radar document, also inspect the sibling `handoff-manifest.md` for provenance.
2. Present one compact interpretation of what will be built, who it serves, the intended outcome, included and excluded scope, hard constraints, material assumptions, and any conflict with an existing baseline. The entry file is evidence, not the control plane; do not dump or rewrite it.
3. Ask only for information or decisions that cannot be inferred safely and would materially change the scope. There is no fixed question count or conversation-turn limit. Stop asking as soon as the scope is confirmable, and do not introduce a replacement workflow state machine, mandatory identifier inventory, or progress counter.
4. Present the revised scope and explicitly ask the user to confirm that interpretation. Corrections update the summary and repeat this confirmation step. Silence, document presence, or a broad request to develop is not approval.
5. When Feature Radar supplied recommendations, list every promoted candidate with exactly one `selected`, `rejected`, or `deferred` disposition and a short rationale. Those candidates remain unapproved until the user confirms the scope containing their dispositions.
6. After explicit confirmation, persist `intake.json` with the entry evidence, confirmed scope, `status: "ready_for_spec"`, and Gate A `approval_audit`. Then establish or reuse Gate ② before continuing through the normal Gate B contract.

If the user rejects the source document, stop and request a different path. Canonical state begins with the approved intake artifact, not with chat history or the source file alone.

## Scope artifact contract

`intake.json` records:

- `idea` and `summary` derived from the confirmed document;
- stable known facts and explicit assumptions;
- optional clarifying questions and user decisions when they are genuinely needed;
- `baseline_context` when an existing approved specification is reused;
- `evidence`, including the entry document and any tool-derived facts;
- `status` and, when ready, `approval_audit`.

Question IDs and decision IDs are allowed for traceability but are not mandatory workflow states. A blocked intake may have no structured questions when the blocker is simply missing confirmation or a replacement document.

Existing intake files may contain legacy fields. Preserve them when reading or copying historical artifacts, but do not generate, interpret, or route workflow state from them.

## Technology boundary

Gate A concerns product scope. Do not force architecture, framework, storage, provider, API shape, or package choices into scope approval unless the user explicitly supplied them as constraints.

Gate ② owns durable architecture, foundational stack, prohibitions, and style. Gate B owns iteration-specific implementation choices within that approved constitution. For a material technology choice not already fixed by the constitution:

1. inspect the repository and applicable official documentation;
2. compare viable options and constraints;
3. state the selected option and trade-offs;
4. cite current authoritative evidence in `spec.evidence`;
5. leave a truly consequential unresolved choice in `open_decisions` and do not approve the spec.

## Planning memory

Planning memory is advisory context, never an approval substitute.

- Read the active iteration's `planning_memory` before specification and task decomposition.
- Reuse only reports whose project, scope, and evidence remain relevant.
- Record the actual query, requested/effective mode, fallback, and report reference when memory affects an artifact.
- Cite consumed local reports as `LOCAL-n` evidence.
- If prior failure evidence changes a task boundary, dependency, acceptance criterion, or mitigation, include a `memory:<reference>` source ref alongside a real specification field.
- Disabled, unavailable, empty, or irrelevant memory is not a blocker. A false claim of memory use or an ignored material prior failure is.

## Existing documents and baselines

When the entry points to an existing PRD, design, implementation plan, or approved Plan2Agent artifact:

- use it as evidence and preserve its locator;
- distinguish facts in the document from new assumptions;
- validate any reused canonical baseline and its hash;
- preserve unresolved decisions rather than silently filling them;
- avoid duplicating an approved iteration merely to change prose.

For delta work, keep baseline provenance in `baseline_context` and in the current-spec source composition. The new spec must be complete enough to execute and validate even when it references a baseline.

## State passing

Pass explicit JSON between stages. Do not rely on hidden conversational state.

Minimum handoff information:

- project and iteration identifiers;
- approved constitution contents and `.plan2agent/constitution.json` reference, or explicit legacy-style fallback;
- artifact root and canonical relative paths;
- entry evidence and approved intake;
- active or baseline spec references and hashes;
- approval audits for scope and specification;
- planning memory status and references;
- visual contract when applicable.

Downstream stages must validate incoming files before using them. If a referenced file is missing, outside the artifact root, stale, or inconsistent with its recorded hash, stop at that stage and report the exact contract failure.

## Artifact persistence

Persist canonical artifacts before claiming a stage is complete. Chat summaries are not durable state.

Use these locations:

```text
.plan2agent/constitution.json
<artifact-root>/
├── status.md
├── current-spec.json
├── iterations/
│   └── <iteration-id>/
│       ├── iteration.json
│       ├── gate-a-intake/
│       │   ├── intake.json
│       │   └── intake.md
│       ├── gate-b-spec/
│       │   ├── spec.json
│       │   ├── product-spec.md
│       │   └── implementation-plan.md
│       └── gate-c-task-graph/
│           ├── task-graph.json
│           └── task-graph.md
└── runs/
```

Write atomically where supported. Validate JSON immediately after writing. Do not promote a draft by merely renaming an unvalidated file. Preserve run lineage and task history when replacing a graph; if execution has started, open a new iteration or use the maintenance lane.

For a greenfield co-located project, generate the approved scope, approved spec, and validated task graph, then run `p2a iteration init` to create the iterative layout. Do not point project configuration at a transient root-level task graph.

## Generated status view

`status.md` is a readable projection, not canonical state. Generate it from current artifacts and keep it valid for `p2a validate --status`.

It should show:

- a literal `Progress:` line;
- active iteration and current next action;
- Scope, Project Shape, and Specification approval states;
- Planning Validation state;
- numbered sections for understanding, decisions, specification, tasks, and execution readiness.

Do not infer approval from prose in `status.md`. Approval comes from canonical JSON audit records.

## Evidence and citations

Use stable source IDs:

- `USER-n` for user-provided documents or decisions;
- `LOCAL-n` for repository files, commands, or planning-memory reports;
- `WEB-n` for current web evidence.

Every evidence item must say what it was used for. Web evidence requires an HTTP(S) URL. Repository facts should include a path or command in the title or locator. Never cite a source that was not actually inspected.

Feature Radar output is candidate evidence. Gate A records the user's scope disposition for every promoted candidate; Gate B may refine implementation choices but must not silently change that approved scope before task generation.

## Output modes

During an approval request, return a compact readable summary and the exact decision requested. Do not bury the approval question inside raw JSON.

After a stage completes, report:

- the resulting state;
- files written or validated;
- approval that was recorded, if any;
- the single next command or skill.

When blocked, report the earliest failed contract and the smallest user action that unblocks it. Do not continue into later stages.

## Validation

Use repository commands as the source of truth:

```bash
p2a next --entry <document>
p2a shape
p2a validate --constitution .plan2agent/constitution.json --require-approved-constitution
p2a validate --artifact-root <artifact-root>
p2a iteration validate --artifacts <artifact-root>
```

Before handing off to execution, ensure:

- the entry document was confirmed and recorded;
- Gate ② is approved for a new project, or a legacy style-only project is intentionally continuing under compatibility;
- validator-enforced constitution prohibitions pass against the spec and task graph;
- scope and specification approvals are present and match their artifacts;
- required visual approval evidence is valid;
- the canonical task graph references the approved spec;
- every task has valid dependencies, source refs, acceptance criteria, and verification commands;
- no planning artifact depends on a removed approval stage.

## Rules

- Never initialize a fresh harness without a document.
- Never infer user approval from silence or from an agent's recommendation.
- Never advance past blocked scope or an unapproved specification.
- Never create a first Gate B specification before a required Gate ② constitution is approved.
- Reuse an approved constitution across iterations unless Gate A introduces an architecture-level change.
- Keep implementation choices out of scope approval unless explicitly constrained by the user.
- Do not create a replacement workflow state machine around questions, rounds, or agent reviews.
- Treat validators as enforcement, not as authors of product decisions.
- Preserve canonical paths, hashes, approval quotes, and run evidence.
- Prefer one state-based next action over a menu of possible actions.
