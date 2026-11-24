---
name: p2a-dev-execution
description: Use when preparing or owning an approved Plan2Agent execution objective through implementation, verification, correction, and recorded closeout.
---

# Plan2Agent Dev Execution

Own one approved Gate B execution objective through implementation and recorded closeout. The Gate-derived execution envelope is the contract; task prose is routing metadata. This skill may prepare the synthetic Direct/Planned compatibility work item, but it does not author product decisions or broaden scope.

## Preconditions

Start only when Gate B is approved and `open_decisions` is empty. For an existing Gate C graph, selected work must come from one valid `p2a tasks ready` snapshot and each work item must have acceptance criteria. With `--prepare-mode adaptive|direct|planned`, Gate C may be absent until preparation creates it.

The user's request to develop an approved iteration authorizes its ready implementation work. It does not authorize external writes, credentials, costs, deployment, irreversible actions, or a change to product meaning.

Use a single owner unless several independent ready items have separate owners and bounded parallelism materially helps. Mode selection is an implementation judgment, not a new product approval.

## Progressive reference routing

The canonical load conditions are recorded in `.agents/context-routes.json`. Read references only at their entry condition:

1. Required, on-demand; stages: gate-c, execution — `references/execution-lifecycle.md` — Gate C is absent and execution needs preparation, or a single-owner run is about to start or resume.
2. Required, on-demand; stages: execution — `references/provider-confinement.md` — A write-capable owner is about to start or resume implementation.
3. Required, on-demand; stages: execution, closeout — `references/verification-closeout.md` — The implementation outcome is ready for executable verification, checkpointing, or run closeout.
4. Required, conditional; stages: acceptance, closeout — `references/acceptance-review.md` — Acceptance review policy is on, explicitly opted in, or an acceptance run is already active, and no required visual contract replaces it.
5. Required, conditional; stages: execution; modes: orchestrated — `references/batch-execution.md` — Two or more independent ready tasks will run concurrently in isolated worktrees.
6. Required, conditional; stages: monitor, closeout — `references/monitor-gate.md` — The current run was started with --require-monitor.
7. Required, conditional; stages: visual, closeout — `references/visual-evidence.md` — The task is UI or mixed, or the approved execution envelope contains a visual contract.
8. Required, conditional; stages: closeout — `references/closeout-choices.md` — A closeout choice or an explicit review/retrospective/report/issue request is being handled.

## Direct/Planned runtime packet entry

For a structured Direct/Planned continuation, request `p2a context show` once and use the returned reference bodies instead of reopening packet-managed paths:

- `execution.prepare`: pass `--continuation execution.prepare`.
- `execution.owner-start`, `execution.visual-review`, or `execution.acceptance-review`: first require a successful `p2a.execution_result.v1` with `runStatus=started`, then pass its `runId` with the returned continuation id.
- During a started run, retry, verification/closeout, visual, acceptance, and monitor work may request `--phase <phase> --run-id <id>`; the owner still decides when implementation is ready for a read-only phase.

A packet supplies references, not approval, write, finish, deployment, credential, or external-cost authority. Orchestrated and batch execution use the reference routing above.

## Core procedure

1. Inspect the approved envelope and repository evidence. For adaptive preparation, use the preparation context and select Direct, Planned, or Orchestrated without requesting a new product approval.
2. Confirm the ready work item, inspect retry evidence when applicable, and preserve one run identity through start or resume.
3. Apply the resolved provider confinement plus any approved constitution; otherwise treat repository conventions as advisory guidance.
4. Implement the envelope objective inside the assigned workspace. Correct ordinary implementation, test, and UI drift autonomously.
5. Execute only configured or explicit verification. Planned runs also verify every checkpoint in order and may retry a failed checkpoint in the same run after correction.
6. Apply only the conditional visual, acceptance, or monitor path selected by policy and the approved contract.
7. Finish through `p2a execute finish`, preserving changed-file attribution and structured failure evidence.
8. For a closeout choice or review/retrospective/report/issue request, follow `references/closeout-choices.md`. Do not load it as part of ordinary implementation verification.

Return to Gate B instead of implementing only when satisfying the objective requires changing product meaning, acceptance, approved scope, or constitution. Handle external authority through `references/provider-confinement.md`, not product reapproval.

Keep Gate labels, run ids, hashes, artifact paths, and verification-profile ids internal unless the user asks for diagnostic detail. Ordinary retryable implementation failures should be corrected and rechecked without asking the user to operate the lifecycle.

## Lifecycle ownership

The foreground owner controls run start, verification, checkpoint, finish, task transition, integration, and lifecycle evidence. A spawned implementer performs scoped edits and local self-checks only. Review agents are independent and read-only unless their approved protocol explicitly writes a lifecycle sidecar through the foreground owner. For two or more independent ready tasks, follow `references/batch-execution.md`; if independent confinement, serial integration ownership, or a clean canonical integration branch is unavailable, fall back to the single-task procedure.

## Completion contract

Do not claim completion until real commands verify the required outcome and the lifecycle command records the result. Report implemented changes, exact changed files, command outcomes, and the recommended task state.
