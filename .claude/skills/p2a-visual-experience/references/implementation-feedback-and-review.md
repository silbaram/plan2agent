# Implementation Feedback and Final Review

Read when an approved visual contract affects task authoring, implementation feedback, or iteration closeout.

## Feedback classification

Classify a visual correction by whether it changes what Gate B approved:

- `drift`: implementation does not follow the approved experience/prototype. Correct inside the open implementation run; no Gate B reapproval.
- `contract`: the approved visual direction itself changes. Return affected visual artifacts to draft, revise contract and candidate states, update all hashes, and obtain explicit Gate B reapproval before finish.

Never mask a contract change as drift; final visual review must block an inconsistent implementation.

## Task impact

When `validation.visual_review_required` is true, every task declares `workKind: ui | non_ui | mixed`. UI/mixed tasks contain lightweight `visualImpact.screenStates`; non-UI tasks omit it. Overlap is allowed because impact is routing metadata, not exclusive review ownership.

## Final review

Task runs correct drift but do not create visual-review evidence. After all visual implementation is integrated, one canonical `p2a execute review` run captures the application against the complete Gate B contract; follow the dev-execution `visual-evidence.md` reference for that run. Close-ready validation and portable handoff reject missing, stale, or changed final-review evidence.
