## Starting From Existing Documents

Rich input documents make gates faster, not skippable. Classify document input before
the first gate:

When the entry has a sibling `p2a-reference-bundle.json`, validate the entry first and
treat the bundle as a conditional index: read its ids, kinds, hashes, descriptions, and
`load_when` values, and open a referenced file only when its condition is material to the
current decision. Record an inspected file as `LOCAL-n` evidence with its `REF-n` id and
hash in `used_for`; unselected references remain context, not evidence or approval.
Before requesting Gate A approval, run
`p2a reference snapshot --target <project-dir> --entry <path> --artifacts <artifact-root>`
and never hand-author its hashes; `p2a decide` with the same `--entry` binds that snapshot.
Gate B usage provenance follows the spec skill's `entry-reference-bundle.md`.

1. **General design or plan documents** (for example `DESIGN.md`, `PLAN.md`, or files
   under `docs/`) are `LOCAL-n` input evidence. Run the full pipeline from Gate A: use
   the documents to populate `known_facts`, reduce open questions, and cite them in
   rationale. Present the Gate A analysis and stop for approval even when no decision
   remains open.
2. **Prior Plan2Agent artifacts available only as Markdown** must be reconstructed into
   their JSON contracts first. Approval state still governs: a reconstructed spec
   without a recorded user `approval_audit` is `draft` and stops at Gate B.
3. **Canonical JSON artifacts with valid recorded approvals and source hashes** may
   resume past a gate in any CLI-supported artifact root, including
   `.plan2agent/artifacts/<project_id>/`, `artifacts/<project_id>/`, or an explicitly
   selected root. Directory names alone neither grant nor invalidate approval.
   Follow the action returned by `p2a next` after its contract validation; resume only
   up to the last valid recorded approval.
