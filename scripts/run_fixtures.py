#!/usr/bin/env python3
"""Run Plan2Agent fixture/golden validation for every fixture directory."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_ROOT = ROOT / "fixtures"


def main() -> int:
    fixture_dirs = sorted(path for path in FIXTURE_ROOT.iterdir() if path.is_dir()) if FIXTURE_ROOT.exists() else []
    if not fixture_dirs:
        print("fixture validation failed: no fixture directories found", file=sys.stderr)
        return 1

    command = [sys.executable, str(ROOT / "scripts" / "validate_artifacts.py")]
    for fixture_dir in fixture_dirs:
        command.extend(["--fixture-dir", str(fixture_dir)])

    result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, check=False)
    if result.stdout:
        print(result.stdout, end="")
    if result.stderr:
        print(result.stderr, end="", file=sys.stderr)
    if result.returncode != 0:
        return result.returncode

    print(f"Validated {len(fixture_dirs)} Plan2Agent fixture set(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
