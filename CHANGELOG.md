# Changelog

All notable changes to Plan2Agent are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-08-15

### Added

- Add adaptive execution readiness with Direct, Planned, and Orchestrated modes, including one synthetic compatibility work item for Direct/Planned and ordered command-verified checkpoints for Planned runs.
- Bind new runs to a Gate-derived execution envelope that preserves source hashes, objective, scope, `must_preserve`, non-goals, acceptance, verification, authority boundaries, and required visual contracts.
- Record run usage, interruption, Gate-return, monitor-rule, and stable evaluation metrics for production evidence analysis.
- Add machine-readable `p2a.next.v2` continuation and execution-result contracts so Direct/Planned work can bind follow-up context without parsing display text.
- Add phase-aware context routing and `p2a context show`, which validates the current action or started run before returning confined canonical reference bodies with stable route, hash, and byte boundaries.

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

[Unreleased]: https://github.com/silbaram/plan2agent/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/silbaram/plan2agent/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/silbaram/plan2agent/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/silbaram/plan2agent/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/silbaram/plan2agent/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/silbaram/plan2agent/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/silbaram/plan2agent/releases/tag/v0.1.0
