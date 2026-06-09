#!/usr/bin/env python3
"""Check that Plan2Agent CLI configuration mirrors and command shims stay in sync."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILLS = ["p2a-harness", "p2a-intake", "p2a-spec", "p2a-task-breakdown", "p2a-review"]
AGENTS = [
    "p2a-requirements",
    "p2a-spec-author",
    "p2a-implementation-planner",
    "p2a-task-graph",
    "p2a-quality-reviewer",
]
GEMINI_COMMANDS = ["harness", "intake", "spec", "task-breakdown", "review"]


def fail(message: str) -> int:
    print(f"parity failed: {message}", file=sys.stderr)
    return 1


def main() -> int:
    sync_check = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "sync_cli_assets.py"), "--check"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if sync_check.returncode != 0:
        sys.stderr.write(sync_check.stderr)
        return sync_check.returncode

    for skill in SKILLS:
        source = ROOT / ".agents" / "skills" / skill / "SKILL.md"
        mirror = ROOT / ".claude" / "skills" / skill / "SKILL.md"
        if not source.exists():
            return fail(f"missing source skill {source}")
        if not mirror.exists():
            return fail(f"missing Claude skill mirror {mirror}")
        if source.read_bytes() != mirror.read_bytes():
            return fail(f"skill mirror drift for {skill}")

    for agent in AGENTS:
        source = ROOT / ".agents" / "agents" / f"{agent}.md"
        claude = ROOT / ".claude" / "agents" / f"{agent}.md"
        codex = ROOT / ".codex" / "agents" / f"{agent}.toml"
        gemini = ROOT / ".gemini" / "agents" / f"{agent}.md"
        missing = [str(path.relative_to(ROOT)) for path in (source, claude, codex, gemini) if not path.exists()]
        if missing:
            return fail(f"missing agent mirrors for {agent}: {', '.join(missing)}")

    for command in GEMINI_COMMANDS:
        path = ROOT / ".gemini" / "commands" / "p2a" / f"{command}.toml"
        if not path.exists():
            return fail(f"missing Gemini command shim {path.relative_to(ROOT)}")

    print("Plan2Agent CLI parity passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
