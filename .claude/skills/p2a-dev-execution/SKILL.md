---
name: p2a-dev-execution
description: Use when preparing or owning an approved Plan2Agent execution objective through implementation, verification, correction, and recorded closeout.
---

# Plan2Agent Dev Execution

Own the approved Gate B execution objective through repository investigation, implementation, verification, correction, and closeout. The Gate-derived execution envelope is the implementation contract; task prose is only routing metadata. With `--prepare-mode`, this skill may invoke the canonical CLI to create the single synthetic compatibility work item for direct or planned execution. It does not hand-author planning artifacts, change gates, or broaden approved scope.

## When to use

Use this skill only when all of these conditions are true before implementation starts:

- The Gate B spec is approved and `open_decisions` is empty.
- The user has asked to develop or resume the approved iteration. Do not request separate approval for each ready task in that iteration.

For an existing Gate C graph, every selected task must be exposed by the same `p2a tasks ready` snapshot, the graph must pass validation, and every selected task must have acceptance criteria. For `--prepare-mode adaptive|direct|planned`, the graph may be absent; follow Adaptive execution preparation below before applying those task conditions.

If any condition is missing, stop and report the missing prerequisite instead of implementing.

Use single-task mode unless several ready items have separate owners and a bounded batch has clear parallel value. Mode selection is an implementation decision inside the approved contract, not another product approval gate.

## Inputs

Use these inputs:

- Artifact root, or `--graph` when operating from an explicit task graph.
- One ready task id, or an exact list selected from one ready snapshot.
- `agent-tool`, usually `codex`.
- Optional existing run id per task.
- Optional `--prepare-mode adaptive|direct|planned` from `p2a next` when approved Gate B has no Gate C graph.
- Optional maximum batch concurrency, capped by the foreground provider's available write-capable subagent slots.
- For batch mode, a user-approved canonical integration branch/worktree, an owner-only per-task integration-candidate worktree/branch strategy, and its committed base ref.


## Provider Confinement Policy

Codex write-capable runs use native `workspace-write` sandbox confinement inside the assigned run workspace or isolated worktree. Claude write-capable runs may continue autonomously inside scaffold confinement only when deny rules, the PreToolUse hook, and the supported macOS/Linux OS sandbox are active. The approved Gate B envelope authorizes in-scope implementation and verification retries; external writes, new credentials, costs, deployment, or irreversible actions still require user authorization. Gemini remains read-only; hand write execution to a confined Codex or Claude owner. For every provider, writes remain limited to the assigned workspace/worktree, and harness files or paths outside that workspace are forbidden. Prefer repository and approved-source evidence; use live web research only when version-sensitive external facts are necessary and the current authority permits network reads.

Batch mode must use one write-capable provider and independently confined workspaces. Do not mix providers in one write batch. When independent confinement is unavailable, fall back to the single-task procedure.

## Procedure

### Adaptive execution preparation

When invoked with `--prepare-mode` and Gate C is absent, inspect the approved Gate B envelope, repository topology, existing verification commands, external boundaries, and likely recovery surface. Select the mode yourself; this selection is an implementation decision and must not be presented as a new user approval menu.

- `direct`: one owner, localized change, low implementation uncertainty, no risky external side effect, and one bounded verification cycle.
- `planned`: one owner but multiple ordered outcomes benefit from 2–5 resume-safe checkpoints, each with at least one executable verification command.
- `orchestrated`: independent owners, meaningful parallelism, high coordination or isolation needs, or a dependency graph materially improves recovery.

`--prepare-mode direct|planned` fixes the permitted mode. `--prepare-mode adaptive` allows all three. Record a concise evidence-based rationale. For direct execution run:

```bash
p2a execute prepare --artifacts <dir> --mode direct --selection-rationale '<why one bounded work item is sufficient>'
```

For planned execution, declare 2–5 ordered checkpoints:

```bash
p2a execute prepare --artifacts <dir> --mode planned --selection-rationale '<why ordered checkpoints improve recovery>' \
  --milestone 'milestone-1|<observable outcome>|<executable verification command>' \
  --milestone 'milestone-2|<observable outcome>|<executable verification command>'
```

Use stable milestone ids, observable outcomes, and commands that can actually run in the target workspace. The CLI writes one synthetic compatibility work item and validates Gate C readiness; do not request separate Gate C UI approval. If adaptive inspection selects `orchestrated`, invoke `p2a-task-breakdown` and continue from its validated graph. After preparation, immediately continue with step 1.

1. Confirm the target task is ready and inspect its implementation context:

   ```bash
   p2a tasks ready --artifacts <dir>
   ```

   Read the printed Gate-derived execution envelope first. Treat its source hash, objective, scope, `mustPreserve`, non-goals, acceptance, verification, authority, and visual contract as canonical. Use the current task only as a compatible work-item boundary and remediation pointer.

   If this is a retry after the same task's latest run ended `failed` or `blocked`, inspect that run's failure class and localization before starting the new run. When Memory is configured, run one same-project hybrid search using the task title, failure class, and localization, filter to relevant run history when useful, and save the report beside the failed run as `<failed-run-id>.memory-recall.json`. Do not query Memory for a normal first attempt.

   Use a retrieved failure only when it is materially similar. After starting the retry, add one run note in the form `MEMORY_RETRY: sourceRun=<id>; report=<path>; applied=<mitigation or none>; status=<succeeded|fallback|failed|skipped>`. If retrieval falls back or fails, preserve that status and continue unless the user explicitly requires Memory history; never claim that no similar failure exists.

2. Start a run unless the user provided an existing run id. Let `p2a execute` honor `runTracking.defaultIsolation`; the default `none` keeps a Direct owner in the already assigned, sandbox-confined workspace:

   ```bash
   p2a execute start --artifacts <dir> --task <id> --agent-tool codex
   ```

   Preserve one run identity across start retries. An explicit `--run-id` always wins. When `project.config.json.runTracking.runIdStrategy` is `task-sequence`, omit `--run-id` on the first start so the CLI atomically reserves the next id from `runIdPattern`; if isolation setup fails, correct the cause and use the printed retry command with that same explicit id. Do not invoke a fresh implicit start after failure because it intentionally allocates the next attempt id. Projects that keep the default `timestamp` strategy retain timestamp-based ids.

   Use `p2a execute start`, not raw `p2a runs start`, because it creates the run and marks the task `in_progress` in one lifecycle step. Read `devExecution.reviewPasses.monitor` from `.plan2agent/project.config.json` first. Its default is `opt_in`: pass `--require-monitor` only when the task explicitly requires independent monitor evidence. When it is `off`, do not opt the run into monitor evidence.

   Require an isolated worktree only for concurrent write owners, batch execution, an explicit project policy, or a concrete rollback/isolation risk. In that case use `--isolation worktree --worktree <fresh-worktree-path> --create-isolation`; the path must be fresh and follow `runTracking.worktreePattern`. Let the CLI create it from an existing git workspace rather than pre-creating it manually.

   Follow the Provider Confinement Policy in this skill for Codex, Claude, and Gemini execution modes.

3. Before implementing, inspect the source baseline and preserve unrelated user changes. Do not force a commit merely to start Direct execution. If pre-existing untracked application files make `--collect-git` ambiguous, record the pre-run inventory and pass the exact task-owned `--changed-file` values at finish instead of attributing the whole untracked tree to the task.

4. Before implementing, check whether the target project contains `.plan2agent/constitution.json`. When present, validate and read the complete approved constitution. Validator-enforced prohibitions are hard constraints; review and advisory prohibitions remain explicit implementation guidance. If no constitution exists, fall back to `.plan2agent/style.md` for legacy projects without requiring migration. The current owner implements Direct and ordinary single-owner Planned work itself. Spawn `p2a-implementer` only when an independently confined owner materially helps an Orchestrated/batch task or an explicit context-isolation need; pass the constitution and envelope only in that case.

5. Own the envelope objective while obeying the writing boundaries below, the approved project constitution or legacy style fallback when present, and the Provider Confinement Policy in this skill. Investigate the repository, choose files and internal structure, implement, run local checks, and correct ordinary implementation/test/UI drift without asking the user to choose implementation details. Return to Gate B only when satisfying the objective requires changing product meaning, acceptance, approved scope, constitution, or an external authorization boundary.

   A spawned `p2a-implementer` performs scoped file edits only. It may run local checks for self-review, but it must not call `p2a runs verify`, `p2a runs finish`, or `p2a tasks done|block`; lifecycle steps remain with this skill's owner.

6. Verify the run with the required checks by actually executing configured or explicitly requested commands. You may verify before finish:

   ```bash
   p2a runs verify --run-id <id> --artifacts <dir> --test --lint --typecheck
   ```

   `p2a runs verify` must execute the configured or explicitly requested verification commands and capture their exit codes as `source: config` or `source: command`. Do not self-report verification with a manual record; do not use `source: manual` or `exitCode: null` as a substitute for executed verification.

   If the user provides explicit verification commands, pass them through as explicit commands such as `--test-command`, `--lint-command`, or `--typecheck-command`. Config-only verification flags such as `--test`, `--lint`, and `--typecheck` auto-detect project commands when config is empty, then skip only if no command can be detected. Use explicit commands whenever config is empty and real verification is required.

   For supplemental `--verify-command` checks, use only the supported verification types `test`, `lint`, `typecheck`, and `custom`. Record checks outside the three primary types with the `custom:<command>` form:

   ```bash
   p2a runs verify --run-id <id> --artifacts <dir> --verify-command 'custom:git diff --check'
   ```

   Do not invent labels such as `format:`, `repeatability:`, or `dependency-policy:` as metadata. An unrecognized prefix remains part of the executable command, so `format:npm run format:check` attempts to execute that full string as a custom command. A failed or unavailable verification record is immutable evidence; correct the syntax and start a new retry run instead of rewriting the original record.

   For planned execution, verify each declared checkpoint in order after its outcome is implemented:

   ```bash
   p2a runs checkpoint --run-id <id> --artifacts <dir> --milestone <milestone-id>
   ```

   `p2a execute resume` prints the next pending checkpoint. Finish is blocked until every checkpoint is verified. A failed or unavailable checkpoint is immutable evidence: do not rerun that milestone in the same run. Finish the run as failed or blocked, then start a new retry run. Resume reports this recovery requirement instead of advertising the failed milestone as the next checkpoint. These are recovery markers inside the already approved execution objective, not user approval gates.

   Resume, verification, and checkpoint commands revalidate the run's recorded task contract and Gate B execution envelope before producing new evidence. If the Gate B/Gate C source changed or disappeared, do not continue that run. Restore an accidentally changed source, or close the stale run with structured failed/blocked evidence before approving the changed contract and starting replacement work. `p2a next` reports this state as `started_run_contract_drift` instead of returning a resume command that cannot succeed.

   Verification shell composition must preserve failures from every command that provides evidence. Do not use `test -z "$(command)"` directly: if `command` cannot execute, the substitution can become an empty string and the outer `test` can still exit zero. Capture the output only after propagating the producer's status:

   ```bash
   p2a runs verify --run-id <id> --artifacts <dir> --verify-command "custom:sh -c 'output=\$(gofmt -l <files>) || exit \$?; test -z \"\$output\"'"
   ```

   Preflight an absolute executable path with `test -x <path>` before using it. Avoid pipelines that can hide an earlier command failure behind the last process's exit code; use an explicit status-preserving wrapper or a project script with strict pipeline handling. Before finish, audit executed verification entries for non-empty `stderrTail` or evidence that a required executable did not run, even when an outer shell command returned zero. The runtime classifies POSIX shell executable-resolution errors as `unavailable`, including errors hidden inside compound commands.

6a. If the task is `ui`/`mixed` or the envelope contains `visualContract`, read `references/visual-evidence.md` and follow it. Do not load that reference for non-visual work.

6b. Read `devExecution.reviewPasses.acceptance`, defaulting to `opt_in`. For `on`, read `references/acceptance-review.md` after all non-visual iteration work is integrated. For `opt_in`, read it only when the user or approved contract explicitly requested an independent acceptance pass, or when resuming an already-started acceptance run. For `off`, or when a required visual contract exists, do not load it. Starting `p2a execute accept` is the opt-in signal; once started, its evidence must finish validly before close.

7. Read `devExecution.reviewPasses.monitor`, defaulting to `opt_in`. Load `references/monitor-gate.md` only when the current run was started with `--require-monitor`. Do not invoke a monitor or load its protocol for an ordinary run.

8. Finish the run through `p2a execute`, collecting git state and letting the CLI mark the task done or blocked:

   ```bash
   p2a execute finish --run-id <id> --artifacts <dir> --status finished|failed|blocked --collect-git
   ```

   You can also pass `--test`, `--lint`, `--typecheck`, or explicit `--*-command` flags to this finish command instead of running step 6 separately.

   When finishing with `--status failed` or `--status blocked`, include `--failure-class <class>` and structured debug detail: at least one `--repro-step` or `--repro-command`, at least one `--localization` or `--localized-file`, and at least one `--guard` or `--guard-note`. The supported classes are `verification_failed`, `test_flake`, `scope_violation`, `missing_dependency`, `environment_failure`, `implementation_incomplete`, and `other`. The CLI fills `retryable`, `needsUserDecision`, and `source` from the class defaults; use `--retryable`, `--needs-user-decision`, or `--failure-source` only when the default is wrong. Use `--failure-class other` only as an escape hatch and always include at least one `--note` explaining why no more specific class applies.

   Only classify a failure as `test_flake` when there is concrete evidence such as a failing verification command passing on rerun without code or environment changes. Without that evidence, use `verification_failed` for verification failures.

   If the monitor verdict blocks the run, do not call `p2a tasks done`. Finish through `p2a execute finish` with monitor-sourced failure metadata and structured detail. The CLI maps `unmet_acceptance` to `implementation_incomplete`, `verification_concerns` to `verification_failed`, `rule_concerns` and `scope_concerns` to `scope_violation`, and `needs_user_decision` to `missing_dependency`.

9. Apply the conditional retrospective described below. Style is already part of the optional monitor rule contract; do not invoke a separate style or milestone reviewer for new runs. Historical sidecars remain readable but are not produced by this workflow.

## Supervised Batch Owner Procedure

Read this procedure only when running two or more independent ready tasks in parallel.
If executing a single task, do not read it.

When parallel execution is confirmed, read `references/batch-execution.md`.

## Writing boundaries and prohibitions

- Implement only inside the approved target product workspace. In an application target, do not modify installed Plan2Agent harness/integration files. When the approved product target is the Plan2Agent repository itself, canonical `.agents/`, scripts, schemas, tests, and docs are in-scope product files; generated provider mirrors must still be produced from their canonical source.
- Limit implementation writes to the run `workspaceRef` or worktree. In supervised batch mode, the main dev-execution owner may also create task-scoped local commits or patches and write to the approved canonical integration worktree plus the owner-only integration-candidate worktree created from its latest head. The main owner may write only lifecycle artifacts activated by the current run contract: retry Memory reports and notes, required monitor verdicts, visual evidence, or acceptance reviews. Retrospective proposal writes require separate user approval. Spawned implementation and review subagents remain unable to write integration or lifecycle artifacts.
- Do not add or rewrite requirements by bypassing planning artifacts.
- Do not install dependencies without grounded evidence from the approved task, existing project conventions, or explicit user approval.
- In a co-located project where harness files live alongside app code, do not run interactive scaffolders that may overwrite or prompt in a non-empty directory, such as `npm create vite .`. Write config files manually and install only dependencies.
- Do not access, print, or exfiltrate `.env` files, credentials, or tokens.
- Do not hide failing verification by marking a task done.
- Do not mark an isolated-worktree task done before its accepted result is present on the approved canonical integration branch.
- Do not perform remote push, PR creation, or remote merge from this skill.
- Do not automatically self-modify skills or agents.
- Do not modify `.plan2agent/constitution.json` or `.plan2agent/style.md` during implementation; constitution changes require the focused Gate ② amendment path, while legacy style updates require direct user edits or the approved proposal path.

## Output

Return these items to the user:

- Summary of implemented changes.
- `changedFiles` list.
- Verification summary with commands and outcomes.
- For batch mode, the ready snapshot, task/run/worktree mapping, harvest disposition, and canonical integration ref for every selected task.
- Recommended task status: `done`, `blocked`, or keep active.
- Optional skill-proposal schema object file path only when a separately approved retrospective write produced one.

## Retrospective

Run a Hermes-style retrospective only after a failed/blocked run, a retry, an explicit user correction, or a repeated process defect. A normal first-pass success requires no retrospective question or proposal. When the trigger exists, look for repeated mistakes, missing verification, reusable procedures, or unclear boundaries and determine from the conversation whether the user corrected code style; do not ask again when the answer is already evident. Report the candidate in closeout and request separate approval before writing any proposal artifact.

After explicit approval, prefer the canonical `p2a proposals mine --artifacts <artifact-root> --run-id <run-id>` path. If an approved style-correction candidate must be authored directly, save one `p2a.skill_proposal.v1` object under `.plan2agent/proposals/<proposalId>.json`, with a stable id, source run, concrete evidence, risk, `status: "proposed"`, `target: "project"`, and `targetFiles: [".plan2agent/constitution.json"]`; use `[".plan2agent/style.md"]` only for an unmigrated legacy project.

Do not edit any skill, agent, planning artifact, CLI mirror, or other canonical file automatically as part of the retrospective. Leave only the proposal object for later review. A human or the read-only skill curator must review the proposal, and any approved patch must happen in a separate turn after human approval.
