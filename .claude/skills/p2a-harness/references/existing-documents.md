## Starting From Existing Documents

Rich input documents make gates faster, not skippable. Classify document input before
the first gate:

1. **General design or plan documents** (for example `DESIGN.md`, `PLAN.md`, or files
   under `docs/`) are `LOCAL-n` input evidence. Run the full pipeline from Gate A: use
   the documents to populate `known_facts`, reduce open questions, and cite them in
   rationale. Present the Gate A analysis and stop for approval even when no decision
   remains open.
2. **Prior Plan2Agent artifacts available only as Markdown** must be reconstructed into
   their JSON contracts first. Approval state still governs: a reconstructed spec
   without a recorded user `approval_audit` is `draft` and stops at Gate B.
3. **Canonical artifacts under `.plan2agent/artifacts/<project_id>/` with recorded
   approvals** are the only input that justifies resuming past a gate, and only up to
   the last recorded approval.

