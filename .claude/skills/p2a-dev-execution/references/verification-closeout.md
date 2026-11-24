# Verification and Closeout

Read this reference when the implementation outcome is ready for executable verification and run closeout.

Before discarding a task-owned temporary environment, move necessary logs, reproduction commands, and non-reproducible evidence into the run evidence directory described in `execution-lifecycle.md`; a supplementary report should still identify its target and result after run GC. Then remove only the exact temporary directories this task created and no longer needs, keeping resumable work and never sweeping `.plan2agent/tmp`, historical artifacts, or other owners' environments.

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

Only executed checks count as evidence, because close and every later claim depend on it: do not invent verification labels or use `source: manual`/`exitCode: null` as a substitute for execution. Every attempt is append-only. After a failure, correct code or the environment and rerun the same check in the same started run; the CLI selects the latest decisive result at the current revision, and earlier failures remain visible as history.

Classify a failure by what actually happened, because the class decides whether implementation reopens:

- Environment failure: a final verification or review command could not start (a child-process spawn error counts even when the runtime reports exit status zero). Preserve the unavailable evidence and run the exact `p2a execute retry --artifacts <root> --run-id <run-id>` recovery command; the implementation task remains done.
- Product failure: executed product behavior fails, or a validated visual or acceptance review blocks. This reopens implementation, must not be relabeled `environment_failure`, and takes precedence over unrelated unavailable command evidence.
- During a started implementation run, correct and reverify ordinary failures in that same run instead of reopening or creating a replacement run.

Shell composition must propagate every evidence-producing command's status. Avoid pipelines or command substitutions that can turn an unavailable command into a false pass. Preflight absolute executables with `test -x`, use a status-preserving wrapper, and inspect non-empty `stderrTail` before finish.

## Planned checkpoints

Verify declared milestones in order after their outcomes exist:

```bash
p2a runs checkpoint --run-id <id> --artifacts <dir> --milestone <milestone-id>
```

`p2a execute resume` reports the next pending checkpoint. A failed or unavailable attempt stays in evidence, but after correction the same milestone may be rerun in the same started run. The milestone becomes verified only when every declared command's latest current-revision attempt passes.

## Conditional reviews

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

For `failed` or `blocked`, pass the most specific `--failure-class` with the `--repro-*`, `--localization`, and `--guard` details you actually observed. The CLI checks which details that class requires and collects command errors and retry conditions from evidence; if it refuses, add exactly what its error names. Use `other` only when no specific class applies, and `test_flake` only when the same check passes without code or environment changes.

Iteration close needs current executed evidence for both the product revision and the workspace revision. The CLI tracks which obligation is satisfied, and `p2a next` returns the exact final verification command when one is missing. When it asks only for a relevant check after docs/metadata changes, run that command rather than the product-wide suite.

If a monitor blocks the run, finish with monitor-sourced structured failure evidence; do not mark the task done directly.

## Output

Return:

- implemented change summary;
- exact `changedFiles`;
- verification commands and outcomes;
- recommended status: `done`, `blocked`, or keep active;
- for batch work, ready snapshot, task/run/worktree mapping, harvest disposition, and canonical integration ref.

Read `closeout-choices.md` only when handling an optional product review, retrospective/report/issue request, or explicit iteration close.
