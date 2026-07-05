# Plan2Agent

Plan2Agent (P2A) is a local-first planning and supervised execution harness for AI coding agents.
It turns a one-sentence product idea into approved specs, dependency-aware task graphs, run logs,
evaluation reports, improvement proposals, and maintenance work that can be executed by tools such
as Codex, Claude Code, and Gemini CLI.

**Search keywords:** AI agent planning, coding agent workflow, agentic software development,
task graph, product spec generation, supervised execution, AI code review, local-first artifacts,
Codex, Claude Code, Gemini CLI, eval loop, self-improvement loop, memory server, developer tools.

## What Plan2Agent Does

Plan2Agent helps teams move from an idea to controlled AI-assisted implementation without losing
traceability. It keeps JSON artifacts as the source of truth and uses approval gates so an agent
cannot silently turn unclear requirements into code.

```text
Idea
  -> Gate A: intake and decisions
  -> Gate B: product spec and implementation plan
  -> Gate C: executable task graph
  -> Gate D: review and readiness check
  -> supervised task execution
  -> run verification and logs
  -> eval, proposal, memory, and maintenance loops
```

P2A is intentionally not a fully autonomous background coding system. It coordinates skills,
prompts, artifacts, run state, monitor gates, and improvement proposals while the actual agent CLI
or app session stays foreground-supervised by the user.

## Key Features

### AI Planning Harness

- Convert a short product idea into structured intake artifacts.
- Track assumptions, clarifying questions, and `needs_user_decision` items.
- Generate product specs, implementation specs, and task graphs.
- Require explicit approval before moving from spec to task execution.
- Validate artifacts with JSON schemas and gate-specific checks.

### Multi-CLI Agent Support

- Canonical skills and agents live under `.agents/`.
- Generated mirrors support Claude Code, Codex, and Gemini CLI.
- CLI-neutral agent metadata is synchronized into provider-specific formats.
- Mirror drift is checked with `scripts/check_cli_parity.mjs`.

### Task Graph and Iteration Management

- Create dependency-aware task graphs with acceptance criteria.
- Track task states: `todo`, `in_progress`, `done`, and `blocked`.
- Manage active iterations, next iterations, semantic diff tasks, and maintenance lanes.
- Preserve closed iterations as append-only history.

### Supervised Execution

- Use `p2a execute` to plan, start, resume, inspect, and finish a single task run.
- Capture run logs, changed files, verification commands, failure classes, and structured debug data.
- Enforce monitor gates and verification evidence before marking tasks done.
- Support provider runner guides for Codex, Claude, Gemini, and manual execution.

### Evaluation Loop

- `p2a eval grade` checks one run against task acceptance and verification evidence.
- `p2a eval compare` detects regressions between runs or iterations.
- `p2a eval analyze` clusters failures and verification gaps.
- `p2a eval generate` writes grade, analysis, compare, and eval index artifacts.
- `p2a eval digest` summarizes generated evaluation artifacts.
- Eval digests include self-improvement metrics for recent failed/blocked run evidence, proposal review status scoped to source runs, approval-artifact-backed conversion, recurring failure clusters, and post-maintenance verification.

### Improvement Proposal Loop

- Mine failed or blocked runs into structured improvement proposals.
- Score proposal quality from evidence, reproduction, impact scope, validation, and risk rationale.
- Review, curate, draft, and approve proposal artifacts without automatically applying patches.
- Convert approved proposal drafts into maintenance tasks.
- Execute approved maintenance tasks through the same supervised execution path.

### Memory Integration

- Use Plan2Agent Memory as an optional long-term artifact store and search backend.
- `p2a memory status` compares local artifacts with remote snapshots.
- `p2a memory push` uploads project, iteration, document, task, graph, and run snapshots.
- `p2a memory search` and `p2a memory history` support cross-session recall.
- `p2a memory digest` summarizes failure and proposal history and tracks whether Memory search results were reused by run, proposal, or eval artifacts.

### GUI Workbench

- Electron-based GUI for project overview, artifacts, tasks, runs, and operational reports.
- Shows update reports, eval analysis, eval digest, memory digest, memory history, and memory search.
- Shows an improvement queue with proposal status, quality score, source failure/run, and approved maintenance links.
- Includes supervised PTY-oriented workflow surfaces for foreground agent sessions.

### Scaffold, Update, and Drift Checks

- Scaffold P2A into a target project as a local `.plan2agent/` harness.
- Enhance projects with memory, GUI, orchestration, proposals, and dev-skill capabilities.
- Preview and apply safe toolkit updates with update and upgrade reports.
- Run doctor and parity checks to find missing files, stale assets, and configuration drift.

## Companion Projects

P2A can work with optional sibling projects. They are not required for the core planning,
validation, iteration, execution, eval, or proposal loops, and local `.plan2agent/` artifacts remain
the source of truth.

| Project | GitHub | Purpose | How P2A Uses It |
| --- | --- | --- | --- |
| `plan2agent-memory` | <https://github.com/silbaram/plan2agent-memory> | Optional headless REST service for relational artifact storage, lineage, hash comparison, history, keyword search, and vector-search-ready document chunks. | `p2a memory status/push/pull/search/history/digest` can use the server as a long-term artifact store and search backend. If no Memory server is configured, P2A still runs from local `.plan2agent/` artifacts. |
| `plan2agent-feature-radar` | <https://github.com/silbaram/plan2agent-feature-radar> | Optional skill/subagent research workflow for early idea research and read-only existing-project analysis across web, docs, GitHub, changelogs, issues, PRs, discussions, and local project signals. | Radar can export `.feature-radar/runs/<project-slug>/` and optionally `.plan2agent/artifacts/<project_id>/preflight-research/`. P2A imports that preflight export as `LOCAL-n`/`WEB-n` evidence and Gate B reference candidates; recommendations stay candidate input until Gate B marks them `selected`, `deferred`, or `rejected`. |

The local `plan2agent-feature-radar` checkout may not have a git remote configured yet; update the
GitHub link above if the canonical remote differs.

For local toolkit development, these repos are commonly checked out next to this repository:

```text
projects/
  plan2agent/
  plan2agent-memory/
  plan2agent-feature-radar/
```

## Why Use Plan2Agent?

Plan2Agent is useful when you want AI coding agents to work from explicit product decisions instead
of vague chat history. It is designed for workflows where traceability, reviewability, and safe
iteration matter.

Good fit:

- AI-assisted product planning
- Agent-ready implementation specs
- Task graph generation for coding agents
- Supervised Codex, Claude Code, or Gemini CLI workflows
- Run verification and regression tracking
- Human-approved self-improvement and maintenance loops
- Local-first artifact workflows

Not a fit:

- Fully autonomous background code execution
- Unofficial provider API automation
- Automatic dependency installation, merging, pushing, or PR creation without approval
- Replacing source control or project management systems
- Making a remote Memory server the source of truth

## Quick Start

### 1. Scaffold P2A into a project

Run this from any checkout of the Plan2Agent repository:

```bash
node /path/to/plan2agent/scripts/p2a_handoff.mjs scaffold \
  --target <project-dir> \
  --tools all
```

Then work inside the target project:

```bash
cd <project-dir>
node .plan2agent/scripts/p2a.mjs info
```

Scaffold records a default `projectId` in both `.plan2agent/project.config.json` and `.plan2agent/manifest.json` by normalizing the target directory basename to kebab-case. After scaffold, `.plan2agent/project.config.json.projectId` is the source of truth; the directory basename is only the fresh-scaffold seed. If older local artifacts already exist, their artifact/spec/task graph id is used as a recovery fallback before deriving from a renamed directory. Planning artifacts still live under `.plan2agent/artifacts/<project_id>/`, but in scaffold projects users normally use the stored `projectId` instead of inventing a new id for each idea.

### 2. Start from a one-sentence idea

Open your preferred AI coding tool in the project directory and invoke the P2A harness skill.

Claude Code example:

```text
/p2a-harness Build a small service that receives webhook events, verifies signatures, and exposes delivery history.
```

Codex example:

```text
Use the $p2a-harness skill on this idea:
Build a small service that receives webhook events, verifies signatures, and exposes delivery history.
```

Gemini CLI example:

```text
/p2a:harness Build a small service that receives webhook events, verifies signatures, and exposes delivery history.
```

The planning flow writes artifacts under:

```text
.plan2agent/artifacts/<project_id>/
  gate-a-intake/
  gate-b-spec/
  gate-c-task-graph/
  gate-d-review/
```

### 3. Validate and initialize an iteration

```bash
node .plan2agent/scripts/p2a.mjs validate \
  --artifact-root .plan2agent/artifacts/<project_id> \
  --project-id <project_id> \
  --require-handoff-ready

node .plan2agent/scripts/p2a.mjs iteration init \
  --artifacts .plan2agent/artifacts/<project_id> \
  --iteration-id v1-mvp
```

### 4. Run a supervised task

```bash
node .plan2agent/scripts/p2a.mjs tasks ready \
  --artifacts .plan2agent/artifacts/<project_id>

node .plan2agent/scripts/p2a.mjs execute plan \
  --artifacts .plan2agent/artifacts/<project_id> \
  --task <task-id>

node .plan2agent/scripts/p2a.mjs execute start \
  --artifacts .plan2agent/artifacts/<project_id> \
  --task <task-id> \
  --agent-tool codex
```

Paste the generated launcher prompt into your foreground agent session. When the implementation is
ready, finish the run with explicit verification:

```bash
node .plan2agent/scripts/p2a.mjs execute finish \
  --artifacts .plan2agent/artifacts/<project_id> \
  --run-id <run-id> \
  --test \
  --lint \
  --typecheck \
  --collect-git
```

### 5. Evaluate, review, and improve

```bash
node .plan2agent/scripts/p2a.mjs eval generate \
  --artifacts .plan2agent/artifacts/<project_id>

node .plan2agent/scripts/p2a.mjs eval digest \
  --artifacts .plan2agent/artifacts/<project_id> \
  --recent-runs 30

node .plan2agent/scripts/p2a.mjs proposals mine \
  --artifacts .plan2agent/artifacts/<project_id>

node .plan2agent/scripts/p2a.mjs memory digest \
  --artifacts .plan2agent/artifacts/<project_id>
```

## Main CLI Surface

Inside a scaffolded project, use the single `p2a.mjs` entrypoint:

| Command | Purpose |
| --- | --- |
| `info` | Show project, enhancement, artifact, task, and run summary. |
| `doctor` | Diagnose local harness configuration and capability drift. |
| `update` | Preview or apply safe scaffolded toolkit updates. |
| `upgrade` | Preview or apply broader toolkit/schema/asset migrations. |
| `enhance` | Enable optional capabilities such as memory, GUI, orchestration, and proposals. |
| `validate` | Validate intake, spec, task graph, review, run, proposal, eval, and memory artifacts. |
| `iteration` | Manage active iterations, close/open cycles, diffs, drafts, and maintenance tasks. |
| `tasks` | List, inspect, prompt, start, reopen, block, or complete tasks. |
| `runs` | Start, verify, record, finish, show, and validate run logs. |
| `execute` | Supervise a task lifecycle from plan to verified finish. |
| `orchestrate` | Build role plans, runtime state, runner guides, and monitor gate flows. |
| `proposals` | Mine, review, curate, draft, approve, and digest improvement proposals. |
| `eval` | Grade, compare, analyze, generate, and digest run quality artifacts. |
| `memory` | Compare, push, pull-preview, search, history, and digest Memory snapshots. |

## Repository Layout

```text
.agents/                 Canonical skills and CLI-neutral agents
.claude/                 Generated Claude Code mirrors
.codex/                  Generated Codex agent mirrors
.gemini/                 Generated Gemini CLI agents and commands
apps/p2a-gui/            Electron GUI workbench
docs/                    User guides and implementation references
fixtures/                Golden fixtures and negative test fixtures
plans/                   Roadmap and completed planning notes
schemas/                 JSON schemas for P2A artifacts
scripts/                 Toolkit, scaffold, validation, runtime, eval, proposal, and memory CLIs
```

## Artifact Model

P2A keeps local `.plan2agent/` files as the source of truth.

Core artifacts:

- `intake.json` - requirements, assumptions, and open decisions.
- `spec.json` - approved product and implementation spec.
- `task-graph.json` - executable dependency graph.
- `review.json` - Gate D readiness review.
- `current-spec.json` - active iteration baseline.
- `runs/<run-id>.json` - execution record and verification evidence.
- `proposals/*.json` - improvement candidates and curation artifacts.
- `eval/*.json` - grade, analysis, compare, index, and digest artifacts.
- `memory-*.json` - Memory search, history, digest, and pull preview reports.

Generated Markdown files are views for humans. JSON artifacts are canonical.

## Development Checks

For Plan2Agent toolkit development, run from this repository:

```bash
node scripts/sync_cli_assets.mjs
node scripts/check_cli_parity.mjs
node scripts/run_fixtures.mjs
```

GUI checks:

```bash
cd apps/p2a-gui
npm run typecheck
npm test
```

The core runtime scripts are Node.js ESM scripts and use the Node.js standard library. The GUI has
its own npm dependencies under `apps/p2a-gui/`.

## Documentation

- [Quickstart](docs/quickstart.md)
- [CLI Reference](docs/cli-reference.md)
- [Harness Guide](docs/harness-guide.md)
- [Iteration Spec](docs/iteration-spec.md)
- [Supervised Execution Reference](docs/supervised-execution.md)
- [Harness Implementation Spec](docs/harness-spec.md)
- [Product Roadmap](plans/01-product-roadmap.md)
- [Harness Advancement Notes](plans/04-p2a-harness-advancement.md)

## Suggested GitHub Topics

If you publish this repository publicly, these topics make the project easier to discover:

```text
ai-agents
coding-agent
agentic-workflow
ai-planning
task-graph
spec-generation
developer-tools
codex
claude-code
gemini-cli
local-first
evaluation
self-improvement
memory-server
```

## Project Status

Plan2Agent is an active local-first harness. The current focus is controlled planning, supervised
execution, deterministic evaluation, proposal-based self-improvement, Memory integration, and GUI
visibility. Automatic self-modifying patches, autonomous provider execution, and unapproved remote
side effects are intentionally outside the default safety model.
