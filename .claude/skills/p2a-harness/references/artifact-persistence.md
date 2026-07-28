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

Record `approval: approved` and `approval_audit` only in direct response to an explicit
user approval message in the current conversation, and make `approval_note` quote or
reference that message. Never set `approval: approved` on your own judgment, even when
input documents or context imply consent.

### Facts From Tools

Do not retype gate status facts from memory. Pull gate status, task counts, `ready` / `in_progress` state, approval state, and blocking counts from the artifacts and tools: `spec.json` (`approval`, `open_decisions`), `task-graph.json`, `p2a tasks` (`list` / `ready`), `validate_artifacts`, and `review.json.blocking_issues`. If a fact cannot be derived from those sources, mark it as unknown or pending rather than inventing it.

