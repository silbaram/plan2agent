---
name: devsync-design
description: Use this skill to generate well-branded interfaces and assets for DevSync — a high-density developer collaboration platform (dashboards, kanban boards, issue tracker, repository browser, data tables). Contains color + type tokens, fonts, icon conventions, voice guidelines, and a React UI kit. Apply whenever building DevSync product UI, marketing pages, slides, or throwaway prototypes.
user-invocable: true
---

# DevSync Design Skill

Read `README.md` first — it is the single source of truth for color, type, spacing, voice, and iconography. Then explore:

- `colors_and_type.css` — the entire token system as CSS variables (light + dark). Import this verbatim into anything you ship.
- `preview/` — small specimen cards demonstrating each token group. Skim these to internalise the visual language.
- `assets/` — DevSync logo, mark, and icon notes.
- `ui_kits/devsync-app/` — pixel-leaning recreation of the product surface (Dashboard, Issues, Board, Repository). The components there are correct examples of how the system composes in production.

## When to use this skill

- Designing or coding any **DevSync product screen** (dashboards, tables, modals, boards).
- Producing **marketing pages, slides, social cards, or docs** that should feel like the product.
- Building **throwaway prototypes** that need to feel professional-developer-grade.

## How to apply it

1. **Pull tokens, not hex codes.** Always reference `var(--ds-…)`, never inline brand colors. The token system handles light/dark automatically when you flip `data-theme="dark"`.
2. **Hit the density floor.** Default control height is 28px, body text is 13px, tables are 12px with tabular numerals. If something feels too small, you are probably in spec.
3. **Cap radius at 6px.** No pills except status dots and avatars.
4. **Stay quiet.** No gradients, no shadows on panels (use 1px borders), no emoji in product UI, no exclamation marks.
5. **Voice = a calm engineer.** Sentence case. Imperative buttons. Verbs over vibes. See "Content Fundamentals" in `README.md`.
6. **Reuse the kit.** Copy components from `ui_kits/devsync-app/` (`Button`, `Badge`, `Avatar`, `Icon`, `Status`, table styles, kanban card) instead of re-rolling them.

## Output formats

- **HTML artifacts** (slides, throwaway pages, single-screen mocks): link `colors_and_type.css`, set `data-theme="dark"` on `<html>`, and follow the kit's component patterns.
- **Production code**: copy the relevant tokens / components into the target stack. They are plain CSS variables and small React components with no dependencies beyond React itself + (optionally) Lucide for icons.

## Invocation without context

If invoked with no further instruction, ask what surface to build (product screen / slide / page / prototype), what data or copy to populate it with, and whether dark or light. Then design as an expert practitioner of this system.

## Caveats

- The DevSync codebase and Figma were not provided when this system was authored. Components are reasoned against the brief, not copied from production. Reconcile with the real product when access is available.
- **Geist** + **Geist Mono** are loaded from Google Fonts as the working font. If DevSync owns a different sans, drop `.woff2` files into `fonts/` and rewire `--ds-font-sans`.
- Icons are **Lucide** (CDN). Swap to the proprietary set when available.
