---
name: harness-design-system
description: Use when designing or implementing Harness UI screens, prototypes, and components for the Electron-based AI CLI orchestrator, including settings, palettes, dashboards, modals, agent-state visualizations, dot-character states, provider tints, and native-feeling app chrome.
---

# Harness Design System — Skill Manifest

Use this design system when designing screens for **Harness**, the Electron-based AI CLI orchestrator (Codex / Claude Code / Gemini CLI / Aider hub).

## When to invoke

- Mocking up new Harness screens (settings, palettes, dashboards, modals)
- Adding components that need to feel native to the Harness app
- Iterating on agent-state visualizations using the dot-character system

## Always do

1. Link `design-system/harness.css` from every page
2. Load script order: `dot-character.jsx` → `mock-data.jsx` → `atoms.jsx` → `chrome.jsx` → page script
3. Wrap full-window screens in `<HarnessChrome>` for traffic-light + project-name title bar
4. Use `<DotChar state="..."/>` to represent any agent state — never a spinner, never a progress bar
5. Use semantic tokens only (`var(--bg-1)`, `var(--fg-2)`, `var(--accent)`)
6. Mono font for: shortcuts, timestamps, durations, token counts, costs, file paths, tool names
7. Sans (NanumSquareNeo) for: labels, body, headings

## Never do

- No emoji
- No exclamation marks
- No gradients, no glassmorphism
- No pure `#000` or pure `#FFF`
- No icon-only buttons (except `×` close, `↗` external)
- No accent color as a fill — only as 1px borders, 2px borderLeft, or text on hover

## Dot character vocabulary

States: `idle`, `thinking`, `typing`, `tool`, `skill`, `sleep`, `error`, `done`, `waiting`.
Sizes: 1.5 (sub-agent), 2 (row), 3 (chip), 6-8 (hero).

## Provider tints

Each AI provider has a 1px tint and a 1-letter monogram. Apply the tint **only** to: borderLeft of selected row, top border of agent card, ProviderMark border. Never as a fill.

| Provider | Hex | Mark |
|---|---|---|
| Claude | #D97757 | C |
| Codex | #A8B1A0 | O |
| Gemini | #6B9BB8 | G |
| Aider | #B89968 | A |
| Cursor | #C4BFAE | U |

See README.md for the full system.
