---
name: p2a-visual-experience
description: Use when a Plan2Agent Gate B spec has a visual interface and needs structured screen composition, offline HTML prototype candidates, and explicit visual approval.
---

# Plan2Agent Visual Experience

Define and approve the visual behavior of a screen-bearing product before UI tasks are authored. This is a conditional Gate B track, not a separate gate or frontend harness.

## Activation

Read `spec_json.visual_experience` and choose exactly one path:

- `none`: no visual artifact or review contract.
- `minimal`: use product flows, acceptance criteria, and existing conventions; no candidates.
- `reuse`: cite existing design-system references and create an experience artifact only for composition or exceptions needing approval.
- `full + deferred_iteration`: record deferral and keep visual design out of current tasks.
- `full + current_iteration`: read `references/full-visual-procedure.md`. Gate B remains draft until at least two candidates are compared and one direction is explicitly approved, unless constrained reuse justifies one.

## Ownership

Candidate authorship belongs to read-only `p2a-visual-designer`. The harness owner is the only writer and owns file persistence, hashes, schema validation, and verbatim approval evidence. If the agent is unavailable, preserve the same author/writer boundary locally.

## Progressive reference routing

The canonical conditions live in `.agents/context-routes.json`.

1. Required, conditional; stages: visual, gate-b — `references/full-visual-procedure.md` — The Gate B visual decision is full with current-iteration timing.
2. Required, conditional; stages: visual — `references/implementation-feedback-and-review.md` — An approved visual contract affects task authoring, implementation feedback, or final iteration review.

## Core contract

Screen composition and approval state are canonical structured JSON. Passive offline HTML/CSS candidates under `gate-b-spec/visual-design/` are the primary approval surface and are hash-bound to their manifests; static images may supplement HTML but cannot replace reachable states. Candidates use no external network, remote font/script, credentials, private data, or production API, and this track creates planning and prototype artifacts only, never application UI.

The user must explicitly select a candidate; silence is not approval. After approval, implementation mismatch is drift, while a changed approved direction is a contract change requiring Gate B reapproval. A later iteration may promote deferred full design to current work.

Return the selected design path, persisted artifacts and hashes when applicable, explicit approval status, and any task/final-review impact.
