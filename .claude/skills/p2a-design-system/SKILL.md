---
name: p2a-design-system
description: Use when designing or implementing Plan2Agent/P2A GUI screens, especially the PTY/Electron supervised execution console, task/run dashboard, artifact review, or dense developer-tool views.
---

# Plan2Agent Design System

Use this skill for P2A GUI work. The target product is an operator-grade desktop tool for supervising Plan2Agent planning artifacts, task execution, PTY sessions, approvals, verification, and run history. It should feel like a dense developer workbench, not a landing page or generic dashboard.

## Source Priority

1. **Harness is primary.** Read `references/harness/SKILL.md` and `references/harness/README.md` first. Use its warm dark shell, dot-character agent state, provider tints, mono metadata, `HarnessChrome`, and app-density rules as the visual source of truth.
2. **DevSync is secondary.** Read `references/devsync/SKILL.md` and `references/devsync/README.md` for tables, issue/task lists, kanban-style status, repository/file views, menus, modals, badges, and compact form controls.
3. **External systems are calibration only.** Do not copy their palettes or brand details. Use them to validate patterns:
   - Electron process model: main process owns native lifecycle/windows; renderer owns web UI; preload/IPC bridges privileged actions.
   - xterm.js and node-pty: terminal surface must support read/write/resize, flow, link handling, and clear permission boundaries.
   - VS Code UX guidelines: activity bar, sidebar, editor/workbench, panel, status bar, command palette, and context menus are the right mental model.
   - Primer, Atlassian Design, Carbon, and Radix: tokenized foundations, accessible primitives, consistent components, focus management, and keyboard navigation matter more than decorative styling.

Reference URLs checked on 2026-06-20: `https://www.electronjs.org/docs/latest/tutorial/process-model`, `https://xtermjs.org/docs/`, `https://github.com/microsoft/node-pty`, `https://code.visualstudio.com/api/ux-guidelines/overview`, `https://primer.style/`, `https://atlassian.design/`, `https://carbondesignsystem.com/`, `https://www.radix-ui.com/primitives/docs/overview/introduction`.

## Default P2A Shell

Use a workbench layout by default:

- Titlebar: project name, workspace path, active iteration/run, connection state, traffic-light controls when macOS chrome is mocked.
- Activity rail: 48px navigation for Overview, Artifacts, Tasks, Runs, Terminal, Settings.
- Primary sidebar: 260-300px for project/iteration selector, task graph outline, ready tasks, and recent runs.
- Main workbench: the active task/run surface. For execution screens, the PTY/xterm transcript is the primary object, not a card preview.
- Inspector: 320-360px for selected task details, acceptance criteria, dependencies, artifact links, tool calls, changed files, approvals, and verification results.
- Statusbar: 24px for branch, dirty state, run id, duration, token/cost count, cwd, and current gate/task state.

Acceptable variants are `operator`, `console`, `task graph`, `artifact review`, `settings`, and `run history`. Prefer the Harness `references/harness/variations/v1-operator.jsx` and `references/harness/variations/v2-console.jsx` patterns before inventing a new layout.

## Packaged References

- Harness components: `references/harness/design-system/harness.css`, `references/harness/design-system/atoms.jsx`, `references/harness/design-system/chrome.jsx`, `references/harness/design-system/dot-character.jsx`, `references/harness/design-system/mock-data.jsx`.
- Harness previews and screens: `references/harness/preview/`, `references/harness/screens/`, `references/harness/variations/`.
- DevSync primitives and app kit: `references/devsync/ui_kits/devsync-app/`.
- DevSync component examples: `references/devsync/preview/`.
- DevSync brand assets: `references/devsync/assets/`.

## Visual Rules

- Use Harness semantic tokens first: `var(--bg-*)`, `var(--fg-*)`, `var(--line-*)`, `var(--accent)`, and status/provider tokens. If using DevSync components, translate `--ds-*` intent into Harness tokens instead of mixing palettes.
- Keep the UI dark-first, warm, flat, and bordered. No pure black, pure white, gradients, glassmorphism, decorative orbs, large marketing hero blocks, or nested cards.
- Use NanumSquareNeo for labels/body/headings and JetBrains Mono for file paths, commands, task ids, run ids, timestamps, durations, token counts, costs, versions, and terminal text.
- Use compact sizes: 12-13px body/metadata, 28-32px controls, 36px rows, 4px spacing grid, and regular radii at 3-6px. Use larger radii only when already required by an existing Harness component.
- Accent is never a broad fill. Use it as 1px borders, 2px left stripes, focus rings, small state marks, or hover text.
- Represent agent state with `DotChar` states: `idle`, `thinking`, `typing`, `tool`, `skill`, `sleep`, `error`, `done`, `waiting`. Do not use generic spinners or progress bars for agent state.
- Provider tints are thin identity marks only: Claude `#D97757`, Codex `#A8B1A0`, Gemini `#6B9BB8`, Aider `#B89968`, Cursor `#C4BFAE`.
- Use text labels on commands. Icons may support labels, but icon-only buttons are allowed only for standard close/external/toolbar affordances with accessible labels and tooltips.

## P2A Product Patterns

- Project onboarding: first-run UI must distinguish `Open P2A Project`, `Install P2A`, `Import Plan`, `Upgrade Harness`, and `Repair / Validate`. For every mutating onboarding action, show target path, command preview, dry-run/confirmation state, and result log.
- Project detection: represent `No P2A`, `Installed empty`, `Planning in progress`, `Execution ready`, `Outdated harness`, and `Broken install` as compact factual states with one clear next action.
- Gate state: show Gate A/B/C/D as compact chips with current state, required approval, and canonical artifact links.
- Task execution: keep exactly one active task visually dominant. If parallel/sub-agent work appears later, show it as secondary lanes under the selected task/run, not as multiple equal primaries.
- Human supervision: every mutating command or external action must show command, cwd, target workspace, approval state, and captured output. Dangerous actions need an explicit review surface before execution.
- Terminal surface: terminal panes have stable dimensions, visible scrollback, linkable paths, resizable rows/cols, and clear separation between human input, agent output, tool calls, warnings, and verification output.
- Task detail: include task id, title, status, dependencies, acceptance criteria, implementation notes, affected files, verification command, run history, and blockers.
- Artifacts: show `status.md`, intake, spec, task graph, review, and run records as first-class navigable documents. Use mono paths and compact document metadata.
- Verification: show command, exit code, duration, log snippet, generated artifacts, and failure triage. Do not hide failed output behind a vague badge.
- Copy: calm engineer voice, sentence case, imperative button labels, no emoji, no exclamation marks, no feature-explainer text inside the app.

## Implementation Workflow

1. Inspect the target GUI stack before choosing components. If it is a static Harness prototype, use `references/harness/design-system/harness.css` and load scripts in this order: `references/harness/design-system/dot-character.jsx`, `references/harness/design-system/mock-data.jsx`, `references/harness/design-system/atoms.jsx`, `references/harness/design-system/chrome.jsx`, then the page script.
2. For full-window screens, wrap content in `HarnessChrome` or an equivalent P2A shell with the same density and titlebar behavior.
3. Reuse Harness components for shell, agent state, provider marks, and transcript rows. Reuse DevSync primitives for tables, badges, menus, modals, issue/task rows, and repository/file browser patterns when those surfaces are needed.
4. If building an Electron PTY GUI, keep process concerns visible in the UI model: renderer terminal, main-process run lifecycle, preload/IPC permissions, active cwd, environment, and stop/kill states.
5. Build responsive constraints explicitly: fixed rails, min/max sidebars, stable row heights, overflow handling, tabular numbers, and truncation for long paths/task ids.
6. Verify with screenshots or browser inspection when rendering UI. Check desktop and narrow widths for nonblank terminal content, no overlapping text, visible focus, usable resizing, and no layout shift from dynamic logs.

## Acceptance Checklist

- The screen clearly answers: which project, which artifact/gate, which task/run, what state, what next action.
- The PTY/transcript is readable, primary, and not visually buried.
- All colors come from semantic tokens except provider/status constants already defined by the system.
- Long paths, logs, task ids, and button labels do not overflow their containers.
- Keyboard focus, accessible labels, and tooltips exist for compact controls.
- Mutating actions expose target scope and approval/stop state.
- Design remains dense and work-focused, with no decorative marketing composition.
