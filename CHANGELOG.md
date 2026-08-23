# Changelog

All notable changes to Plan2Agent are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

## [0.5.0] - 2026-08-17

### Added

- Add the explicit `p2a memory push --profile planning-docs` workflow for previewing and synchronizing approved Gate A/B planning Markdown from the current iteration and recorded archived iterations.

### Changed

- Delegate `planning-docs` snapshot chunk generation to the Memory server with the `paragraph-2000` strategy while preserving the existing client-chunk transport for pushes without the profile.

### Fixed

- Harden planning-document selection, provenance, project and artifact-root confinement, symlink handling, deterministic dry-run reporting, and server acknowledgment validation.

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
- Add package-runtime project initialization, managed provider assets, artifact validation, handoff, supervised execution, evaluation, proposal, and optional Memory workflows.
- Ship canonical and generated integrations for Codex, Claude Code, and Gemini CLI.

[Unreleased]: https://github.com/silbaram/plan2agent/compare/v0.5.8...HEAD
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
