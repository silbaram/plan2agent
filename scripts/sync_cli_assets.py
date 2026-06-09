#!/usr/bin/env python3
"""Generate Plan2Agent CLI mirrors from canonical .agents sources.

Canonical sources:
- .agents/skills/<name>/SKILL.md
- .agents/agents/<name>.md with CLI-neutral frontmatter:
  name, description, capabilities, access, tier

Generated mirrors:
- .claude/skills/<name>/SKILL.md
- .claude/agents/<name>.md
- .gemini/agents/<name>.md
- .codex/agents/<name>.toml

Run without flags to update mirrors. Run with --check in CI to fail on drift.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SKILL_SOURCE = ROOT / ".agents" / "skills"
AGENT_SOURCE = ROOT / ".agents" / "agents"
CAPABILITY_VALUES = {"read", "search", "web"}
ACCESS_VALUES = {"read-only"}
TIER_VALUES = {"light", "standard", "heavy"}
CLAUDE_TOOL_MAP = {
    "read": ["Read"],
    "search": ["Grep", "Glob"],
    "web": ["WebSearch", "WebFetch"],
}
GEMINI_TOOL_MAP = {
    "read": ["read_file"],
    "search": ["grep_search"],
    "web": ["google_web_search"],
}
CLAUDE_TIER_MODEL = {"light": "haiku", "standard": "sonnet", "heavy": "opus"}
CODEX_TIER_EFFORT = {"light": "low", "standard": "medium", "heavy": "high"}
GEMINI_TIER_CONFIG = {
    "light": {"temperature": 0.1, "max_turns": 6},
    "standard": {"temperature": 0.2, "max_turns": 10},
    "heavy": {"temperature": 0.2, "max_turns": 20},
}


@dataclass(frozen=True)
class RenderedFile:
    path: Path
    content: str | bytes
    binary: bool = False


def parse_frontmatter_scalar(lines: list[str], index: int, raw_value: str) -> tuple[str, int]:
    value = raw_value.strip()
    if value in {"|", ">"}:
        collected: list[str] = []
        index += 1
        while index < len(lines):
            line = lines[index]
            if line and not line.startswith((" ", "\t")):
                break
            collected.append(line[2:] if line.startswith("  ") else line.lstrip())
            index += 1
        separator = "\n" if value == "|" else " "
        return separator.join(collected).strip(), index
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        value = value[1:-1]
    return value, index + 1


def parse_frontmatter_list(lines: list[str], index: int) -> tuple[list[str], int]:
    values: list[str] = []
    index += 1
    while index < len(lines):
        line = lines[index]
        stripped = line.strip()
        if not stripped:
            index += 1
            continue
        if not line.startswith((" ", "\t")):
            break
        if not stripped.startswith("-"):
            raise ValueError(f"unsupported list item line: {line!r}")
        value = stripped[1:].strip()
        if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
            value = value[1:-1]
        values.append(value)
        index += 1
    return values, index


def parse_agent_markdown(path: Path) -> tuple[dict[str, Any], str]:
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise ValueError(f"{path} must start with YAML frontmatter")

    closing_index = next((index for index, line in enumerate(lines[1:], start=1) if line.strip() == "---"), None)
    if closing_index is None:
        raise ValueError(f"{path} must close YAML frontmatter with ---")

    frontmatter_lines = lines[1:closing_index]
    body = "\n".join(lines[closing_index + 1 :]).lstrip("\n")
    if text.endswith("\n") and body:
        body += "\n"

    meta: dict[str, Any] = {}
    index = 0
    while index < len(frontmatter_lines):
        line = frontmatter_lines[index]
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            index += 1
            continue
        if line.startswith((" ", "\t", "-")):
            raise ValueError(f"unexpected indented/list line outside a key in {path}: {line!r}")
        if ":" not in line:
            raise ValueError(f"unsupported frontmatter line in {path}: {line!r}")
        key, raw_value = line.split(":", 1)
        key = key.strip()
        if raw_value.strip() == "":
            value, index = parse_frontmatter_list(frontmatter_lines, index)
        else:
            value, index = parse_frontmatter_scalar(frontmatter_lines, index, raw_value)
        meta[key] = value

    validate_neutral_metadata(path, meta)
    return meta, body


def validate_neutral_metadata(path: Path, meta: dict[str, Any]) -> None:
    required = {"name", "description", "capabilities", "access", "tier"}
    missing = sorted(required - set(meta))
    if missing:
        raise ValueError(f"{path} missing neutral frontmatter keys: {', '.join(missing)}")
    forbidden = {"tools", "model"} & set(meta)
    if forbidden:
        raise ValueError(f"{path} contains target-specific frontmatter keys: {', '.join(sorted(forbidden))}")
    if not isinstance(meta["capabilities"], list) or not meta["capabilities"]:
        raise ValueError(f"{path} capabilities must be a non-empty list")
    unknown_capabilities = sorted(set(meta["capabilities"]) - CAPABILITY_VALUES)
    if unknown_capabilities:
        raise ValueError(f"{path} has unknown capabilities: {', '.join(unknown_capabilities)}")
    if meta["access"] not in ACCESS_VALUES:
        raise ValueError(f"{path} access must be one of {sorted(ACCESS_VALUES)}")
    if meta["tier"] not in TIER_VALUES:
        raise ValueError(f"{path} tier must be one of {sorted(TIER_VALUES)}")


def toml_basic_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def toml_literal_multiline(value: str, label: str) -> str:
    if "'''" in value:
        raise ValueError(f"{label} cannot contain triple single quotes for TOML literal multiline output")
    return "'''\n" + value.rstrip() + "\n'''"


def expand_capabilities(capabilities: list[str], mapping: dict[str, list[str]]) -> list[str]:
    tools: list[str] = []
    for capability in capabilities:
        for tool in mapping[capability]:
            if tool not in tools:
                tools.append(tool)
    return tools


def render_markdown_agent(meta: dict[str, Any], body: str, *, target: str) -> str:
    capabilities = meta["capabilities"]
    lines = ["---", f"name: {meta['name']}", f"description: {meta['description']}"]
    if target == "claude":
        lines.append("tools:")
        lines.extend(f"  - {tool}" for tool in expand_capabilities(capabilities, CLAUDE_TOOL_MAP))
        lines.append(f"model: {CLAUDE_TIER_MODEL[meta['tier']]}")
    elif target == "gemini":
        lines.append("kind: local")
        lines.append("tools:")
        lines.extend(f"  - {tool}" for tool in expand_capabilities(capabilities, GEMINI_TOOL_MAP))
        tier_config = GEMINI_TIER_CONFIG[meta["tier"]]
        lines.append(f"temperature: {tier_config['temperature']}")
        lines.append(f"max_turns: {tier_config['max_turns']}")
    else:
        raise ValueError(f"unknown markdown target {target}")
    lines.append("---")
    return "\n".join(lines) + "\n\n" + body.lstrip("\n")


def render_codex_agent(meta: dict[str, Any], body: str) -> str:
    return (
        f'name = {toml_basic_string(meta["name"])}\n'
        f'description = {toml_basic_string(meta["description"])}\n'
        f'model_reasoning_effort = "{CODEX_TIER_EFFORT[meta["tier"]]}"\n'
        'sandbox_mode = "read-only"\n'
        'developer_instructions = ' + toml_literal_multiline(body, str(meta["name"])) + '\n'
    )


def desired_files() -> list[RenderedFile]:
    files: list[RenderedFile] = []
    for source in sorted(SKILL_SOURCE.glob("*/SKILL.md")):
        relative = source.relative_to(SKILL_SOURCE)
        content = source.read_bytes()
        files.append(RenderedFile(ROOT / ".claude" / "skills" / relative, content, binary=True))

    for source in sorted(AGENT_SOURCE.glob("*.md")):
        meta, body = parse_agent_markdown(source)
        files.append(RenderedFile(ROOT / ".claude" / "agents" / source.name, render_markdown_agent(meta, body, target="claude")))
        files.append(RenderedFile(ROOT / ".gemini" / "agents" / source.name, render_markdown_agent(meta, body, target="gemini")))
        files.append(RenderedFile(ROOT / ".codex" / "agents" / f"{meta['name']}.toml", render_codex_agent(meta, body)))
    return files


def write_or_check(rendered: RenderedFile, check: bool) -> list[str]:
    expected = rendered.content if rendered.binary else str(rendered.content).encode("utf-8")
    if isinstance(expected, str):
        expected_bytes = expected.encode("utf-8")
    else:
        expected_bytes = expected

    if check:
        if not rendered.path.exists():
            return [f"missing generated file {rendered.path.relative_to(ROOT)}"]
        if rendered.path.read_bytes() != expected_bytes:
            return [f"generated file drift {rendered.path.relative_to(ROOT)}"]
        return []

    rendered.path.parent.mkdir(parents=True, exist_ok=True)
    rendered.path.write_bytes(expected_bytes)
    return []


def main() -> int:
    parser = argparse.ArgumentParser(description="Sync Plan2Agent CLI assets from .agents sources.")
    parser.add_argument("--check", action="store_true", help="Fail if generated files are out of date.")
    args = parser.parse_args()

    errors: list[str] = []
    try:
        for rendered in desired_files():
            errors.extend(write_or_check(rendered, args.check))
    except (OSError, ValueError) as exc:
        print(f"sync failed: {exc}", file=sys.stderr)
        return 1

    if errors:
        for error in errors:
            print(f"sync failed: {error}", file=sys.stderr)
        return 1

    print("Plan2Agent CLI assets are in sync" if args.check else "Plan2Agent CLI assets synced")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
