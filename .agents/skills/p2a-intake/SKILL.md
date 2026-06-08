---
name: p2a-intake
description: Use when extracting requirements, assumptions, and clarification questions from a one-sentence Plan2Agent product idea.
---

# Plan2Agent Intake

Convert an early idea into structured planning input.

## Inputs

- One-sentence product or feature idea.
- Optional user notes.

## Output

Return:

- `summary`: one paragraph restating the idea.
- `known_facts`: facts stated by the user.
- `assumptions`: reasonable defaults that must be confirmed.
- `clarifying_questions`: the smallest set of high-impact questions.
- `needs_user_decision`: decisions that block a reliable spec.

## Rules

- Ask only questions that materially change product scope, data shape, UI flow, or implementation risk.
- Prefer defaults for low-risk details and label them as assumptions.
- Do not design the full implementation yet.
- Do not edit files or run commands.
