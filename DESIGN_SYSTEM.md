# DESIGN_SYSTEM.md — FlipLedger UI

This is the design bible. Every component, every page, every pixel references this file. Read it before writing any CSS or JSX. If your output looks like a default Tailwind dashboard template or a shadcn starter kit, you have failed. FlipLedger should feel like a tool built by a designer who trades on Amazon, not a generic SaaS boilerplate.

---

## Aesthetic Direction

**Inspiration:** Linear.app, Raycast, Vercel Dashboard, Lemon Squeezy, Mercury (banking). Study what these have in common: depth without clutter, information density without chaos, dark themes that feel warm not cold, subtle gradients that catch the eye without distracting from data.

**Vibe:** Premium dark. Like a cockpit for money. The user stares at this app for hours — it should feel calm, confident, and sharp. Not sterile. Not playful. Not enterprise. Think "high-end trading terminal designed by someone with taste."

**The rule:** If you squint at a page and it looks like every other React dashboard on the internet — redesign it. Something on every page should make someone say "that's nice."

---

## Color System

Do NOT use Tailwind's default palette. These are the exact colors. Use CSS variables so the entire theme is swappable.

```css
:root {
  /* Backgrounds — layered depth system */
  --bg-root: #0a0a0c;           /* Deepest background — app shell */
  --bg-surface: #111114;         /* Cards, panels, sidebar */
  --bg-elevated: #18181c;        /* Modals, dropdowns, popovers */
  --bg-hover: #1e1e24;           /* Hover states on surfaces */
  --bg-active: #25252d;          /* Active/selected states */
  --bg-input: #111114;           /* Input fields */

  /* Borders — barely visible structure */
  --border-subtle: #1e1e24;      /* Default borders — cards, dividers */
  --border-default: #2a2a33;     /* Stronger borders — inputs, focused elements */
  --border-strong: #3a3a44;      /* Emphasis borders — active tabs, selected items */

  /* Text — high contrast hierarchy */
  --text-primary: #f0f0f3;       /* Headlines, important numbers */
  --text-secondary: #a0a0b0;     /* Body text, labels */
  --text-tertiary: #606070;      /* Placeholder, disabled, captions */
  --text-inverse: #0a0a0c;       /* Text on bright backgrounds */

  /* Brand accent — used sparingly */
  --accent: #6366f1;             /* Indigo — primary actions, active states */
  --accent-hover: #818cf8;       /* Lighter on hover */
  --accent-muted: rgba(99, 102, 241, 0.12);  /* Subtle backgrounds */
  --accent-glow: rgba(99, 102, 241, 0.25);   /* Focus rings, glows */

  /* Semantic colors — for data */
  --positive: #22c55e;           /* Profit, gains, success */
  --positive-muted: rgba(34, 197, 94, 0.12);
  --negative: #ef4444;           /* Loss, errors, alerts */
  --negative-muted: rgba(239, 68, 68, 0.12);
  --warning: #f59e0b;            /* Warnings, caution */
  --warning-muted: rgba(245, 158, 11, 0.12);
  --info: #3b82f6;               /* Informational, links */

  /* Chart palette — distinct, readable on dark bg */
  --chart-1: #6366f1;            /* Indigo */
  --chart-2: #22c55e;            /* Green */
  --chart-3: #f59e0b;            /* Amber */
  --chart-4: #ec4899;            /* Pink */
  --chart-5: #06b6d4;            /* Cyan */
  --chart-6: #a855f7;            /* Purple */
  --chart-7: #f97316;            /* Orange */

  /* Marketplace-specific colors — always consistent */
  --amazon: #ff9900;
  --walmart: #0071dc;
  --ebay: #e53238;

  /* Shadows — subtle depth */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.4);
  --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.5);
  --shadow-glow: 0 0 20px var(--accent-glow);

  /* Radii */
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;

  /* Transitions */
  --transition-fast: 120ms ease;
  --transition-default: 200ms ease;
  --transition-slow: 300ms ease;
}
```

### Color Rules
- **Never use pure white (`#fff`) for text.** `--text-primary` is the brightest anything gets. Pure white on dark backgrounds causes eye strain during long sessions.
- **Never use pure black (`#000`) for backgrounds.** `--bg-root` has a subtle blue-gray tint that feels less harsh.
- **Profit is always `--positive` (green). Loss is always `--negative` (red).** No exceptions. No other colors for financial positive/negative. The user needs to glance at a number and instantly know if it's good or bad.
- **Marketplace colors are sacred.** Amazon is always orange. Walmart is always blue. eBay is always red. These match the brands and the user already associates them this way.
- **The accent color is for interactive elements only.** Buttons, links, active states, focus rings. NOT decorative. NOT data. If accent is everywhere, nothing stands out.

---

## Typography

```css
:root {
  /* Font stack — Geist for that Vercel/Linear feel */
  --font-sans: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-mono: 'Geist Mono', 'SF Mono', 'Fira Code', 'Fira Mono', monospace;

  /* Scale — tight and dense for dashboard data */
  --text-xs: 0.6875rem;     /* 11px — fine print, timestamps */
  --text-sm: 0.75rem;       /* 12px — table cells, secondary labels */
  --text-base: 0.8125rem;   /* 13px — body text, primary labels */
  --text-md: 0.875rem;      /* 14px — emphasized body */
  --text-lg: 1rem;          /* 16px — section headers */
  --text-xl: 1.25rem;       /* 20px — page titles */
  --text-2xl: 1.5rem;       /* 24px — dashboard big numbers */
  --text-3xl: 2rem;         /* 32px — hero stats */

  /* Weight */
  --font-normal: 400;
  --font-medium: 500;
  --font-semibold: 600;
  --font-bold: 700;

  /* Line height */
  --leading-tight: 1.2;
  --leading-normal: 1.5;
  --leading-relaxed: 1.65;

  /* Letter spacing */
  --tracking-tight: -0.02em;    /* Headlines */
  --tracking-normal: 0;          /* Body */
  --tracking-wide: 0.04em;       /* All-caps labels */
}
```

Import Geist:
```html
<link href="https://cdn.jsdelivr.net/npm/geist@1.3.0/dist/fonts/geist-sans/style.min.css" rel="stylesheet">
<link href="https://cdn.jsdelivr.net/npm/geist@1.3.0/dist/fonts/geist-mono/style.min.css" rel="stylesheet">
```

### Typography Rules
- **Numbers are monospace.** Always. Financial figures, dates, percentages, quantities — all in `--font-mono`. This is functional: monospace numbers align vertically in tables and make columns scannable. It also looks sharp.
- **Big dashboard stats use `--font-bold` + `--tracking-tight` + `--text-3xl` or `--text-2xl`.** These are the first things the eye hits. Make them feel weighty.
- **Table headers are `--text-xs` + `--font-medium` + `--tracking-wide` + uppercase + `--text-tertiary`.** Small, quiet, structural. The data speaks, not the headers.
- **Don't mix too many sizes on one page.** A typical page uses 3-4 sizes max. More than that is visual noise.
- **Never use Inter, Roboto, Arial, or system-default sans-serif.** Geist or bust. It's what separates "designed" from "generated."

---

## Layout Patterns

### Sidebar Navigation
- Width: 240px (desktop), collapsible to 64px (icon-only), hidden with hamburger on mobile
- Background: `--bg-surface` with a 1px `--border-subtle` right border
- Logo/app name at top: `--text-lg` + `--font-semibold`
- Nav sections grouped with small uppercase labels ("ANALYZE", "BOOKKEEPING", "INVENTORY")
- Nav items: 32px height, `--radius-sm` rounded, `--text-sm`, icon + label
- Active item: `--bg-active` background + `--accent` left border (2px) + `--text-primary` text
- Hover: `--bg-hover` background
- Transition: `--transition-fast` on all state changes
- Bottom of sidebar: sync status ("Last synced 2h ago") + settings link

### Page Layout
```
┌─────────────────────────────────────────────┐
│ Page Title                    [Date Range ▾] │  ← Page header: 56px height
│ Subtitle / breadcrumb         [Filter] [Export]│
├─────────────────────────────────────────────┤
│                                             │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐      │  ← Stat cards row (if applicable)
│  │ Stat │ │ Stat │ │ Stat │ │ Stat │      │
│  └──────┘ └──────┘ └──────┘ └──────┘      │
│                                             │
│  ┌─────────────────────────────────────┐   │  ← Chart (if applicable)
│  │          Chart Area                  │   │
│  └─────────────────────────────────────┘   │
│                                             │
│  ┌─────────────────────────────────────┐   │  ← Data table
│  │  Search  │ Filters │     │ Export   │   │
│  ├─────────────────────────────────────┤   │
│  │  Column │ Column │ Column │ Column  │   │
│  │  data   │ data   │ data   │ data    │   │
│  │  ...    │ ...    │ ...    │ ...     │   │
│  └─────────────────────────────────────┘   │
│                                             │
└─────────────────────────────────────────────┘
```

- Page padding: 24px on all sides. 32px on large screens.
- Section gaps: 20px between stat cards and chart, 20px between chart and table.
- Max content width: none — dashboard pages should use full width. Data tables need room.
- Scroll: page scrolls, not individual sections (except the table body on very long datasets).

### Stat Cards
- Background: `--bg-surface`
- Border: 1px `--border-subtle`
- Radius: `--radius-lg`
- Padding: 20px
- Value: `--text-2xl` + `--font-bold` + `--font-mono` + `--text-primary`
- Label: `--text-xs` + `--font-medium` + `--tracking-wide` + uppercase + `--text-tertiary`
- Trend indicator: small `--text-xs` badge showing +/- % change from previous period, colored `--positive` or `--negative`
- Subtle top border gradient: 2px linear-gradient using `--accent` to transparent, or marketplace color — gives each card a premium touch

### Data Tables
This is the single most important component. The user will spend 80% of their time in tables. They must be fast, dense, and scannable.

- Background: `--bg-surface`
- Border: 1px `--border-subtle`, `--radius-lg`
- Header row: `--bg-elevated`, sticky, `--text-xs` uppercase, `--text-tertiary`, `--font-medium`
- Body rows: `--text-sm`, `--font-mono` for numbers, `--text-secondary` for text
- Row height: 40px — dense but not cramped
- Row hover: `--bg-hover`
- Row borders: 1px `--border-subtle` between rows
- Alternating row colors: NO. Hover highlight is enough. Zebra striping looks dated.
- Selected row: `--accent-muted` background
- Pagination: bottom of table, `--text-sm`, showing "1-50 of 1,234 results"
- Column resizing: grab handle on header border, cursor changes to col-resize
- Sort indicators: subtle arrow icon in header, `--text-tertiary` when inactive, `--text-primary` when active
- Totals row: sticky bottom, `--bg-elevated`, `--font-semibold`, separated by a 2px `--border-strong` top border. This row shows column totals for financial data. It must ALWAYS be visible.

### Charts (Recharts)
- Background: transparent (sits on the page background or inside a card)
- Grid lines: `--border-subtle`, dashed, 1px
- Axis labels: `--text-xs`, `--text-tertiary`, `--font-mono` for values
- Line charts: 2px stroke, rounded line joins, dot on hover only (not always visible)
- Bar charts: `--radius-sm` on top corners, 2px gap between bars
- Tooltips: `--bg-elevated` background, `--border-default` border, `--shadow-md`, `--radius-md`, `--text-sm`
- Legend: `--text-xs`, colored dots (not squares), positioned top-right or below chart
- Area under lines: gradient fill from line color at 20% opacity to transparent
- Animate on load: bars grow from bottom, lines draw left to right, 400ms ease-out

---

## Component Patterns

### Buttons
```
Primary:   bg: --accent        text: white          hover: --accent-hover     radius: --radius-md
Secondary: bg: --bg-elevated   text: --text-primary  hover: --bg-hover        border: --border-default
Ghost:     bg: transparent     text: --text-secondary hover: --bg-hover        no border
Danger:    bg: --negative-muted text: --negative      hover: bg --negative/20%
```
- Height: 32px (sm), 36px (md), 40px (lg)
- Padding: 12px horizontal (sm), 16px (md), 20px (lg)
- Font: `--text-sm`, `--font-medium`
- Transition: `--transition-fast` on background and border
- Focus ring: 2px `--accent-glow` outline, 2px offset
- Icons in buttons: 16px, 4px gap from text

### Inputs
- Height: 36px
- Background: `--bg-input`
- Border: 1px `--border-default`
- Radius: `--radius-md`
- Text: `--text-sm`, `--text-primary`
- Placeholder: `--text-tertiary`
- Focus: border becomes `--accent`, subtle `--shadow-glow`
- Padding: 10px horizontal

### Date Range Picker
- Looks like a button/input hybrid: shows the current range as text ("Last 30 days" or "Mar 1 – Mar 31, 2026")
- Click opens a dropdown with preset options (Today, 7d, 30d, This Month, Last Month, This Quarter, YTD, Custom)
- Custom opens a calendar
- Calendar: dark themed, `--bg-elevated`, current day highlighted with `--accent`, selected range has `--accent-muted` background fill
- This component appears on EVERY report page. Build it once, beautifully, and reuse it.

### Badges / Tags
- Small inline indicators for status, marketplace, category
- Height: 22px
- Padding: 6px horizontal
- Radius: `--radius-sm`
- Font: `--text-xs`, `--font-medium`
- Marketplace badges use marketplace colors on muted backgrounds:
  - Amazon: `--amazon` text on `rgba(255, 153, 0, 0.12)` bg
  - Walmart: `--walmart` text on `rgba(0, 113, 220, 0.12)` bg
  - eBay: `--ebay` text on `rgba(229, 50, 56, 0.12)` bg
- Status badges:
  - Profit: `--positive` text on `--positive-muted` bg
  - Loss: `--negative` text on `--negative-muted` bg

### Empty States
- When a page has no data (pre-sync, no results for filters):
- Centered in the content area
- Subtle icon (outline style, 48px, `--text-tertiary`)
- Headline: `--text-md`, `--text-secondary`
- Description: `--text-sm`, `--text-tertiary`
- CTA if applicable: primary button ("Sync Now", "Import Data", "Adjust Filters")
- Do NOT show a blank white/dark void. Every page must handle the empty state.

### Loading / Skeleton States
- Skeleton elements: `--bg-hover` background with a subtle shimmer animation (left-to-right gradient sweep)
- Match the EXACT layout of the loaded state — same heights, widths, positions
- Skeleton for stat cards: rectangle where the number goes, smaller rectangle for the label
- Skeleton for tables: rows of rectangles matching column widths
- Skeleton for charts: rectangle matching chart dimensions
- Animation: `@keyframes shimmer` — translateX from -100% to 100%, 1.5s infinite

```css
@keyframes shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
.skeleton {
  background: linear-gradient(
    90deg,
    var(--bg-hover) 25%,
    var(--bg-active) 50%,
    var(--bg-hover) 75%
  );
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
  border-radius: var(--radius-sm);
}
```

---

## Special Touches

These are the details that separate "built by AI" from "designed by a human." Apply them.

### 1. Gradient Top Bar on Cards
A thin (2px) gradient line across the top of stat cards and section cards. Uses `--accent` fading to transparent, or contextual colors (green for profit card, red for loss card, marketplace color for marketplace-specific cards). Barely visible but adds premium feel.

```css
.card-profit { border-top: 2px solid var(--positive); }
.card-loss { border-top: 2px solid var(--negative); }
.card-default { border-image: linear-gradient(to right, var(--accent), transparent) 1; }
```

### 2. Monochrome Icons with Color on Hover
Sidebar icons and table action icons are `--text-tertiary` by default. On hover, they transition to `--text-primary` or `--accent`. Subtle but alive.

### 3. Smooth Number Transitions
When switching date ranges or filters, big dashboard numbers should animate from old value to new value using a counting animation (like a slot machine). Not instant replacement. This makes the app feel responsive and alive.

```javascript
// Concept — use framer-motion or a counter hook
<AnimatedNumber value={totalProfit} duration={400} />
```

### 4. Contextual Row Coloring
In profitability tables, rows with negative profit get a barely-visible `--negative-muted` background tint. Not a harsh red row — just a 5-8% opacity wash. Enough to make losing products scannable at a glance without making the table look like a Christmas tree.

### 5. Micro-interactions on Filters
When a filter is applied and the table updates, add a brief (200ms) fade-in on the new data. Not a full page transition — just the table body content. Prevents the jarring "data just teleported" feel.

### 6. "Breathing" Sync Indicator
In the sidebar footer, the sync status has a small dot. When syncing: the dot pulses gently (opacity 0.4 → 1.0 → 0.4, 2s infinite). When idle: solid `--positive` dot. When error: solid `--negative` dot. When stale (>6 hours): `--warning` dot.

### 7. Totals Row Shadow
The sticky totals row at the bottom of tables gets a subtle upward shadow (`0 -4px 12px rgba(0,0,0,0.3)`) so it looks like it's floating above the scrolled data. This is what Linear does and it feels great.

---

## Anti-Patterns — Visual

These will make the app look AI-generated. Avoid all of them.

- **Purple gradient backgrounds.** The #1 tell of AI-generated UI. Our accent is indigo and it's used for interactive elements only, never as a decorative background gradient.
- **Rounded everything (border-radius: 9999px).** Pill shapes on cards and containers look juvenile. Use `--radius-md` (8px) and `--radius-lg` (12px). Reserve full rounding for small badges and avatars only.
- **Card shadows on dark backgrounds.** On dark themes, shadows are barely visible and add visual mud. Use borders (`--border-subtle`) for card definition instead. Reserve shadows for elevated elements (modals, dropdowns, tooltips).
- **Gradient text.** Never. Financial data is not a tech startup landing page.
- **Too many colors at once.** A dashboard page should be 90% neutral (grays/dark), 8% semantic (green/red for data), 2% accent (indigo for interactive). If the page looks colorful, something is wrong.
- **Fat padding on everything.** Dashboard UIs should feel dense and efficient. 20px card padding, 10px cell padding, 12px button padding. Not 32px everywhere.
- **Default Tailwind grays.** Tailwind's gray-800/gray-900 are a different tint than our custom palette. Use the CSS variables. Every time.
- **Centered body text.** Left-align everything except hero stats and empty states. Centered paragraphs of text look amateurish.
- **Icon-only buttons without tooltips.** If a button is icon-only, it needs a tooltip on hover. Otherwise it's a mystery meat navigation.
- **Scrollbars that don't match the theme.** Style the scrollbars dark. Webkit supports `::webkit-scrollbar` customization.

```css
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: var(--bg-root); }
::-webkit-scrollbar-thumb { background: var(--border-default); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--border-strong); }
```

---

## Tailwind Config

Override Tailwind defaults to match this design system exactly:

```javascript
// tailwind.config.js — key overrides (not exhaustive, Claude Code should complete this)
module.exports = {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: {
          root: '#0a0a0c',
          surface: '#111114',
          elevated: '#18181c',
          hover: '#1e1e24',
          active: '#25252d',
          input: '#111114',
        },
        border: {
          subtle: '#1e1e24',
          default: '#2a2a33',
          strong: '#3a3a44',
        },
        text: {
          primary: '#f0f0f3',
          secondary: '#a0a0b0',
          tertiary: '#606070',
        },
        accent: {
          DEFAULT: '#6366f1',
          hover: '#818cf8',
          muted: 'rgba(99, 102, 241, 0.12)',
        },
        positive: {
          DEFAULT: '#22c55e',
          muted: 'rgba(34, 197, 94, 0.12)',
        },
        negative: {
          DEFAULT: '#ef4444',
          muted: 'rgba(239, 68, 68, 0.12)',
        },
        amazon: '#ff9900',
        walmart: '#0071dc',
        ebay: '#e53238',
      },
      fontFamily: {
        sans: ['Geist', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['Geist Mono', 'SF Mono', 'Fira Code', 'monospace'],
      },
      borderRadius: {
        sm: '6px',
        md: '8px',
        lg: '12px',
        xl: '16px',
      },
      fontSize: {
        xs: '0.6875rem',
        sm: '0.75rem',
        base: '0.8125rem',
        md: '0.875rem',
        lg: '1rem',
        xl: '1.25rem',
        '2xl': '1.5rem',
        '3xl': '2rem',
      },
    },
  },
}
```

---

## Reference This File

When building any page, Claude Code should:
1. Check this file for the component pattern (table? stat card? chart?)
2. Use the exact CSS variables — not Tailwind defaults, not eyeballed values
3. Apply the special touches (gradient top bars, monospace numbers, contextual row colors)
4. Run the anti-pattern checklist before marking a page done

If a page looks like it was generated by ChatGPT or a shadcn template — it needs to be redesigned. This app should look like it cost $50K to design. It didn't, but it should look like it did.
