# Fix horizontal scroll at narrow viewports

## 1. Background
At viewport widths around 478px the page shows a horizontal scrollbar. Probing via headless Chrome at width 478 reports `documentElement.scrollWidth = 588`, i.e. ~110px of overflow.

## 2. Requirements Summary
Eliminate the horizontal scrollbar at narrow viewport widths without regressing the layout at md/lg breakpoints.

## 3. Acceptance Criteria
1. At viewport widths 320, 375, 414, 478, 500: `documentElement.scrollWidth <= clientWidth` (no horizontal scrollbar).
2. The hero, evidence chip, and CLI sections remain visually correct at those widths (content readable, no clipped headings).
3. No regression at >=768px.

## 4. Problem Analysis
Headless probe at width=478 found `scrollWidth=588`. Two structural causes inflate the body:

- **Evidence chip** at `public/index.html:216` — `<div class="mt-10 inline-flex ... whitespace-nowrap overflow-hidden">` is ~550px wide (four nowrap segments). Inside a `text-center` block with no `max-w-full`, so its intrinsic width pushes past the viewport. `overflow-hidden` on itself clips nothing because the chip *is* the wide element.
- **CLI section** at `public/index.html:613` — `grid lg:grid-cols-12` becomes a 1-column grid below `lg`. Grid items default to `min-width: auto = min-content`. The `<pre>` blocks (e.g. line 681 `helm cron add "0 9 * * *" "summarize yesterday's commits" \`) have wide intrinsic content that inflates the grid track despite `overflow-x-auto` on the `<pre>` itself, because the surrounding wrapper does not have `min-width: 0`.

The two octopus watermark SVGs (`public/index.html:524`, `:733`) extend past their parent on narrow screens, but their parent sections both have `relative overflow-hidden` so they do not contribute to document-level overflow.

## 5. Decision Log

**1. How to harden against future overflow regressions?**
- Options: A) chase each offender · B) global `body { overflow-x: clip }` · C) global `body { overflow-x: hidden }`
- Decision: **B)** — `clip` does not create a scroll container, so it does not break sticky positioning or `scroll-padding-top` (used at `src/styles.css:132`). One-line defensive guard.

**2. How to fix the evidence chip?**
- Options: A) allow wrap on narrow · B) `max-w-full overflow-x-auto` (internal scroll) · C) hide elements on narrow
- Decision: **B)** — the chip is a deliberate single-line CLI demonstration; wrapping would break the visual metaphor. Internal scroll preserves intent.

**3. How to fix CLI grid overflow?**
- Options: A) `min-w-0` on grid items · B) wrap `<pre>` content · C) reduce max line length
- Decision: **A)** — standard fix for the well-known grid/flex min-content overflow trap. Preserves the code samples verbatim.

## 6. Design
Three small edits:

1. `src/styles.css` — add `html, body { overflow-x: clip; }`.
2. `public/index.html:216` — swap `overflow-hidden` for `max-w-full overflow-x-auto`.
3. `public/index.html:614` and `:628` — add `min-w-0` to `lg:col-span-4` and `lg:col-span-8`.

Rebuild CSS via `bun run build:css`.

## 7. Files Changed
- `src/styles.css` — add defensive `overflow-x: clip` on html/body
- `public/index.html` — fix evidence chip to scroll internally; add `min-w-0` to CLI grid items
- `public/styles.css` — rebuilt output

## 8. Verification
1. [AC1, AC3] Run headless probe at widths 320/375/414/478/500/768/1024 — assert `scrollWidth <= clientWidth` for each.
2. [AC2] Spot-check evidence chip and CLI section at 478 — chip is internally scrollable, CLI tabs remain visible.
