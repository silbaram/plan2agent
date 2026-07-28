## Retrospective

After execution, perform a Hermes-style retrospective gate. Look for repeated mistakes, missing verification, reusable procedures, or unclear boundaries discovered during the run. Explicitly ask: did the user correct code style during this run?

If an improvement is warranted, write it as a skill-proposal schema object rather than freeform markdown and save it inside the project at `.plan2agent/proposals/<proposalId>.json`. If the user corrected code style, write a proposal with `target: "project"` and `targetFiles: [".plan2agent/style.md"]`; record concrete evidence describing what the user asked to change and how they wanted the style adjusted. The object must conform to `p2a` package schema `skill-proposal.schema.json` with `schema_version: "p2a.skill_proposal.v1"`, a stable non-empty `proposalId`, the source run id when available, concrete evidence, target canonical files, risk, and `status: "proposed"`.

Do not edit any skill, agent, planning artifact, CLI mirror, or other canonical file automatically as part of the retrospective. Leave only the proposal object for later review. A human or the read-only skill curator must review the proposal, and any approved patch must happen in a separate turn after human approval.
