# CE-009 Codex A/B preflight

These records are infrastructure preflight evidence, not quality repetitions.

- The first nested `codex exec` pair stopped before provider inference because the parent workspace sandbox denied in-process app-server initialization.
- An approved unsandboxed CLI boundary reached the provider and exposed two output-schema compatibility errors: `const`/`enum` properties needed explicit types, and `uniqueItems` was unsupported by the structured-output subset.
- The schema was corrected and a synthetic diagnostic completed with structured JSON and token usage.
- The first successful Direct pair exposed an ambiguous `serialIntegration` field: the candidate correctly chose Direct but treated single-owner sequential work as serial integration. The field is now explicitly batch-only, and that pair is retained as contract-calibration evidence rather than a quality repetition.
- The completed matrix showed that `executionMode` (`not_applicable` versus the existing `direct` run) and `ownerCount` (0 versus 1) were also non-semantic at visual closeout. The original contract and initial grades are preserved; reviewed grades allow both representations while keeping the close/evidence/Gate-return checks hard.
- Failed attempts remain preserved here and are excluded from the three repetitions per scenario.

No provider JSONL transcript, credential, secret, or repository document body is stored in this directory.
