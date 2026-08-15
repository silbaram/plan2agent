---
name: p2a-visual-experience
description: Use when a Plan2Agent Gate B spec has a visual interface and needs structured screen composition, offline HTML prototype candidates, and explicit visual approval.
---

# Plan2Agent Visual Experience

Define and approve how a screen-bearing product should look and behave before its UI implementation tasks are authored. This is a conditional track inside Gate B, not a separate gate or a separate frontend harness.

## Activation

Read `spec_json.visual_experience` and follow exactly one path:

- `has_visual_interface: false`, `design_scope: none`: no visual artifact or visual review contract.
- `design_scope: minimal`: specify usable structure through normal product flows, interfaces, acceptance criteria, and existing project conventions. Do not create visual candidates.
- `design_scope: reuse`: cite the existing design-system references. Create an experience artifact only when screen composition or exceptions need explicit approval.
- `design_scope: full`, `design_timing: deferred_iteration`: record the deferral and keep visual design out of the current task graph.
- `design_scope: full`, `design_timing: current_iteration`: run the full procedure below. Gate B cannot be approved until at least two HTML prototype candidates are compared and one candidate plus the visual experience are explicitly approved.

## Ownership

- Candidate authorship belongs to the read-only `p2a-visual-designer` subagent.
- The harness owner is the only writer. It persists files, computes SHA-256 values, validates artifacts, and records the user's candidate selection and approval.
- If a visual-design subagent is unavailable, the harness owner may produce the same bundle locally while preserving the approval boundary.

## Screen Composition Contract

For every screen, define:

- stable `SCREEN-n` id, name, and route when applicable;
- user goal and entry points;
- one primary action and any secondary actions;
- ordered information regions with purpose and priority;
- required states, including empty/loading/error/success states when applicable;
- when `design_scope: full` and `design_timing: current_iteration`, at least one explicitly named `content-stress-<case>` state for every screen with a text-bearing region. Across that screen's stress states, cover every applicable case from the realistically longest string, an empty value or one-character value, the maximum supported list length, and the longest expected locale string for multilingual products;
- success exit;
- responsive rules;
- accessibility requirements.

Define the cross-screen design system strategy, semantic token rules, component rules, required viewports, required states, and accessibility standard. Content-stress states are required approval surfaces, not optional fixture examples. Screen composition is settled by this structured contract; visual rendering is settled by the HTML candidates and explicit selection.

## Full Visual Procedure

1. Inspect the draft product and implementation spec plus existing local design tokens/components.
2. Ask only for high-impact missing visual direction: brand mood, density, reference products, must-reuse system, and explicit things to avoid. Recommend a default when possible.
3. Invoke `p2a-visual-designer` with the complete screen composition contract.
4. Produce two materially different passive offline HTML/CSS candidates by default. More candidates require a concrete reason; one candidate is allowed only for a constrained reuse direction. For every text-bearing screen, make the candidates materially different in how they handle at least one required content-stress state, such as one-line truncation in one candidate and two-line wrapping in another.
5. The harness owner writes each candidate under:

   ```text
   gate-b-spec/visual-design/VD-<n>/
     index.html
     styles.css
     state-error.html    # optional non-stress linked state document
     prototype.json
   ```

6. Keep each candidate self-contained, passive, and offline. Use fixture data, semantic HTML, local assets, local anchor navigation, and responsive CSS. Executable JavaScript, inline event handlers, `javascript:`/external navigation, application APIs, and remote services are forbidden. Every HTML file must declare this exact restrictive meta policy (directive order is irrelevant): `default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'`.
7. Put each required content-stress state in an anchor section inside the candidate's existing `index.html`; do not create a separate HTML file for it. Add the same descriptive `content-stress-<case>` state name to `experience-spec.json.screens[].states` and the candidate's `prototype.json.screen_states[].states`, give its section a matching stable `id="state-content-stress-<case>"`, link to it from the entrypoint, and map it in `state_artifacts` with `artifact_ref: "index.html#state-content-stress-<case>"`. The state must visibly exercise the applicable extreme content, not merely describe it.
8. The harness owner computes the SHA-256 of every exact candidate file and writes `prototype.json` conforming to `p2a.visual_prototype.v1`. Every HTML/CSS and local media/font dependency reachable from the entrypoint must be declared in the manifest with a matching media type and candidate-directory-relative path. Record per-screen state coverage in `screen_states`, and map every state to a candidate-directory-relative HTML file or fragment through `state_artifacts`. Each mapped state must be reachable from the entrypoint through passive local anchor navigation.
9. Write `gate-b-spec/experience-spec.json` conforming to `p2a.visual_experience.v1`, using the canonical `source_spec_ref: "spec.json"` and `visual-design/<candidate-id>/prototype.json` manifest references, with each exact manifest SHA-256 plus `approval: draft`.
10. Present links to the HTML entrypoints, the candidate summaries, and their trade-offs. Explicitly ask the user to choose the long-content treatment shown by the candidates along with selecting a candidate, requesting changes, or rejecting the direction. Never infer selection or approval from silence.
11. After explicit selection and approval, set only the selected prototype to `status: approved`, record its `approval_audit`, set the experience `selected_candidate`, `approval: approved`, and its `approval_audit`, then recompute the selected manifest hash in the experience if any approved file or manifest field changed.
12. Record the final experience SHA-256 in `spec_json.visual_experience.experience_spec_sha256` and include `gate-b-spec/experience-spec.json` in `spec_json.approval_audit.approved_artifacts`. Gate B approval covers the product/implementation spec and the selected visual direction together.

## Implementation Feedback Classification

During implementation, classify each user visual correction by asking: "Does this instruction differ from what Gate B approved?"

| Kind | Meaning | Required path |
| --- | --- | --- |
| `drift` | The implementation does not follow the approved experience spec or selected prototype. | Correct the implementation inside its open implementation run. Gate B reapproval is not required. |
| `contract` | The user is changing the approved visual direction itself. | Pause implementation closeout. Have the harness owner return the affected visual artifacts to draft/candidate status, revise `experience-spec.json` and the selected candidate's affected `index.html` state, update affected file hashes in `prototype.json`, recompute the prototype-manifest and experience-spec SHA-256 references, and obtain explicit Gate B reapproval before implementation continues to finish. |

Never treat a contract change as implementation drift. Doing so leaves the approved artifacts and application permanently inconsistent and must cause the final visual review to block.

## Task Impact and Iteration Review

When the approved current-iteration experience sets `validation.visual_review_required: true` (required for `full`, forbidden for `reuse`), classify every task explicitly with `workKind: ui | non_ui | mixed`. Every `ui` or `mixed` task must include only its lightweight `visualImpact`; a `non_ui` task must not include it:

```json
{
  "workKind": "ui",
  "visualImpact": {
    "screenStates": [{"screenId": "SCREEN-1", "states": ["ready", "error"]}]
  }
}
```

Scope each task to the screen/state cases it can affect. Overlap is allowed because task impact is routing metadata, not exclusive review ownership. Normal implementation runs finish only after functional verification and the repeated, unrecorded owner inspection loop described by `p2a-dev-execution`; the execution owner corrects implementation drift autonomously and does not ask the user for task-level visual approval. These runs do not carry visual-review evidence. When the approved Gate B experience requires final visual review, all integrated visual implementation is followed by one `p2a execute review --artifacts <artifact-root>` canonical `final_visual_review` run for the active iteration. `devExecution.reviewPasses.visual` controls only whether a separated independent reviewer is invoked (`on`, or an explicitly activated `opt_in`); it cannot disable the approved visual contract or owner evidence. The final run derives the complete approved screen/state/viewport/accessibility contract directly from Gate B, captures the actual application once, and seals the confirming sidecar bytes in `visualReviewEvidenceSha256`. Close-ready, run-directory validation, and portable handoff reject stale or changed final-review evidence.

## Boundaries

- This track creates planning/prototype artifacts only; it does not implement application UI.
- HTML is the primary approval surface. Static images may supplement it but cannot replace reachable HTML states.
- Prototype code belongs only under `gate-b-spec/visual-design/`; never place it in application source.
- No external network, third-party script, remote font, credential, private data, or production API call is allowed in a prototype.
- JSON remains canonical for contracts and approval state. Passive HTML/CSS and local media/font files are hash-bound review artifacts.
- A function-first iteration may use `minimal` or `full + deferred_iteration`; a later feature iteration may promote the visual scope to `full + current_iteration` and run this procedure.
