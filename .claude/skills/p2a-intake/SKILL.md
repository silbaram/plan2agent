---
name: p2a-intake
description: Use when extracting requirements, assumptions, and clarification questions from a one-sentence Plan2Agent product idea.
---

# Plan2Agent Intake

Convert an early idea into structured planning input.

## Inputs

- One-sentence product or feature idea.
- Optional user notes.
- Optional prior `intake_json` and newly answered decision ids when resuming.

## Output

Return an `intake_json` object conforming to `schemas/intake.schema.json` with:

- `schema_version`: `p2a.intake.v1`
- `idea`: original idea
- `summary`: one paragraph restating the idea
- `known_facts`: facts stated by the user
- `assumptions`: objects with `id`, `statement`, `risk`, and `confirmation_needed`
- `clarifying_questions`: objects with `id`, `question`, `why_it_matters`, and `blocks`
- `needs_user_decision`: objects with `id`, `question`, `options`, `impact`, `default`, `status`, and optional `answer`
- `evidence`: source objects with `source_id`, `title`, `url`, and `used_for`
- `status`: `blocked_on_user` when any decision is `open` or `deferred`, otherwise `ready_for_spec`

Also include a short Markdown table for open or deferred `needs_user_decision` items when `status` is `blocked_on_user`.

## Decision IDs

- Use stable ids like `ND-1`, `ND-2`, `CQ-1`, and `A-1`.
- Do not renumber existing ids during resume.
- Mark a decision `answered` only when the user's answer selects or clearly overrides an option.

## Rules

- Ask only questions that materially change product scope, data shape, UI flow, or implementation risk.
- Prefer defaults for low-risk details and label them as assumptions.
- Stop at intake when high-impact decisions remain open or deferred.
- Do not design the full implementation yet.
- If prior-art or domain lookup changes a question or assumption, add a `WEB-n` item to `evidence` and cite the source id in the rationale.
- Do not edit files or run commands.
