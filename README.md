# Plan2Agent

[![npm version](https://img.shields.io/npm/v/plan2agent.svg)](https://www.npmjs.com/package/plan2agent)
[![npm downloads](https://img.shields.io/npm/dm/plan2agent.svg)](https://www.npmjs.com/package/plan2agent)
[![CI](https://github.com/silbaram/plan2agent/actions/workflows/ci.yml/badge.svg)](https://github.com/silbaram/plan2agent/actions/workflows/ci.yml)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[English](README.md) | [한국어](README.ko-KR.md)

Turn a concise product document into a confirmed product understanding, approved specs,
dependency-aware tasks, and verified AI coding runs.

## Install in 30 seconds

Plan2Agent requires Node.js 22 or newer.

```bash
npm install -g plan2agent
cd <project-dir>
p2a init --tools all --codex-profile quality
p2a next
```

`p2a next` reads the local project state and returns one concrete next action. Run it again whenever
you finish a planning, approval, or development step.

## Your first plan in 5 minutes

After initialization, write a concise Markdown or text entry document. It can be one paragraph and
does not need to be a complete requirements document. Then run `p2a next --entry <path>` or give that
path to the planning harness.

| Agent | Example |
| --- | --- |
| Codex | `Use the $p2a-harness skill with --entry docs/idea.md.` |
| Claude Code | `/p2a-harness --entry docs/idea.md` |
| Gemini CLI | `/p2a:harness --entry docs/idea.md` |

The harness confirms the intended scope, records the confirmed decisions, and turns them into
canonical product, implementation, and task artifacts instead of leaving decisions only in chat.

```text
Concise Markdown or text entry document
  -> Gate A: confirmed understanding and explicit user approval
  -> Gate ②: approved persistent architecture, stack, prohibitions, and style
  -> Gate B: product spec and implementation plan
     -> conditional visual experience: structured screens + approved offline HTML prototype
  -> Gate C: execution readiness (Direct, Planned, or dependency-aware Orchestrated)
  -> supervised implementation and verification
  -> evaluation and improvement proposals
```

Gate A confirmation, Gate ② project-shape approval, and Gate B approval are separate decisions.
`p2a decide --quote "<exact user utterance>"` records Gate ① scope/spec approvals, while
`p2a shape approve --quote "<exact user utterance>"` records the Gate ② approval. Both append to
the chained `decisions.jsonl` ledger and keep existing artifact approval audits as readable copies. Later iterations
reuse that constitution unless their approved scope materially changes the architecture.

The harness writes canonical files under `.plan2agent/artifacts/<project_id>/`. Complete the
suggested action and run:

```bash
p2a next
```

When Gate A-C readiness passes, `next` guides the transition into supervised execution and
subsequent iterations.

## Why Plan2Agent

AI coding tools are effective at implementation, but chat history is a fragile place to keep
requirements, approvals, dependencies, and verification evidence. Plan2Agent adds a durable control
layer around those tools.

| Need | Plan2Agent approach |
| --- | --- |
| Clear decisions before code | Gate A scope, Gate ② project shape, and Gate B spec approval preserve decisions, constraints, assumptions, and approval state. |
| Traceable implementation work | Specs map to a Direct run, Planned checkpoints, or dependency-aware Orchestrated tasks. |
| Reviewable agent execution | Foreground-supervised runs preserve mode, rationale, changed files, and verification evidence. |
| Portable project state | Local JSON artifacts remain canonical across Codex, Claude Code, and Gemini CLI. |
| Controlled improvement | Evaluation and proposal flows recommend maintenance without silently applying self-modifying patches. |

Plan2Agent coordinates the workflow; it does not replace your coding agent, source control, or
project management system.

## What gets written

Planning and execution state stays local to the project:

```text
.plan2agent/
  project.config.json
  constitution.json
  artifacts/<project_id>/
    decisions.jsonl
    gate-a-intake/
      intake.json
    gate-b-spec/
      spec.json
      experience-spec.json       # conditional
      visual-design/              # conditional offline HTML prototypes
    gate-c-task-graph/
      task-graph.json
    current-spec.json
    iterations/
    runs/
    eval/
    proposals/
```

`decisions.jsonl` is the source of truth for recorded approvals and revocations; the existing JSON
approval audits remain compatible copies. All artifacts are validated against schemas shipped with the package.
Generated Markdown is a human-readable view. Run evidence is temporary execution state by default:
the current development bundle remains reviewable and portable, while opening the next iteration
removes archived iteration runs. Approved specs, close metadata, and Git remain the durable history.
Set `runTracking.persistence` to `persistent` only when long-lived local run evidence is required.

## Core workflow

### 1. Plan with approval gates

The planning harness turns an idea into structured intake, product and implementation specs, and
validated execution readiness. Gate A presents a compact understanding summary and requires explicit
confirmation. The same session establishes or reuses Gate ② before continuing to Gate B. It records
uncertainty as an assumption or user decision rather than inventing a requirement.

### 2. Execute the approved objective

After Gate B approval, use `p2a next` to start the next action authorized by the approved contract. New projects default to `adaptive`, while existing configs without an execution mode continue to resolve as `orchestrated`; explicit `adaptive`, `direct`, `planned`, and `orchestrated` policies remain supported without another mode approval. Planned mode records 2–5 ordered, command-verified resume checkpoints. New runs bind a Gate-derived execution envelope containing objective, source hash, scope, preservation conditions, non-goals, acceptance, verification, and authority boundaries.

For direct control of a prepared work item:

```bash
p2a execute start \
  --artifacts .plan2agent/artifacts/<project_id> \
  --task <task-id>
```

See the [Execution Reference](docs/supervised-execution.md) for start, resume, finish, retry, and bounded batch procedures.

### 3. Iterate without losing the baseline

Iterations preserve the approved spec, derive change tasks, track maintenance work, and archive
closed history. A later Gate A reuses relevant confirmed answers from the baseline and asks again
only where the new idea changes or conflicts with them. `p2a next` guides close/open transitions;
`p2a iteration` exposes the lower-level controls.

### 4. Evaluate and improve

The eval flow grades run evidence, compares results, and groups recurring failures. The proposal
flow can turn supported findings into human-reviewed maintenance tasks. It never applies a patch
merely because a proposal exists. With the default `active_only` retention, run eval before opening
the next iteration or starting the next maintenance task; use `persistent` for deliberate long-term
local comparisons.

### 5. Recall optional long-term context

[Plan2Agent Memory](https://github.com/silbaram/plan2agent-memory) is an optional store and search
backend for artifacts, history, and lineage. Local `.plan2agent/` files remain canonical when Memory
is unavailable or not configured.

Use `p2a memory push --artifacts <artifact-root> --profile planning-docs --dry-run` to preview a
focused sync of approved Gate A/B planning Markdown. The profile selects canonical `product-spec.md`
and `implementation-plan.md`, plus `intake.md` when Gate A is complete, from the current functional
iteration and only the archived iterations recorded in `current-spec.json.closed_iterations`.
Pending or unrecorded iterations, maintenance, task/run/review evidence, generated indexes, Memory
recall files, local chunk files, copies, and symlinks are excluded with stable reasons. The preview
validates canonical JSON, reports exact content/provenance hashes, the estimated snapshot count,
server strategy `paragraph-2000`, and zero client `DOCUMENT_CHUNK` writes, and never contacts
Memory. It does not generate local chunk content, hashes, or IDs.
Actual remote writes still require `--yes`.

Local chunk files are never planning source artifacts. On an approved planning-docs push, each
snapshot request opts in with `chunking: { "strategy": "paragraph-2000" }`; the Memory server owns
chunk generation, persistence, and embedding-job enqueue. The CLI validates the response strategy
and positive integer `chunkCount`, fails closed when acknowledgment is missing or invalid, reports
`chunks=0` plus the `serverGeneratedChunks` total, and never falls back to
`/document-chunks/bulk`. Pushes without `--profile planning-docs` keep their existing client chunk
and bulk transport behavior.

## CLI at a glance

Plan2Agent installs one `p2a` entrypoint:

| Command | Purpose |
| --- | --- |
| `p2a init` | Initialize project state and provider assets. |
| `p2a next` | Return one state-based next action and its reason. |
| `p2a decide` | Record Gate ① approvals, revocations, and scope changes in the decision ledger. |
| `p2a decisions` | List decision history and trace a file to governing decisions with `--why`. |
| `p2a shape` | Inspect, migrate, approve, and revoke the persistent project constitution. |
| `p2a info` | Show project, artifact, task, and run status. |
| `p2a doctor` | Diagnose configuration, assets, and local drift. |
| `p2a update` | Apply project-managed assets pinned to the manifest package version. |
| `p2a upgrade` | Preview or apply an npm-global package upgrade, then update the current project. |
| `p2a enhance` | Enable optional capabilities such as Memory and proposals. |
| `p2a validate` | Validate planning, task, run, eval, proposal, and Memory artifacts. |
| `p2a iteration` | Manage iteration initialization, close/open cycles, diffs, and maintenance. |
| `p2a tasks` | Inspect and transition task state. |
| `p2a runs` | Record, verify, finish, and inspect run evidence. |
| `p2a execute` | Supervise implementation and canonical final visual-review runs through verified finish. |
| `p2a eval` | Grade, compare, analyze, generate, and summarize execution evidence. |
| `p2a proposals` | Mine, review, curate, approve, and summarize improvement proposals. |
| `p2a memory` | Check, synchronize, search, and inspect optional Memory data. |

Run `p2a --help` for the top-level command surface and use the
[CLI Reference](docs/cli-reference.md) for detailed options and examples.

## Safety model

Plan2Agent is contract-gated, confined, and local-first. Product meaning requires explicit approval; implementation choices and verification retries inside that approved envelope do not.

It is a good fit when you want:

- explicit product decisions before implementation;
- reviewable specs and task graphs only when orchestration benefits from them;
- confined Codex or Claude execution, with Gemini kept read-only;
- verification evidence and regression history;
- human-approved maintenance and improvement loops.

It is not designed for:

- unattended background coding;
- unofficial provider API automation;
- automatic dependency installation, merging, pushing, or PR creation without approval;
- treating a remote service as the canonical project state;
- replacing Git or an issue tracker.

## Provider support

Canonical skills and subagent definitions live under `.agents/`. Plan2Agent generates and validates
provider-specific surfaces for:

- Codex
- Claude Code
- Gemini CLI

Parity checks keep provider mirrors aligned with the canonical definitions. The agent itself stays
in the foreground tool session; Plan2Agent does not call provider APIs directly.

## Companion projects

The core planning, validation, iteration, execution, eval, and proposal flows work without companion
services.

| Project | Purpose |
| --- | --- |
| [plan2agent-memory](https://github.com/silbaram/plan2agent-memory) | Optional artifact history, search, hash comparison, and lineage service. |
| [plan2agent-feature-radar](https://github.com/silbaram/plan2agent-feature-radar) | Optional research workflow that exports evidence for planning without selecting requirements automatically. |

## Documentation

- [Quickstart](docs/quickstart.md) — shortest path from installation to the first Gate artifacts
- [Adaptive Harness User Flow](docs/adaptive-harness-user-flow.md) — end-to-end Gate approval, adaptive execution, context routing, and closeout
- [CLI Reference](docs/cli-reference.md) — commands, options, and examples
- [Harness Guide](docs/harness-guide.md) — Gate A-C, schemas, evidence, and troubleshooting
- [Iteration Spec](docs/iteration-spec.md) — iteration layout, diffs, close/open, and run tracking
- [Supervised Execution Reference](docs/supervised-execution.md) — task execution, monitor gates, retries, and reviews
- [Harness Implementation Spec](docs/harness-spec.md) — skills, subagents, mirrors, and implementation rules
- [Changelog](CHANGELOG.md) — versioned user-facing changes
- [Release Procedure](docs/releasing.md) — npm, Git tag, GitHub Release, and verification checklist

## Developing Plan2Agent

Clone the repository, use Node.js 22 or newer, and run:

```bash
npm test
npm run test:full
npm run test:package
node scripts/sync_cli_assets.mjs
node scripts/check_cli_parity.mjs
node scripts/run_fixtures.mjs
```

`npm run test:full` is the named long-running fixture gate, including the completed/resumable handoff portability matrix. The direct fixture command remains available for repository development and debugging.

The runtime is Node.js ESM and uses the Node.js standard library. Repository structure:

```text
.agents/       canonical skills and CLI-neutral subagents
.claude/       generated Claude Code mirrors
.codex/        generated Codex mirrors
.gemini/       generated Gemini CLI commands and agents
docs/          user guides and implementation references
fixtures/      golden and negative fixtures
schemas/       JSON schemas for Plan2Agent artifacts
scripts/       toolkit, validation, runtime, eval, proposal, and Memory CLIs
```

## Project status

Plan2Agent is under active development. Version `0.3.0` adds adaptive Direct, Planned, and
Orchestrated execution, with Gate-derived execution envelopes and compatibility-preserving legacy
orchestration. Detailed task graphs are now created only for Orchestrated work that benefits from
dependency or ownership boundaries. The local-first planning, supervised execution, evaluation,
proposal, and optional Memory workflows remain available. Autonomous provider execution and
unapproved remote side effects remain outside the default safety model.

Plan2Agent is available under the [MIT License](LICENSE).
