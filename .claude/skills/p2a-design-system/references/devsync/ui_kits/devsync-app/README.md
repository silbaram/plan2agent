# DevSync UI Kit — devsync-app

A pixel-leaning recreation of the DevSync product surface. The kit demonstrates the design system as it would appear in production: dense layouts, sharp chrome, slate + deep-blue palette, dark-mode by default with a light-mode toggle.

## Run it
Open `index.html` — it's a click-thru prototype. The left sidebar switches between four core screens:

1. **Dashboard** — high-density metrics, sparklines, activity timeline
2. **Issues** — searchable / filterable data table with bulk actions
3. **Board** — kanban with columns for Backlog → In Progress → Review → Done
4. **Repository** — file browser + file viewer (with syntax tokens)

## Files

- `index.html` — mounts the React app
- `app.jsx` — top-level layout + view router
- `primitives.jsx` — `Icon`, `Button`, `Badge`, `Avatar` (shared atoms)
- `Sidebar.jsx` — fixed 240px left nav
- `TopBar.jsx` — 48px top bar with breadcrumb + cmd-k + theme toggle
- `Dashboard.jsx` — overview with stat cards + chart + activity feed
- `Issues.jsx` — data table with filter chips, status pills, sortable cols
- `Kanban.jsx` — board with status columns + draggable-looking cards
- `Repo.jsx` — repo browser with file tree + file viewer
- `kit.css` — kit-specific styles (extends `../../colors_and_type.css`)

## What's fake
- Routing is plain useState — no real client router
- No drag/drop on the board, no real edit/save on issues
- "Search" and `⌘K` open a stub palette
- All data is hard-coded fixtures
