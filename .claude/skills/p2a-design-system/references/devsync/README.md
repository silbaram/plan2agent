# DevSync Design System

> A high-density, sharp, developer-focused design system for **DevSync** — a developer collaboration platform & project management tool for enterprise teams.

---

## What DevSync is

DevSync is a **developer collaboration platform** that puts a single workspace around the day-to-day work of engineering teams. Surfaces include:

- **Dashboards** with dense metrics, charts, and activity timelines
- **Kanban boards** for sprint and workflow management
- **Issue tracker** with deep filtering, bulk actions, and SLA states
- **Repository browser** (code + diff + blame views)
- **Data tables** with thousands of rows, freeze columns, inline edit

The audience is engineers and engineering managers. They live in this product all day, often on a second monitor. Everything is optimised for **scan-ability over decoration** and **reducing eye fatigue over long sessions**.

### Sources we worked from
- **Codebase**: *Not provided.* This system was built from the brief alone — no GitHub repo or Figma file was attached. Design language was informed by category leaders the brief points at (Linear, Vercel, GitHub, Datadog, Sentry) but no design is copied.
- **Brief** (Korean): "정보 밀도가 높고 깨끗하며 구조화된 레이아웃 … 모서리 곡률은 4px에서 6px 사이로 … 딥 블루 또는 슬레이트 그레이를 메인 컬러로 … 다크 모드 지원은 필수 … 작은 글자에서도 가독성이 높은 고딕 계열 폰트".

> ⚠️ **If you have the real codebase or Figma**, please attach them — components in `ui_kits/` are reasoned recreations against the brief, and the visual language should be reconciled against the real product.

---

## Index — what lives in this project

```
DevSync Design System/
├── README.md                  ← you are here
├── SKILL.md                   ← skill manifest for Claude Code / Agents
├── colors_and_type.css        ← all tokens (colors, type, spacing, radius, shadow, motion)
├── fonts/                     ← (Geist + Geist Mono load from Google Fonts at runtime)
├── assets/
│   ├── logo.svg               ← DevSync wordmark + glyph
│   ├── logo-mark.svg          ← square mark only
│   └── icons/                 ← Lucide icons (substituted — see ICONOGRAPHY)
├── preview/                   ← design-system tab cards
│   ├── colors-*.html
│   ├── type-*.html
│   ├── spacing-*.html
│   ├── components-*.html
│   └── brand-*.html
└── ui_kits/
    └── devsync-app/
        ├── README.md
        ├── index.html         ← interactive click-thru prototype
        ├── Sidebar.jsx
        ├── TopBar.jsx
        ├── Button.jsx
        ├── Badge.jsx
        ├── Table.jsx
        ├── Kanban.jsx
        ├── Dashboard.jsx
        ├── IssueDetail.jsx
        └── RepoBrowser.jsx
```

---

## CONTENT FUNDAMENTALS

DevSync copy is **flat, factual, and short**. It sounds like an engineer's commit message — never a marketer's headline.

### Tone
- **Calm and unenthused.** No exclamation marks, no "🎉 You did it!", no praise. The product trusts the user is competent.
- **Information over emotion.** Strings answer *what* and *how many*, then stop.
- **Verbs, not vibes.** "Merge", "Resolve", "Assign", "Reopen" — not "Get started", "Take it to the next level", "Let's go".

### Voice & person
- **Second person ("you") only when necessary.** Most surfaces don't address the user at all — they describe state.
- **No "we".** The product never talks about itself.
- **Imperative for buttons:** `New issue`, `Open in editor`, `Mark as duplicate`.

### Casing
- **Sentence case everywhere.** Buttons, menus, headers, dialog titles. Never Title Case.
  - ✓ `Create new issue`
  - ✗ `Create New Issue`
- **ALL CAPS** is reserved for `.ds-label` (small section headers like `OPEN ISSUES`, `MEMBERS`).
- **Code identifiers stay verbatim:** `useState`, `main`, `feat/auth-flow` — never sentence-cased.

### Numbers, dates, code
- **Tabular numerals** in tables and metrics (use `.ds-num`). `1,284,392` not `1 284 392`.
- **Relative time** in dense lists: `2m ago`, `3h`, `yesterday`, `Mar 14`. Full timestamps in tooltips.
- **Mono font for everything technical**: branch names, commit SHAs (always 7 chars `a3f9c12`), file paths, hex colors, IDs.

### Emoji
- **Avoid.** Never in product UI. The only exception is reactions on comments, which are user-generated.

### Examples (good vs. avoid)

| ✓ DevSync voice | ✗ Avoid |
|---|---|
| `12 issues need triage` | `🚨 Whoa, you've got 12 issues to triage!` |
| `Build failed · 2m ago` | `Uh oh, your build broke. Click here to investigate.` |
| `No items` | `Nothing here yet — why not create something?` |
| `Merged by chen.j into main` | `Awesome work! chen.j merged this into the main branch 🎉` |
| `Empty board. Create your first issue.` | `Looks like there's nothing here. Get started by creating an issue!` |

### Empty states
One short factual line + one action. No illustrations of cartoon characters. A small monochrome glyph at most.
> `No open issues match these filters. Clear filters`

### Error messages
- Lead with what failed. Then a fix.
- ✓ `Push rejected — branch protection requires 1 approving review. Request review`
- ✗ `Something went wrong! Please try again later.`

---

## VISUAL FOUNDATIONS

DevSync's visual language is **sharp, dense, and quiet**. It should feel like a piece of professional engineering software — closer to a terminal or trading screen than a consumer app.

### Color
- **Slate gray** is the foundation (95% of every surface). Light mode is built on `--slate-50/100/200`; dark mode on `--slate-900/950`.
- **Deep blue** (`--blue-600` light / `--blue-500` dark) is the *only* brand-saturated color. It signals interactivity: primary buttons, links, focus rings, selection. Used sparingly so it stays meaningful.
- **Semantic palette is fully separate from brand.** Green = success/passed, yellow = warning/pending, red = error/failed, purple = info/AI/draft state. These never mix with the brand blue.
- **Dark mode is the default surface** for the product. Light mode is fully supported and tokenised, but the design assumes engineers run dark.

### Typography
- **Geist** (sans) for all UI text; **Geist Mono** for code, IDs, branch names, commit SHAs, and tabular numbers.
- Base body size is **13px** — DevSync is a dense product. Most data-table rows render at 12px with tabular numerals.
- Headlines use tight tracking (`-0.02em`). Body uses normal. Labels use wide (`0.04em`) + uppercase.
- Hierarchy is built with **weight and color**, not size. `fg-1 / 600` for emphasis, `fg-2 / 400` for body, `fg-3 / 400` for meta.

### Backgrounds
- **Flat surfaces, no gradients on UI.** A `--ds-bg-1` page on a `--ds-bg-2` panel separated by a 1px `--ds-border-1`. That's the entire vocabulary.
- **No textures, no patterns, no illustrations** behind product chrome. The only place a gradient appears is occasional brand marketing/login splash.
- **Full-bleed imagery is rare** — used only on auth pages and empty product onboarding. Imagery vibe when it appears: cool, blue-toned, low contrast, slight grain — never warm or saturated.

### Spacing & density
- Built on a **4px grid** (`--ds-space-1` = 4px). Most layouts use 8/12/16/24.
- **Default control height is 28px.** Compact rows are 24px. This is small by web-design standards — that's intentional.
- Table rows are 36px. Sidebar items 28px. Top bar 48px.

### Radii — sharp, never soft
- `--ds-radius-xs` (2px), `--ds-radius-sm` (4px), `--ds-radius-md` (6px) — full stop.
- 6px is the absolute ceiling. Buttons, inputs, cards, modals all use 4–6px. **Never** pill-shaped UI except for status dots and avatars.

### Borders
- **1px borders are the primary divider.** DevSync prefers a hairline border over a shadow.
- Border color in light: `--slate-200`. In dark: `--slate-800`.
- Panels usually have a border + zero shadow. Floating menus get `--ds-shadow-md` AND a 1px border.

### Shadows
- **Used sparingly.** Cards and panels = no shadow, just a border.
- Shadows appear only on **elevated** elements: popovers, dropdowns, modals, toasts.
- Inset shadow (`--ds-shadow-inset`) gives buttons a subtle 1px top highlight in dark mode.

### Cards
- Background = `--ds-bg-2`. Border = `1px solid --ds-border-1`. Radius = `--ds-radius-md`.
- No shadow at rest. Hovering a card row may shift bg to `--ds-bg-3`.
- Padding = 16px (compact) or 20px (default).

### Hover / press states
- **Hover** on text buttons & rows: background shifts up one step (`bg-1` → `bg-3`). Icon-only buttons darken to `--ds-bg-4`.
- **Hover** on filled primary: background → `--ds-accent-2` (one step darker).
- **Press**: background → `--ds-accent-3`, no scale. We do **not** shrink-on-press.
- **Focus**: `--ds-shadow-focus` (3px translucent blue ring). Always visible for keyboard users.

### Transparency & blur
- Only used in **floating chrome**: command palette, modal backdrop, sticky table headers.
- Backdrop blur on modal overlay: `backdrop-filter: blur(8px); background: rgba(15,23,42, 0.5)`.
- Tooltips & popovers are **opaque** — never translucent. Readability over showmanship.

### Motion
- **Fast and functional.** `--ds-dur-fast` (100ms) for hover, `--ds-dur-base` (160ms) for state changes, `--ds-dur-slow` (240ms) for layouts.
- Easing: `--ds-ease` (`cubic-bezier(0.2, 0.8, 0.2, 1)`). Never bounce, never elastic.
- Most transitions affect `background-color`, `border-color`, `opacity`. Never `transform: scale()` on the whole element. Caret blink in editors stays at 530ms.

### Charts & data viz
- Categorical palette (`--ds-chart-1..6`) ordered for hue-distinct legibility.
- Grids and axes use `--ds-border-1`. Axis labels use `--ds-fg-3` + `.ds-meta` (11px mono for numbers).
- Hover state: a 1px dashed crosshair + an opaque tooltip card with `--ds-shadow-md`.
- Sparklines render at 12-16px height inside table rows.

### Layout rules
- **Fixed top bar (48px) + fixed sidebar (240px)**. Both have `--ds-border-1` on their inner edge.
- Main content area scrolls; sidebars do not (their content scrolls inside).
- Max content width: usually unbounded (the product is dense; wide screens fill).
- Breadcrumb lives in the topbar, not above the content.

---

## ICONOGRAPHY

DevSync uses **outline-style line icons at 16px / 1.5px stroke** as the default. Filled variants are reserved for selected/active state on tabs and sidebar items.

### Icon set used in this system
We use **[Lucide](https://lucide.dev)** as a stand-in for DevSync's icons (apache-licensed, available via CDN). Lucide matches the brief's "sharp, professional" feel: 24×24 grid, 2px stroke (we render at 16px so the effective weight is right), square caps, geometric.

> ⚠️ **Substitution flag.** If DevSync has a proprietary icon set or different stroke weight, please attach the SVG files and we will swap them in.

### How icons are used
- **Default size**: 16px in product chrome, 14px in dense rows, 20px in empty states, 12px in pills.
- **Color**: always `currentColor` — they inherit `--ds-fg-2` from their button/row context and `--ds-fg-1` on hover.
- **Stroke is preserved** — never fill an outline icon to make it "pop".
- **In tables/lists** they always sit on the left of text, separated by 8px.
- **Status icons** (`circle`, `circle-check`, `circle-alert`, `circle-x`) override `currentColor` with their semantic color — these are the only icons that escape `fg-*`.

### Usage in this project
- CDN: `<link rel="stylesheet" href="https://unpkg.com/lucide-static@latest/font/lucide.css">` or `<script src="https://unpkg.com/lucide@latest"></script>`
- Inline use in JSX components: `<i data-lucide="git-branch"></i>` then `lucide.createIcons()`.

### Other glyph sources
- **Emoji**: never in product UI. Allowed only in user-generated content (comments, reactions).
- **Unicode symbols**: allowed for keyboard shortcuts in tooltips and the command palette — `⌘`, `⌥`, `⇧`, `⏎`, `␣`, `←↑→↓`. Always rendered in `var(--ds-font-mono)`.
- **Branded SVGs** (GitHub, GitLab, Slack logos, language logos) are inlined per-need from the official brand assets, not redrawn.

### Logo
- The DevSync wordmark sits in `/assets/logo.svg`. The standalone glyph is `/assets/logo-mark.svg`. Both are flat SVG, single-color (`currentColor`), so they invert cleanly between modes.

---

## Tokens at a glance

```css
/* Backgrounds (dark mode example) */
--ds-bg-1: #060A14;  /* page */
--ds-bg-2: #0F172A;  /* panel */
--ds-bg-3: #1E293B;  /* hover */
--ds-bg-4: #334155;  /* pressed */

/* Brand */
--ds-accent-1: #3B6FF6;

/* Status */
--ds-success-1: #22C55E;
--ds-warning-1: #FACC15;
--ds-danger-1:  #F87171;

/* Type */
--ds-font-sans: 'Geist', system-ui, sans-serif;
--ds-font-mono: 'Geist Mono', ui-monospace, monospace;

/* Radius — capped at 6 */
--ds-radius-sm: 4px;
--ds-radius-md: 6px;
```

---

## ⚠️ Caveats & open questions

- **No codebase / Figma was provided.** Components are designed to the brief; iterate with the real product side-by-side.
- **Fonts**: We default to **Geist** (Vercel, OFL) loaded from Google Fonts. If DevSync owns a different sans (IBM Plex, Inter, JetBrains, custom), drop the `.ttf`/`.woff2` files into `fonts/` and we'll wire it up.
- **Icons** are Lucide as a stand-in — flagged above.
- **Logo** is a placeholder mark designed to fit the system. Replace with the real DevSync logo when available.
