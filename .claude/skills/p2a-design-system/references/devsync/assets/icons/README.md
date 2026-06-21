# Icons

DevSync uses **[Lucide](https://lucide.dev)** (ISC license) as the icon system. Lucide is loaded via CDN — there are no local SVG files to copy.

## Usage

**Web Components / CDN:**
```html
<script src="https://unpkg.com/lucide@latest"></script>
<i data-lucide="git-branch"></i>
<script>lucide.createIcons();</script>
```

**CSS Font:**
```html
<link rel="stylesheet" href="https://unpkg.com/lucide-static@latest/font/lucide.css">
<i class="icon icon-git-branch"></i>
```

**Inline SVG (recommended for performance):**
```html
<svg width="16" height="16" stroke="currentColor" stroke-width="1.75" fill="none" viewBox="0 0 24 24">
  <!-- copied from lucide.dev -->
</svg>
```

## Conventions

- Default size **16px**, stroke **1.75** (overrides Lucide's 2px default for our denser scale)
- Color always `currentColor`
- 8px gap between icon and adjacent label
- Sit on the left of text in tables/lists
- Use filled variants only for selected sidebar / tab states

## ⚠️ Substitution note

This is a stand-in until DevSync's proprietary icon set is provided. Attach the real SVGs and we'll swap them in.
