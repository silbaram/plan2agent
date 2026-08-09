# Changelog

All notable changes to Plan2Agent are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add public GitHub Actions coverage for the supported Node.js versions, the full fixture gate, and macOS/Windows package portability smoke tests.
- Document the repeatable npm, Git tag, GitHub Release, and post-release verification procedure.

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

[Unreleased]: https://github.com/silbaram/plan2agent/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/silbaram/plan2agent/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/silbaram/plan2agent/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/silbaram/plan2agent/releases/tag/v0.1.0
