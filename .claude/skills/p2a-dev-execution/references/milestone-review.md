## Milestone Review Pass

A milestone review pass is a recommended lightweight, read-only review for catching cross-cutting defects during an iteration. It is informational only and must not block close readiness, task completion, or any done/block decision; apply the same non-blocking principle used for the style-rating pass.

### Checkpoint selection and duplicate prevention

Evaluate checkpoint eligibility after each successful `p2a execute finish` that marks a feature-iteration task done:

- `midpoint` is eligible when `done >= ceil(total / 2)` and `done < total`.
- `pre_close` is eligible when `done == total`, immediately before the user performs close-ready verification.
- Maintenance and explicit standalone graphs do not create feature-iteration milestone reviews.

Use exactly one stable path per iteration/checkpoint:

- `iterations/<iteration-id>/milestone-reviews/midpoint.json`
- `iterations/<iteration-id>/milestone-reviews/pre_close.json`

If the eligible checkpoint's file already exists, validate it with `validate_artifacts.mjs --milestone-review` and skip the pass. Never overwrite, append a dated duplicate, or silently repair an existing checkpoint file. If an existing file is invalid, report the invalid informational artifact and continue the task/close flow without treating it as a gate. If the midpoint window has already passed because all tasks are done, do not backfill it; evaluate only `pre_close`.

### Required context injection (맥락 주입)

Before invoking the reviewer, the main dev-execution owner must build one evidence envelope from a single task-graph snapshot and pass all of it to the reviewer:

- The full current iteration task graph, including every task status, preserved as `task_graph_snapshot`, plus a `task_snapshot` of each task's id/title/status, a task-count snapshot, the raw task-graph file `task_graph_sha256`, and the schema-defined deterministic `task_graph_snapshot_sha256`.
- The approved product and implementation spec and its reference.
- The complete approved `.plan2agent/constitution.json.style` contents and constitution reference when substantive; otherwise the complete legacy `.plan2agent/style.md` contents and reference when substantive; otherwise use `style_ref: null`.
- For every `done` task, evidence from its latest successful finished run: artifact-root-relative `run_ref` formed as `runs/<run-index entry runRef>` (normally `runs/<iteration_id>/<run_id>.json`, with legacy flat refs still readable), raw run-file `run_sha256`, the complete parsed `p2a.run.v1` object preserved as immutable `run_snapshot`, and deterministic `run_snapshot_sha256 = sha256(JSON.stringify(run_snapshot))`. Read task identity, run identity, finish time, workspace, changed files, and verification from `run_snapshot`.
- The ids of every remaining `todo`, `in_progress`, or `blocked` task.
- A clear instruction that only completed scope is under review, every suspected gap must be compared against remaining tasks before classification, and every `run_snapshot.changedFiles` path must be inspected in its run's `run_snapshot.workspaceRef` or immutable isolation worktree/branch before a difference in the current or main worktree is classified as a finding.

Each completed task must have a resolvable successful run whose raw file matches `run_sha256`, whose parsed object exactly matches `run_snapshot` and `run_snapshot_sha256` at draft validation time, and whose finish time matches `run_snapshot.finishedAt`. `run_snapshot.changedFiles` must be present (and may be empty), and `run_snapshot.verification` must include at least one executed `source: config|command` verification that passed with exit code 0. The reviewer must resolve the completed code from `run_snapshot.workspaceRef`; when that worktree is no longer present, it may use `run_snapshot.isolation.worktree` or inspect `run_snapshot.isolation.branch` with read-only git operations. If neither completed workspace nor branch is inspectable, treat the reviewer input as incomplete and do not create the canonical checkpoint file. The immutable snapshot keeps the checkpoint historically valid if a finished run later receives a legal `record` or `verify` evidence append; mutable current evidence must not rewrite the checkpoint snapshot. If any completed-task evidence is missing, do not invoke a partial review and do not create the canonical checkpoint file. Record the non-blocking skip reason in the current response or run notes and retry the still-eligible checkpoint after evidence is repaired.

Invoke `p2a-milestone-reviewer` as a separate read-only subagent when available, or perform an otherwise separated read-only review using the same contract. Split review perspectives across at most two instances when useful, then have the main owner deduplicate their results into one checkpoint artifact.

### Persistence and result handling

The main owner, not the reviewer, combines the immutable source envelope with the reviewer result and adds `schema_version: "p2a.milestone_review.v1"`, `project_id`, `iteration_id`, and `generated_at`. The complete object must match `p2a` package schema `milestone-review.schema.json`.

Write first to a unique draft in the checkpoint directory, using `iterations/<iteration-id>/milestone-reviews/<checkpoint>.<unique-id>.draft.json`. Never use one shared draft filename and never rename a draft into the stable path yourself. Promote through the iteration CLI, which validates the unique draft and then atomically claims the stable checkpoint path with a hard-link create that fails if another owner has already won:

```bash
p2a iteration promote-milestone \
  --artifacts <artifact-root> \
  --draft <artifact-root>/iterations/<iteration-id>/milestone-reviews/<checkpoint>.<unique-id>.draft.json
```

On success the CLI creates `<checkpoint>.json` atomically and removes the winning unique draft. If the stable path already exists, the CLI never overwrites it and leaves the losing draft untouched; validate the stable artifact before discarding that draft. Invalid drafts are not canonical and must not be promoted. This single promotion command replaces the non-atomic check-then-rename sequence.

Consume `confirmed_findings` as maintenance-task candidates only after checking the remaining feature tasks and existing maintenance graph again. Preserve `planned_todo_not_findings` in the JSON so planned work is not duplicated. When registering a confirmed finding, cite `milestone-review:iterations/<iteration-id>/milestone-reviews/<checkpoint>.json#<finding_id>` in maintenance `sourceSpecRefs`/`--ref` evidence. The milestone JSON is the stable informational source; do not create a competing Markdown source.
