# Plan2Agent (`p2a`)

**Minimal task tracking and session-resume harness for AI coding agents.**

> Korean documentation: [README.ko-KR.md](README.ko-KR.md) · Docs index: [docs/README.md](docs/README.md)

Plan2Agent keeps AI-assisted development predictable without flooding your repository with generated documents:

- **At most 2 files in `.plan2agent/`**: `config.json` (project verification settings) and `work.json` (current development state, removed on `p2a done`). **Zero auto-generated Markdown files.**
- **One-time unified approval**: agree once on `goal`, `scope`, `non_goals`, `constraints`, and `tasks` (`p2a approve --quote "..."`) before coding begins, protected by `plan_sha256` drift detection.
- **Real verification before `done`**: `p2a verify` executes the real test/lint/typecheck command and records `exit_code`, `git_head`, `worktree_fingerprint` (excluding `.plan2agent/`), and changed files. Editing product code after verification requires re-verification before `p2a task done`.
- **Seamless session resume**: close and reopen your terminal or agent session at any point—`p2a next` reads `.plan2agent/work.json` alone and restores the exact active task, last verification failure, notes, and resume summary.
- **Zero runtime dependencies**: Node.js `>=22.0.0` standard library only. Works across Codex, Claude Code, and Gemini CLI with optional read/handoff integration for BuildLore.

---

## Quick Start

```bash
# 1. Install
npm install -g plan2agent

# 2. Initialize inside your repository (creates .plan2agent/config.json + minimal provider skills)
p2a init --tools all

# 3. Start a development item
p2a next --idea "Add rate limiting to the login endpoint"
```

### Standard Workflow

```text
p2a next --idea "..."        # creates draft .plan2agent/work.json
  -> inspect code & fill plan/tasks in work.json (or via p2a task add)
  -> p2a approve --quote "..." # 1-time confirmation of goal, scope, constraints, and tasks
  -> p2a task start T1
  -> implement code
  -> p2a verify --task T1      # runs real verify command & records fingerprint
  -> p2a task done T1
     (if session closes at any point, run `p2a next` in a fresh session to resume immediately)
  -> p2a done                  # checks all tasks done+verified and removes .plan2agent/work.json
```

---

## Files Created in Your Project

```text
.plan2agent/
  config.json   # project_id, verify commands (test/lint/typecheck), optional buildlore config
  work.json     # active development plan, tasks, verification, resume summary (deleted on `p2a done`)
```

Provider assets installed by `p2a init --tools <codex,claude,gemini|all|none>`:

- Canonical skills (2): `.agents/skills/p2a-next/SKILL.md`, `.agents/skills/p2a-work/SKILL.md`
- Canonical subagents (2): `.agents/agents/p2a-implementer.md`, `.agents/agents/p2a-reviewer.md`
- Provider mirrors: `.claude/` (skills, agents, workspace confinement hook), `.codex/agents/`, `.gemini/` (agents + `next`/`work` commands).

No `PLAN2AGENT.md`, `status.md`, `entries/*.md`, or archive directories are created.

---

## Core CLI Commands

| Command | Purpose |
| --- | --- |
| `p2a init [--tools codex,claude,gemini\|all\|none]` | Create `.plan2agent/config.json` (auto-detecting test/lint/typecheck commands) and install minimal provider assets |
| `p2a next [--idea "<text>" \| --entry <path>] [--json]` | Inspect `work.json` and return the single next state/action (used for starting and resuming sessions) |
| `p2a approve --quote "<user utterance>"` | Record one-time confirmation of the plan and bind `approval.plan_sha256` |
| `p2a task <list\|add\|start\|note\|block\|unblock\|done>` | Manage tasks, dependencies, notes, and `resume.summary` |
| `p2a verify [--task <id>] [--cmd "<command>"]` | Run the real verification command and store exit code, output tail, git HEAD, and worktree fingerprint |
| `p2a done [--abort]` | Confirm all tasks are done & verified and delete `.plan2agent/work.json` (`--abort` discards incomplete work) |
| `p2a validate` / `p2a doctor` | Validate `config.json` and `work.json` schemas, DAG integrity, and installed provider assets |
| `p2a buildlore <status\|memory\|lookup\|search\|sync\|handoff>` | Optional BuildLore adapter (non-blocking; completely unused when disabled) |

---

## Development & Verification

```bash
npm run test:all
npm pack --dry-run
```

## Documentation

- [Docs Index](docs/README.md)
- [Quickstart](docs/quickstart.md)
- [CLI Reference](docs/cli-reference.md)
- [Harness Spec (`config.json` & `work.json`)](docs/harness-spec.md)
- [Releasing](docs/releasing.md)
