#!/usr/bin/env python3
"""Validate Plan2Agent JSON artifacts and golden fixtures with stdlib only.

The validator intentionally avoids third-party dependencies so every supported
CLI can run it. It implements the JSON Schema subset used by this repository and
adds workflow gate checks that are easier to express procedurally: unresolved
user decisions, approved-spec blocking, dependency references, duplicate task
ids, and dependency cycles.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATHS = {
    "intake": ROOT / "schemas" / "intake.schema.json",
    "spec": ROOT / "schemas" / "spec.schema.json",
    "task_graph": ROOT / "schemas" / "task-graph.schema.json",
}


class ValidationError(Exception):
    """Raised when a Plan2Agent artifact violates a schema or gate."""


def load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def validate_schema(instance: Any, schema: dict[str, Any], path: str = "$") -> None:
    """Validate the JSON Schema subset used in schemas/*.schema.json."""

    if "const" in schema and instance != schema["const"]:
        raise ValidationError(f"{path} must equal {schema['const']!r}")

    if "enum" in schema and instance not in schema["enum"]:
        raise ValidationError(f"{path} must be one of {schema['enum']!r}")

    expected_type = schema.get("type")
    if expected_type:
        type_map = {
            "object": dict,
            "array": list,
            "string": str,
            "boolean": bool,
        }
        if expected_type not in type_map:
            raise ValidationError(f"unsupported schema type {expected_type!r} at {path}")
        if not isinstance(instance, type_map[expected_type]):
            raise ValidationError(f"{path} must be {expected_type}")

    if isinstance(instance, str):
        if "minLength" in schema and len(instance) < schema["minLength"]:
            raise ValidationError(f"{path} must have length >= {schema['minLength']}")
        if "pattern" in schema and not re.match(schema["pattern"], instance):
            raise ValidationError(f"{path} must match pattern {schema['pattern']!r}")

    if isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            raise ValidationError(f"{path} must contain at least {schema['minItems']} item(s)")
        item_schema = schema.get("items")
        if item_schema:
            for index, item in enumerate(instance):
                validate_schema(item, item_schema, f"{path}[{index}]")

    if isinstance(instance, dict):
        required = schema.get("required", [])
        missing = [key for key in required if key not in instance]
        if missing:
            raise ValidationError(f"{path} missing required keys: {', '.join(missing)}")

        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            extras = [key for key in instance if key not in properties]
            if extras:
                raise ValidationError(f"{path} contains unsupported keys: {', '.join(extras)}")

        for key, value in instance.items():
            if key in properties:
                validate_schema(value, properties[key], f"{path}.{key}")


def validate_against_schema(path: Path, schema_name: str) -> dict[str, Any]:
    data = load_json(path)
    schema = load_json(SCHEMA_PATHS[schema_name])
    validate_schema(data, schema)
    return data


def validate_evidence(evidence: list[dict[str, Any]], label: str) -> None:
    source_ids = [item["source_id"] for item in evidence]
    if len(source_ids) != len(set(source_ids)):
        raise ValidationError(f"{label}.evidence source_id values must be unique")
    for item in evidence:
        if item["source_id"].startswith("WEB-") and not item.get("url", "").startswith(("http://", "https://")):
            raise ValidationError(f"{label}.evidence {item['source_id']} must include an http(s) url")


def validate_intake(path: Path) -> dict[str, Any]:
    data = validate_against_schema(path, "intake")
    validate_evidence(data["evidence"], "intake")

    unresolved_decisions = []
    for decision in data["needs_user_decision"]:
        if decision["status"] in {"open", "deferred"}:
            unresolved_decisions.append(decision["id"])
        if decision["status"] == "answered" and not decision.get("answer"):
            raise ValidationError(f"{decision['id']} is answered but has no answer")
        if decision["status"] in {"open", "deferred"} and decision.get("answer"):
            raise ValidationError(f"{decision['id']} is unresolved but has an answer")

    expected_status = "blocked_on_user" if unresolved_decisions else "ready_for_spec"
    if data["status"] != expected_status:
        raise ValidationError(
            f"intake.status must be {expected_status!r} when unresolved decisions are {unresolved_decisions!r}"
        )
    return data


def validate_spec(path: Path, intake_path: Path | None = None) -> dict[str, Any]:
    data = validate_against_schema(path, "spec")
    validate_evidence(data["evidence"], "spec")
    if data["approval"] == "approved" and data["open_decisions"]:
        raise ValidationError("approved specs must not contain open_decisions")

    if intake_path:
        intake = validate_intake(intake_path)
        intake_decisions = {decision["id"]: decision["status"] for decision in intake["needs_user_decision"]}
        unknown_decisions = [decision_id for decision_id in data["open_decisions"] if decision_id not in intake_decisions]
        if unknown_decisions:
            raise ValidationError(f"spec.open_decisions references unknown intake decisions: {unknown_decisions}")
        unresolved_decisions = {
            decision_id for decision_id, status in intake_decisions.items() if status in {"open", "deferred"}
        }
        spec_open_decisions = set(data["open_decisions"])
        if spec_open_decisions != unresolved_decisions:
            raise ValidationError(
                "spec.open_decisions must exactly match unresolved intake decisions: "
                f"expected {sorted(unresolved_decisions)!r}, got {sorted(spec_open_decisions)!r}"
            )
    return data


def validate_task_graph(path: Path, require_approved_spec: Path | None) -> None:
    data = validate_against_schema(path, "task_graph")
    if require_approved_spec:
        spec = validate_spec(require_approved_spec)
        if spec.get("approval") != "approved":
            raise ValidationError("task graph generation is blocked until spec.approval is approved")
        if spec.get("open_decisions"):
            raise ValidationError("task graph generation is blocked while spec.open_decisions is non-empty")

    tasks = data["tasks"]
    task_ids = [task["id"] for task in tasks]
    if len(task_ids) != len(set(task_ids)):
        raise ValidationError("task ids must be unique")
    task_id_set = set(task_ids)

    graph: dict[str, list[str]] = {}
    for task in tasks:
        unknown_dependencies = [dependency for dependency in task["dependencies"] if dependency not in task_id_set]
        if unknown_dependencies:
            raise ValidationError(f"{task['id']} has unknown dependencies: {unknown_dependencies}")
        graph[task["id"]] = list(task["dependencies"])

    detect_cycles(graph)


def detect_cycles(graph: dict[str, list[str]]) -> None:
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node: str, stack: list[str]) -> None:
        if node in visiting:
            cycle = " -> ".join(stack + [node])
            raise ValidationError(f"task graph contains a dependency cycle: {cycle}")
        if node in visited:
            return
        visiting.add(node)
        for dependency in graph[node]:
            visit(dependency, stack + [node])
        visiting.remove(node)
        visited.add(node)

    for node in graph:
        visit(node, [])


def validate_fixture_dir(path: Path) -> None:
    required = {
        "intake.blocked.json": lambda p: validate_intake(p),
        "intake.answered.json": lambda p: validate_intake(p),
        "spec.approved.json": lambda p: validate_spec(p, path / "intake.answered.json"),
        "task-graph.json": lambda p: validate_task_graph(p, path / "spec.approved.json"),
        "review-report.md": lambda p: None,
    }
    for filename, validator in required.items():
        artifact_path = path / filename
        if not artifact_path.exists():
            raise ValidationError(f"fixture {path} is missing {filename}")
        validator(artifact_path)


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate Plan2Agent artifact gates.")
    parser.add_argument("--intake", type=Path, help="Path to an intake JSON artifact.")
    parser.add_argument("--spec", type=Path, help="Path to a spec JSON artifact.")
    parser.add_argument("--task-graph", type=Path, help="Path to a task graph JSON artifact.")
    parser.add_argument("--require-approved-spec", type=Path, help="Spec JSON that must be approved before task graph validation passes.")
    parser.add_argument("--fixture-dir", type=Path, action="append", help="Path to a fixture directory containing golden artifacts.")
    args = parser.parse_args()

    try:
        if args.intake:
            validate_intake(args.intake)
        if args.spec:
            validate_spec(args.spec, args.intake)
        if args.task_graph:
            validate_task_graph(args.task_graph, args.require_approved_spec)
        for fixture_dir in args.fixture_dir or []:
            validate_fixture_dir(fixture_dir)
    except (OSError, json.JSONDecodeError, ValidationError) as exc:
        print(f"validation failed: {exc}", file=sys.stderr)
        return 1

    print("Plan2Agent artifact validation passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
