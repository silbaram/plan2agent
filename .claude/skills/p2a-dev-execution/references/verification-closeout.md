# Verification and Closeout

Read this reference when the implementation outcome is ready for executable verification and run closeout.

## Executed verification

Use configured or explicit commands and record their real exit codes. With no flags, the CLI runs only the test/lint/typecheck commands actually configured for the project:

```bash
p2a runs verify --run-id <id> --artifacts <dir>
```

For code work, completion requires a current pass from every configured test/lint/typecheck command even when low-level lifecycle commands are used. Docs/metadata work instead requires one current relevant executed check.

When config is empty and a real check is required, pass `--test-command`, `--lint-command`, or `--typecheck-command`. Supplemental checks use only `test`, `lint`, `typecheck`, or `custom`:

```bash
p2a runs verify --run-id <id> --artifacts <dir> \
  --verify-command 'custom:git diff --check'
```

Do not invent verification labels or use `source: manual`/`exitCode: null` as a substitute for execution. Every attempt is append-only. Correct code or the environment and rerun the same check in the same started run; its latest decisive result at the current revision controls completion while earlier failures remain visible. After the workspace revision changes, an older failed command remains history but is not a current obligation unless that command is still configured or fails again at the current revision.

When a final verification or review command could not start because of the execution environment, preserve its unavailable evidence and run the exact `p2a execute retry --artifacts <root> --run-id <run-id>` recovery command. It finishes the old final run as `environment_failure` and starts a replacement bound to the same task and canonical workspace. The implementation task remains done. Reopen implementation only when executed product behavior fails or the review finds a product defect.

A child-process spawn error is an environment failure even if the runtime reports exit status zero. An executed product failure in a final verification/review run reopens implementation and must not be relabeled `environment_failure`. During a started implementation run, correct and reverify ordinary failures in that same run instead of reopening or creating a replacement run.

A validated blocking visual or acceptance review is also a product failure and takes precedence over unrelated unavailable command evidence.

Shell composition must propagate every evidence-producing command's status. Avoid pipelines or command substitutions that can turn an unavailable command into a false pass. Preflight absolute executables with `test -x`, use a status-preserving wrapper, and inspect non-empty `stderrTail` before finish.

## Planned checkpoints

Verify declared milestones in order after their outcomes exist:

```bash
p2a runs checkpoint --run-id <id> --artifacts <dir> --milestone <milestone-id>
```

`p2a execute resume` reports the next pending checkpoint. A failed or unavailable attempt stays in evidence, but after correction the same milestone may be rerun in the same started run. The milestone becomes verified only when every declared command's latest current-revision attempt passes.

## Conditional reviews

- Optional closeout product review is read-only. Inspect the diff, code, tests, and current verification evidence; run targeted non-mutating diagnostics only when needed to investigate a finding, not a full suite merely because review was selected. Report findings without changing code or run state unless the user requested fixes. An explicit “review and fix” request already provides that authority. For an authorized correction in an open iteration, fill the returned `p2a execute remediate` placeholders with the owning completed task and concrete finding. The linked run preserves reviewed evidence and returns through normal verification; do not substitute maintenance. A clean review asks once to close instead of repeating the choice menu.
- For UI/mixed work or an envelope with `visualContract`, follow `visual-evidence.md`.
- For acceptance policy `on` with current-iteration behavior criteria, explicit opt-in, or an already-started acceptance run, follow `acceptance-review.md` after non-visual work is integrated. A valid current-iteration contract with no new behavior criteria skips this review, and a required visual contract replaces it.
- When the run was started with `--require-monitor`, follow `monitor-gate.md`. Ordinary runs do not load or invoke monitor protocol.

## Finish

Finish through the execution lifecycle and collect only attributable changes:

```bash
p2a execute finish --run-id <id> --artifacts <dir> \
  --status finished|failed|blocked --collect-git
```

Verification flags and explicit commands may be passed to `finish` instead of a separate verify call.

For `failed` or `blocked`, include a supported `--failure-class` and only that class's required detail. `verification_failed`, `scope_violation`, `implementation_incomplete`, and `other` require reproduction, localization, and a guard. `test_flake`, `missing_dependency`, and `environment_failure` require reproduction and a retry guard; command errors and retry conditions are collected automatically when evidence provides them. Supported classes are `verification_failed`, `test_flake`, `scope_violation`, `missing_dependency`, `environment_failure`, `implementation_incomplete`, and `other`. Use `other` only when no specific class applies. Use `test_flake` only when the same check passes without code or environment changes.

Iteration close evaluates two independent obligations. `product_full` is bound to the current product revision: isolated code may reuse a canonical implementation pass, while high-risk or multi-task/worktree integration requires a canonical final full run. `workspace_relevant` is bound to the current workspace revision. A full pass at that same workspace satisfies both; if only docs/metadata changes afterward, keep the product pass and run only `p2a execute verify-final --scope relevant --artifacts <dir>`. That relevant run must record an actually executed `scope: related` command. Use structured project `relatedVerification` when configured; otherwise P2A runs its packaged UTF-8/JSON/readability integrity check against the selected files. Any later product-file change invalidates the product pass and requires full verification again.

If a monitor blocks the run, finish with monitor-sourced structured failure evidence; do not mark the task done directly.

## Output

Return:

- implemented change summary;
- exact `changedFiles`;
- verification commands and outcomes;
- recommended status: `done`, `blocked`, or keep active;
- for batch work, ready snapshot, task/run/worktree mapping, harvest disposition, and canonical integration ref.

## Retrospective

Keep product review, P2A process retrospective, and iteration close separate. Retrospective is optional and skipping it never blocks close. After the final maintenance task, use the same policy with the report path printed by `p2a execute finish`; finishing maintenance needs no new close state.

Summarize detected signals or the user's observations. If neither exists, ask once about process friction; when they report none, create nothing. Distinguish product verification failures from P2A routing, delay, or unnecessary steps, and do not infer missing facts.

Match the requested outcome without repeating approval questions:

- “Summarize the retrospective”: report the observed issue, impact, and suggested improvement in the conversation.
- “Write the retrospective”: create one short report at the returned path with exactly four H2 sections: `Observed issue`, `User impact`, `Suggested improvement`, `Evidence`. Do not overwrite an existing report without an explicit update request or copy raw logs/private details.
- “Register the retrospective as a GitHub issue”: use the identified report, or write the same minimal report when summarizing the supplied observations is part of that request. Preview and publish directly through the existing commands below; no proposal mining, curation, or patch draft is required. The explicit issue request authorizes publication, not product changes.

```bash
p2a proposals issue-preview --retrospective <report-path>
p2a proposals publish-issue --retrospective <report-path> --yes
```

Run these commands from the target project with a project-relative `docs/retrospective/*.md` path, converting the returned report path if it is absolute. They target the public `silbaram/plan2agent` repository. Inspect the preview for private project details and respect validation or redaction blockers before publication. Report the created or existing issue URL; the CLI handles duplicate detection. A report request alone does not authorize publication. Use `proposals mine` only when the user specifically requests the separate local proposal workflow.

The user's explicit close choice authorizes the returned close command. Neither a clean review nor a retrospective authorizes closing the iteration.
