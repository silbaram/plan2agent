# Changelog

All notable changes to Plan2Agent are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.20] - 2026-09-02

### Added

- Add simple GitHub issue preview and explicit publication commands for four-section P2A retrospective Markdown, with a github.com-pinned target, secret/path rejection, and marker-based duplicate detection.

## [0.5.19] - 2026-08-28

### Changed

- Scope new final acceptance reviews to the current iteration delta while preserving validation compatibility for legacy cumulative review records.

### Fixed

- Keep completed implementation closed when final verification or review cannot start because of an environment failure, retry only the affected final evidence run, and let validated blocking review findings take precedence over unrelated unavailable commands.
- Skip functional acceptance when the current iteration adds no new behavior criteria, reject environment labels that hide executed product failures, and fail child-process spawn errors even when they report exit status zero.
- Cache identical canonical workspace revisions across retained final runs so closeout checks do not rehash the workspace once per run.
- Keep P2A-generated retrospective reports from invalidating current final verification evidence before or after a final run closes, including projects with pre-existing report directories, and make optional product review reuse that evidence without rerunning product commands.

## [0.5.18] - 2026-08-27

### Added

- Add a dedicated P2A retrospective choice beside product review and iteration close, reusing bounded current-iteration signals and the existing approval-gated proposal flow.

### Changed

- When no automatic retrospective signal is found, guide the agent to ask once about user-observed P2A delay, errors, wrong routing, or unnecessary steps and create nothing when the user reports no issue.
- Enable bounded read-only process-signal detection by default, keep performance thresholds opt-in, and render detected closeout signals as plain-language user-facing findings.
- Bind an explicitly approved retrospective to one minimal project report path, keep proposal mining separately approved, and present the same optional closeout choices once after the final maintenance task.

## [0.5.17] - 2026-08-27

### Added

- Add bounded `p2a.retrospective_candidate.v1` closeout signals for configured verification budgets/baselines, retry overhead, repeated process defects, explicit corrections, failed/blocked runs, verification gaps, and monitor mismatches.
- Expose current-iteration retrospective candidates in `p2a next --json --contract v2` and offer iteration-scoped proposal mining as a separately approved review action without blocking iteration close.

### Changed

- Route active task transitions and iteration close from the bounded current development contract, and task-authoring context from active planning artifacts, instead of replaying historical composition sources.
- Keep deep historical composition and archive checks available through explicit `p2a iteration validate` and doctor/audit workflows while allowing current development to continue when archived source artifacts are missing or malformed.
- Keep retrospective candidate and proposal evidence numeric and category-based; raw verification output, notes, task prose, and source values are not copied into the closeout summary.

### Fixed

- Revalidate the current contract and task bindings after acquiring task-transition locks so concurrent current-state drift fails closed without restoring historical validation.
- Retain `retry_overhead` closeout candidates and accurate failed-run counts after active-only cleanup prunes a mined failed retry.
- Ignore deleted in-root legacy effective-spec targets on current-only lifecycle routes while continuing to reject external references and preserve deterministic concurrent open/close behavior.

## [0.5.16] - 2026-08-27

### Added

- Add a canonical `current-development-contract.json` that materializes the active objective, scope, architecture, code rules, acceptance, verification, authority, and immutable current task bindings.
- Add `p2a iteration migrate-current-contract` for deterministic existing-project migration and bind active iteration runs to the materialized contract hash.

### Changed

- Route `p2a next` and normal `execute`/`runs` lifecycle commands from the current contract, current task graph, current constitution, and active run evidence without validating or replaying archived iteration documents.
- Treat archived intake/spec/task graph content, composition metadata, archive receipts, and historical digest state as non-authoritative for current development; `p2a next --trace` now reports zero historical reads on the current route.
- Open each new iteration from a compact spec snapshot derived only from the previous current contract, and stop using archived task graphs for rework inference.
- Keep normal first-attempt development independent of BuildLore/LLM Wiki retrieval while preserving explicit, optional knowledge commands.
- Include the current development contract in portable handoff bundles and allow acceptance review evidence to reference current contract criteria directly.

### Fixed

- Fail closed when an open current-contract run observes contract, constitution, or current task binding drift, while retaining legacy graph-run status compatibility.

## [0.5.15] - 2026-08-26

### Added

- Add `p2a runs gc` with dry-run previews, iteration scoping, final-run retention, persistent-mode protection, and orphan evidence cleanup while refusing both indexed and crash-orphaned started runs; surface orphan cleanup guidance through `p2a doctor`.
- Record optional Git HEAD, branch, and dirty state metadata when a run starts and refresh it when the run finishes.
- Add structured changed-file verification through `relatedVerification` and `p2a runs verify --related`, passing workspace-relative file arguments without shell interpolation.
- Add `p2a execute verify-final` and revision-bound full verification evidence for iteration close readiness.

### Changed

- Preserve failed or blocked active-only runs until proposal mining records their `sourceRunId`, preventing direct retries from silently discarding self-improvement input.
- Store new Gate-derived execution envelopes once per content hash under the iteration run partition and keep only `executionEnvelopeRef` plus the verified SHA-256 in each run; retain inline run compatibility, reject intermediate symbolic-link storage paths, and migrate inline evidence with `p2a runs migrate-schema`.
- Record verification scope, canonical workspace revision, and related-file count in run evidence; legacy string verification commands remain full-scope commands.
- Route completed iterations through one canonical no-change final verification run, reuse same-revision full evidence from final visual or acceptance review, and reject related-only or stale evidence at close.
- Add an empty `relatedVerification` list when initializing, updating, upgrading, or enhancing project configuration.

## [0.5.14] - 2026-08-26

### Fixed

- Allow read-only acceptance reviewers to inspect the approved spec, exact target run, and recorded evidence through provider-native read/search operations or read-only shell inspection, while continuing to forbid product, verification, lifecycle, and network execution.

## [0.5.13] - 2026-08-25

### Changed

- Scope new functional acceptance review runs to current-iteration Gate B behavior while continuing to validate legacy cumulative contracts, and require exact run-contract evidence preflight before reviewer invocation.
- Preserve bounded, text-free retrospective counters when active-only cleanup removes superseded or completed-maintenance runs, then discard the iteration counters when the next iteration opens.
- Reuse request-scoped artifact validation throughout deep `p2a next` routing, including active baseline, visual, run-contract, and run-store validation paths.

### Fixed

- Record shell spawn failures such as `EPERM` as unavailable verification with no exit code instead of allowing a false successful result.
- Derive current-iteration acceptance criteria correctly when an iteration references a prior approved spec directly as its baseline.

## [0.5.12] - 2026-08-25

### Added

- Add an optional, non-contractual task `intent` sentence for human-first task lists, progress output, and supervised launcher prompts while keeping legacy task graphs valid.
- Add a human-facing writing guide for layered decisions, at-a-glance Gate Markdown, and deterministic presentation tests.

### Changed

- Render human `p2a next` and `p2a shape` decisions as `[한눈에]`, `[실행 명령]`, and `[세부 계약]` without changing the v1/v2 machine JSON contracts.
- Start generated intake, product-spec, and implementation-plan Markdown with a deterministic `[한눈에]` summary and small flow diagram.

## [0.5.11] - 2026-08-24

### Added

- Add the local `p2a buildlore` adapter for project-scoped status, artifact projection, quality checks, retrieval, context, compilation, and query commands.
- Add `p2a --version` and `p2a -v` for reporting the installed package version.

### Changed

- Make BuildLore the only long-term knowledge integration, with explicit local sync and separate Git publication.
- Remove the superseded remote knowledge runtime, configuration, automatic recall, artifact fields, sidecars, fixtures, tests, and compatibility commands.
- Publish the reduced post-removal task context as `p2a.task_context.v2` with no legacy compatibility runtime.

## [0.5.10] - 2026-08-23

### Changed

- Default new and upgraded projects to `runTracking.persistence: active_only`: keep current execution evidence for gates and handoff, prune superseded successful retries, remove archived iteration runs when the next iteration opens, and remove completed maintenance history when the next maintenance task starts. Unmigrated legacy configs without the field resolve as `persistent`, and explicit `persistent` mode preserves prior behavior.

## [0.5.9] - 2026-08-23

### Changed

- Validate run-index task relationships through a single run-to-task grouping pass, keeping semantic validation linear in the number of runs and tasks.

### Fixed

- Preserve request-scoped validation reuse throughout composed-baseline fallback routing so active failed, blocked, started, and review-sensitive paths do not replay the same historical Gate artifacts.
- Reject closed-routing composition drift by replaying only archive-audited source specs and intakes, including extra source iterations and mismatched effective product or implementation sections, without restoring deep provenance validation to the happy path.

## [0.5.8] - 2026-08-23

### Changed

- Route audited closed iterations from the minimal canonical archive, composition, active-run, and review state instead of replaying the full Gate A/B/C provenance graph, while retaining request-scoped validation reuse and optional `p2a next --trace` diagnostics for fallback paths.

### Fixed

- Preserve fail-closed review routing by checking active run files against a declared run-index `runKind`, rejecting mismatches without hydrating historical run evidence.

## [0.5.7] - 2026-08-22

### Fixed

- Replace automatic iteration-close guidance with a structured `review` or explicit `close` decision, including a normal task reopen and remediation run path for review findings.
- Render structured choices in human `p2a next` output, bind the v2 review-or-close state to exact option and command shapes, validate tuple schemas correctly, and route agent consumers through the v2 contract.

## [0.5.6] - 2026-08-22

### Fixed

- Preserve closed-iteration monotonicity by rejecting Gate B re-promotion after `iteration close` and making `next`, `compose`, and `open` fail closed when `current-spec.json` and active iteration metadata disagree about archive state.

## [0.5.5] - 2026-08-21

### Fixed

- Route an approved active Gate B through `iteration promote-spec` before Gate C preparation, persist its canonical spec ref/SHA promotion binding, reject Gate C entry points when that binding is missing or stale, and make same-spec retries deterministically repair partial metadata and portable handoff state.
- Reject malformed or unsupported `--verify-command` types before `runs verify` or `execute finish` executes any command or changes run, index, revision, verification, project-config, or task evidence, with canonical allowed-type and `custom:` guidance.

## [0.5.4] - 2026-08-20

### Fixed

- Route `p2a next` to `iteration compose` when a closed iteration is missing from the effective baseline composition instead of returning an `iteration open` command that must fail.

## [0.5.3] - 2026-08-19

### Fixed

- Avoid false capability contradictions when a spec includes a capability while excluding only a qualified scope, surface, or mode such as cross-project use, CLI fallback, query save mode, eval history recording, or retrieval orchestration.

## [0.5.2] - 2026-08-19

### Fixed

- Apply answered baseline `superseded_by_*` decisions before Gate B delta synthesis, block ambiguous supersession merges with baseline/field context, and reject same-capability include/exclude contradictions during spec validation.

## [0.5.1] - 2026-08-19

### Fixed

- Route newly opened baseline-backed iterations into Gate A when a valid entry is supplied, return deterministic missing or invalid entry actions otherwise, and preserve documented `gate_a_interview` resume compatibility.
- Make `p2a doctor --dev` verify every manifest-managed file's confined regular-file path and exact SHA-256 digest, including explicit failures for missing files, symlink substitution, and path traversal.

## [0.4.0] - 2026-08-16

### Added

- Add phase-aware runtime context routing with a canonical route manifest and `p2a context show`, which returns action- or run-bound context packets containing confined reference bodies, stable route IDs, hashes, and byte boundaries.
- Add `p2a.next.v2` structured skill actions, stable continuation metadata, and machine-readable execution results while keeping the default `p2a.next.v1` response unchanged.
- Add `p2a doctor --context` inventory, assembled-context, provider parity, baseline-drift, duplicate, conflict, source-owner, size, and hash diagnostics.
- Add optional entry reference bundles and `p2a reference snapshot` so Gate A captures entry, bundle, and declared reference bytes, while Gate B records the exact inspected-reference-to-evidence-to-spec-decision lineage.
- Add schema-validated provider-neutral trace summaries and reproducible Codex/Gemini runtime-routing evaluation runners with isolated source manifests and conservative performance gates.

### Changed

- Split the largest canonical skills into compact decision and authority guidance plus conditionally loaded references, reducing always-loaded instruction content without moving enforceable Gate or safety rules out of schemas and validators.
- Make the canonical context route manifest the shared source for runtime selection, context audit, provider asset parity, and generated Gemini command identity.
- Require new document-backed Gate A approvals to pass the original `--entry`; when a sibling reference bundle exists, its validated snapshot must be captured before approval. Baseline-backed iterations and legacy approval rebinding retain their entry-less compatibility path.
- Separate CLI dispatch, next-state decisions, context packet rendering, schema validation, trace normalization, and evaluation helpers into stable modules with package and dependency-boundary regression coverage.

### Fixed

- Treat unattributed or unknown content reads as partial trace coverage instead of reporting zero repeated reads as proven success.
- Validate context packet activation, continuation, phase, mode, and binding combinations together, including source-byte totals, unique routes and paths, and canonical timestamps.
- Reject reference, route, and trace path attribution that escapes the workspace through traversal, ambiguous suffix matching, or symbolic links.
- Compare context audit baselines only when measurement, normalized scenario, and provider sets match, and detect source additions, removals, same-size content changes, and route-metadata drift.
- Keep provider-specific unavailable metrics explicitly excluded from performance gates instead of converting missing or ambiguous usage into misleading values.

### Compatibility

- Node.js 22 or newer remains required.
- `p2a next --json` continues to emit the strict v1 contract; consumers opt into the new typed contract with `--contract v2`.
- Existing projects without `executionMode` continue to resolve as Orchestrated, and context packets do not grant new write, approval, deployment, or spending authority.

## [0.3.0] - 2026-08-15

### Added

- Add adaptive execution readiness with Direct, Planned, and Orchestrated modes, including one synthetic compatibility work item for Direct/Planned and ordered command-verified checkpoints for Planned runs.
- Bind new runs to a Gate-derived execution envelope that preserves source hashes, objective, scope, `must_preserve`, non-goals, acceptance, verification, authority boundaries, and required visual contracts.
- Record run usage, interruption, Gate-return, monitor-rule, and stable evaluation metrics for production evidence analysis.

### Changed

- Default new projects to adaptive execution while treating existing configurations without an execution mode as Orchestrated for compatibility.
- Route approved Gate B work through `p2a next` so detailed task graphs are created only when Orchestrated execution benefits from dependency or ownership boundaries.
- Use the current confined owner and no extra isolation for ordinary Direct/Planned work, with monitor and independent acceptance review remaining opt-in unless policy or the approved contract requires them.

### Removed

- **Breaking:** Remove the `p2a iteration promote-milestone` writer and stop creating new standalone style/milestone review passes. Automation must stop invoking that command; historical schemas and readers remain available for archived evidence compatibility.

## [0.2.3] - 2026-08-11

### Changed

- Run repository CI on pull requests targeting `main` so supported Node.js, fixture, and portability checks complete before merge.
- Require full current-iteration visual prototype candidates to expose screen-level content-stress states as reachable `index.html` fragments and make long-content treatment an explicit Gate B choice.
- Perform repeated, unrecorded user visual inspection before implementation finish, while routing implementation drift directly to correction and visual contract changes through artifact revision and Gate B reapproval.

## [0.2.2] - 2026-08-10

### Added

- Add public GitHub Actions coverage for the supported Node.js versions, the full fixture gate, and macOS/Windows package portability smoke tests.
- Document the repeatable npm, Git tag, GitHub Release, and post-release verification procedure.
- Warn from `p2a doctor` when extra runtime script or schema entries remain in the manifest-managed inventory, without classifying external harness files as runtime drift.
- Warn from `p2a doctor` when the manifest package identity or version differs from the running runtime, using offline checks and runtime-specific update guidance.

### Changed

- Raise the minimum supported Node.js version from 20 to 22 after Node.js 20 reached end of life.
- Run repository CI only after a pull request is merged into `main`, rather than on pull request updates or ordinary branch pushes.

## [0.2.1] - 2026-08-09

### Added

- Add `p2a upgrade --dry-run` to stage the exact npm latest version temporarily and show its real project update plan without writing the project or global package.
- Add `p2a upgrade --apply` for verified npm-global installations, with latest-version project preflight, exact-version installation, installed-package verification, and new-entrypoint re-execution.
- Add cross-platform upgrade command tests, including Windows npm command and path handling.

### Changed

- Keep `p2a update` pinned to the package version recorded in the project manifest and direct version mismatches to `p2a upgrade`.
- Keep `--prune` disabled by default and remove only unchanged retired managed files when explicitly requested.
- Remove machine-specific `toolkitRoot` provenance from package runtime manifests.

### Fixed

- Prevent invalid targets or manual-review conflicts from changing the global package before project apply readiness is known.
- Distinguish global installation failures from failures that occur after installation during project application.

## [0.2.0] - 2026-08-06

### Added

- Add document-first Gate A scope confirmation and an append-only decision ledger for approvals, revocations, and scope history.
- Add the persistent Gate ② project constitution for architecture, stack, prohibitions, and style decisions.
- Add iteration-level visual experience artifacts and final visual review support.
- Add configurable final acceptance review for non-visual implementation work.

### Changed

- Simplify the Gate A-C planning flow and update the English and Korean user guidance for the v0.2 workflow.
- Strengthen package, handoff, iteration, and execution regression coverage.

## [0.1.0] - 2026-07-28

### Added

- Publish the first public `plan2agent` npm package with the global `p2a` CLI.
- Add package-runtime project initialization, managed provider assets, artifact validation, handoff, supervised execution, evaluation, and proposal workflows.
- Ship canonical and generated integrations for Codex, Claude Code, and Gemini CLI.

[Unreleased]: https://github.com/silbaram/plan2agent/compare/v0.5.20...HEAD
[0.5.20]: https://github.com/silbaram/plan2agent/compare/v0.5.19...v0.5.20
[0.5.19]: https://github.com/silbaram/plan2agent/compare/v0.5.18...v0.5.19
[0.5.18]: https://github.com/silbaram/plan2agent/compare/v0.5.17...v0.5.18
[0.5.17]: https://github.com/silbaram/plan2agent/compare/v0.5.16...v0.5.17
[0.5.16]: https://github.com/silbaram/plan2agent/compare/v0.5.15...v0.5.16
[0.5.15]: https://github.com/silbaram/plan2agent/compare/v0.5.14...v0.5.15
[0.5.14]: https://github.com/silbaram/plan2agent/compare/v0.5.13...v0.5.14
[0.5.13]: https://github.com/silbaram/plan2agent/compare/v0.5.12...v0.5.13
[0.5.12]: https://github.com/silbaram/plan2agent/compare/v0.5.11...v0.5.12
[0.5.11]: https://github.com/silbaram/plan2agent/compare/v0.5.10...v0.5.11
[0.5.10]: https://github.com/silbaram/plan2agent/compare/v0.5.9...v0.5.10
[0.5.9]: https://github.com/silbaram/plan2agent/compare/v0.5.8...v0.5.9
[0.5.8]: https://github.com/silbaram/plan2agent/compare/v0.5.7...v0.5.8
[0.5.7]: https://github.com/silbaram/plan2agent/compare/v0.5.6...v0.5.7
[0.5.6]: https://github.com/silbaram/plan2agent/compare/v0.5.5...v0.5.6
[0.5.5]: https://github.com/silbaram/plan2agent/compare/v0.5.4...v0.5.5
[0.5.4]: https://github.com/silbaram/plan2agent/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/silbaram/plan2agent/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/silbaram/plan2agent/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/silbaram/plan2agent/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/silbaram/plan2agent/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/silbaram/plan2agent/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/silbaram/plan2agent/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/silbaram/plan2agent/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/silbaram/plan2agent/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/silbaram/plan2agent/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/silbaram/plan2agent/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/silbaram/plan2agent/releases/tag/v0.1.0
