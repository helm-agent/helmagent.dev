# Landing-page perf overhaul (`public/index.html`)

## 1. Background

`public/index.html` is the marketing landing page for Helm, served as a static asset via Cloudflare Workers (`wrangler.jsonc`). The file is 1,558 lines / ~90 KB uncompressed and currently relies on three render-blocking third-party resources:

- `https://cdn.tailwindcss.com` — Tailwind's runtime JIT compiler (~70 KB JS, parses every class on the page at load).
- `https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap` — 8 font files via two third-party origins.
- A large inline `<script>` (lines 1200-1557) that wires SPA routing, theme toggle, copy buttons, an uptime ticker (`setInterval` 1 Hz), GitHub releases fetch, and several decorative animations — all run synchronously at load.

Result: render-blocking JS + 2 extra DNS+TLS handshakes for fonts + a 1 Hz timer running pre-paint. Lighthouse Performance on mobile is well below where a single-screen marketing landing should sit.

## 2. Requirements Summary

Make the page snappy and lean while keeping it visually substantively identical:
- Precompile Tailwind into a static CSS file via a one-shot build step (`bun run build`); drop the runtime CDN.
- Self-host the Geist / Geist Mono weights actually used (400, 500, 600); drop Google Fonts.
- Defer non-critical JS until after first paint / on idle / on interaction.
- Trim decorative animations whose cost is measurable, keep load-bearing ones.
- `wrangler deploy` of `public/` stays the deploy mechanism.

## 3. Acceptance Criteria

1. **Lighthouse mobile ≥ 95 (soft target).** Aim for ≥ 95 Performance on simulated 4G / Moto-G; treat as a directional gate, not a blocking one.
2. **No third-party requests during initial render** — no `cdn.tailwindcss.com`, no `fonts.googleapis.com`, no `fonts.gstatic.com` in the Network panel before the page is interactive. GitHub API for releases is allowed *after* idle / on `/changelog` only.
3. **No render-blocking third-party `<script>` or `<link rel="stylesheet">`** in `<head>`. Render-blocking CSS is exactly one local stylesheet (`/styles.css`).
4. **`bun run dev` and `wrangler deploy` continue to work.** Deploy artifact is still `public/`. The build is one command (`bun run build`) wired into the existing GHA deploy workflow before `wrangler-action`.
5. **Visual parity** — same content, layout, hierarchy, color tokens, Geist typography at 375 / 768 / 1280 px. Minor pixel-level diffs in font rendering / animation timing acceptable.
6. **Both routes work** (`/`, `/changelog`); theme toggle, copy buttons, reveal-on-scroll, uptime ticker, CLI tabs, permission-modes widget, kill-the-terminal demo, and GitHub releases fetch all function. Uptime ticker no longer runs pre-paint and pauses when off-screen.
7. **Materially smaller wire size** for the first visit to `/` — soft target ≤ ~60 KB transferred (HTML + CSS + JS + above-the-fold fonts, gzip/br), down from the current ~250 KB+ (Tailwind CDN + 8 font files dominate).
8. **`prefers-reduced-motion: reduce` continues to suppress non-essential animations.**

## 4. Problem Analysis

Approaches evaluated for removing the Tailwind CDN:

- **Approach A — Keep runtime Tailwind, tune around it** — preconnect, defer, `media="print"` swap. -> Doesn't address the ~70 KB JS or the runtime JIT cost. Rejected.
- **Approach B — Hand-rewrite every Tailwind utility into bespoke CSS** — strict zero-build. -> ~1,500 lines of Tailwind classes; would balloon inline `<style>` and is error-prone. Rejected.
- **Approach C — Precompile Tailwind to a static CSS file via `@tailwindcss/cli`** — one-shot build step, output served as `/styles.css`. -> Tree-shakes to only the utilities the HTML actually uses; tiny output; standard pattern. **Chosen.**

Approaches evaluated for fonts:

- **A — Self-host via `@fontsource/geist` + `@fontsource/geist-mono` woff2 files copied into `public/fonts/`** -> Standard, npm-managed, easy to subset weights. **Chosen.**
- **B — Drop custom fonts, use system sans/mono stack** -> Would change visual identity (violates AC 5). Rejected.
- **C — Keep Google Fonts but inline the CSS** -> Still hits Google for the woff2 files. Rejected.

Approaches evaluated for JS:

- **A — Leave inline IIFE at end of body as-is** -> Already at end of body, but the uptime ticker runs pre-paint and `renderRecent()` fires at the bottom unconditionally. Insufficient.
- **B — Wrap non-critical work in `requestIdleCallback` + gate uptime ticker on `IntersectionObserver`** -> Minimal-diff change; preserves all behavior; defers timers and GitHub fetch until the browser is idle. **Chosen.**
- **C — Split into multiple `<script type="module">` files with dynamic `import()` per feature** -> Adds files and HTTP requests for marginal benefit on a single-page site. YAGNI. Rejected.

## 5. Decision Log

**1. Build step shape**
- Options: A) Strict zero-build · B) `bun run build` precompile + commit output · C) `bun run build` precompile + run in CI, ignore output
- Decision: **C)** — `bun run build` runs in the existing GHA workflow before `wrangler-action`; `public/styles.css` and `public/fonts/` are git-ignored. Confirmed by user.

**2. Tailwind major version**
- Options: A) Tailwind v3 (PostCSS, `tailwind.config.js`) · B) Tailwind v4 (`@tailwindcss/cli`, CSS-first `@theme`)
- Decision: **B)** — Tailwind v4. Faster builds, single-file CSS-first config maps cleanly to the page's inline `tailwind.config = {...}` (lines 13-35); no need to maintain a parallel `tailwind.config.js`. Reversible if v4 misbehaves on any of the page's arbitrary-value classes (verification step 9 below covers class coverage).
- `dark:` utilities actually used: `dark:bg-ink-950/70`, `dark:bg-white/5`, `dark:block`, `dark:hidden` (5 occurrences; grep-verified). `@custom-variant dark (&:where(.dark, .dark *));` in `src/styles.css` makes these work against the existing `<html class="dark">` setup.

**3. CSS delivery: external file vs inline `<style>`**
- Options: A) Inline all CSS in `<style>` · B) External `<link rel="stylesheet" href="/styles.css">` · C) Critical inline + async external
- Decision: **B)** — external file. Cacheable across HTML revisions; single round-trip on Cloudflare's edge is negligible; KISS over C. Default; flag in Phase 4 if LCP measurement shows inlining critical CSS would push the page over the line.

**4. Font weight subset**
- Options: A) Match current Google Fonts request (5 + 3 = 8 files) · B) Subset to weights actually referenced (400/500/600 × 2 families = 6 files) · C) Aggressive subset (400/600 × 2 = 4 files)
- Decision: **B)** — 400/500/600 for both Geist and Geist Mono. Verified with:
  - `grep -oE 'font-[a-z]+' public/index.html | sort -u` → only `font-medium` (500), `font-semibold` (600), `font-mono`, plus `font-family`/`font-feature`/`font-weight`/etc. inside CSS.
  - `grep -nE "font-(bold|extrabold|light|thin|black)" public/index.html` → 0 matches.
  - `grep -nE "font-\[[0-9]+\]" public/index.html` → 0 matches (no arbitrary numeric weight classes).
  - Direct `font-weight: 500/600` declarations at lines 84, 135, 334. No 700/300/etc. anywhere.

**5. Font subset characters**
- Options: A) Full character set · B) Latin only via `unicode-range` (`@fontsource/geist/latin.css`)
- Decision: **B)** — page text is English only. `@fontsource/geist` ships a Latin subset.

**6. Theme bootstrap timing**
- Options: A) Keep theme detection inside the deferred IIFE · B) Tiny inline `<script>` at top of `<head>` to set `class="dark"` synchronously, defer the rest
- Decision: **B)** — must run before paint to prevent flash. The current page already sets `class="dark"` on `<html>` statically (line 2), so the only inline bootstrap needed is the localStorage override (5 lines).

**7. SPA route bootstrap timing**
- Options: A) Defer route resolution along with the rest of the JS · B) Inline-tiny synchronous route resolver in `<head>` to avoid both routes flashing
- Decision: **B)** — the page has two routes (`/`, `/changelog`); routes use `display: none` via CSS (line 138-139). The synchronous resolver is ~10 lines.

**8. Uptime ticker scheduling**
- Options: A) Keep `setInterval(tickUptime, 1000)` running forever · B) Start interval only when the hero section is on-screen via `IntersectionObserver`; stop when off-screen
- Decision: **B)** — eliminates background paint work + matches the pattern already used for the kill-the-terminal demo and reveal-on-scroll (lines 1342, 1379). Note: the secondary 60s ticker `#kt-daemon-uptime` (line ~1365) is NOT gated — it ticks once per minute, the cost is negligible, and gating it would add IO bookkeeping for no measurable win. KISS.

**9. GitHub releases fetch scheduling**
- Options: A) Fire at load · B) Fire after `requestIdleCallback` · C) Lazy until `/changelog` is opened
- Decision: **B)** — `renderRecent()` populates the "What's new" card on `/`; deferring it to idle keeps it visible without blocking paint. `renderChangelog()` already only runs on `/changelog` (line 1219).

**10. Animation cost trim**
- Options: A) Keep all animations · B) Replace `.pulse::after` box-shadow animation (paint-heavy) with `transform: scale + opacity` (compositor-only); leave others
- Decision: **B)** — `box-shadow` animations force per-frame paint. `transform`/`opacity` stay on the compositor. All other animations (orbit, sse-pulse, blink, reveal) already use `transform`/`opacity`/`left`/`top` which are cheap; left unchanged. Visual identity preserved.

**11. Build output location & gitignore**
- Options: A) Commit `public/styles.css` + `public/fonts/` · B) Gitignore both; CI builds them
- Decision: **B)** — matches the user's CI-build preference (Phase 1 user choice "Yes — add `bun run build`"). Adds 2 lines to `.gitignore`.

**12. Dev-server build coupling**
- Options: A) `dev` script auto-runs `bun run build` first · B) `dev` is just `wrangler dev`; one-time `bun run build` documented in README
- Decision: **B)** — KISS. Coupling `dev` to a full build forces rebuilds on every restart even when only HTML is being edited. The first-time setup story in the README explicitly tells the contributor to run `bun install && bun run build && bun run dev`. If anyone runs `bun run dev` without building, they see an unstyled page and a missing-file warning — clear failure mode that's faster to diagnose than a slow dev loop. Build artifacts are gitignored (Decision 11).

**13. Font preload set**
- Options: A) Preload Geist 400/500/600 only · B) Preload Geist 400/500/600 + Geist Mono 400 (hero contains mono content)
- Decision: **B)** — the hero terminal blocks (lines 477+) use `font-mono` for above-the-fold content; preloading at least Geist Mono 400 avoids FOUT on the most prominent visual. Mono 500/600 are not above the fold (verified: `grep -nE "font-mono.*font-(medium|semibold)|font-(medium|semibold).*font-mono" public/index.html` → 1 hit at line 1492, inside the `renderChangelog` template, which only renders on `/changelog`). Mono 500/600 swap-in is acceptable. Total: 4 woff2 preloads.

**14. CSS layer order in `src/styles.css`**
- Options: A) Custom CSS pasted before `@import "tailwindcss"` · B) Custom CSS unlayered and after `@import "tailwindcss"`
- Decision: **B)** — Tailwind v4 emits utilities inside `@layer utilities`. Per the CSS Cascade Layers spec, any unlayered rule beats any layered rule regardless of specificity, which is exactly the override semantics the existing `html:not(.dark) .text-teal { color: #b87015; }` rules rely on. **The only cascade-relevant rule is: custom CSS sits outside any `@layer` and after `@import "tailwindcss"`.** Ordering of `@theme`, `@custom-variant`, `@font-face` among themselves does not affect the cascade — they're either Tailwind-preprocessor directives (`@theme`, `@custom-variant`) or globally-scoped at-rules (`@font-face`).

**15. Route bootstrap mechanism**
- Options: A) New `html[data-route="…"]` selector mechanism · B) Reuse existing `.route-active` class on `[data-route]` elements (already wired by `showRoute()` at line 1214-1216 against existing CSS at lines 132-133)
- Decision: **B)** — one mechanism only. The end-of-body IIFE calls `showRoute(location.pathname)` at line 1231, which adds `.route-active` to the correct `[data-route]` element. Because the script has no `defer`/`async` and is followed only by `</body></html>`, it is parser-blocking and runs before first paint. **Invariant:** the end-of-body `<script>` must remain non-`defer`/non-`async`; do not move it to `<head>` and do not add `defer` or `async`. If that invariant ever needs to break, move route activation into the head theme bootstrap (it's a single `querySelector(...).classList.add(...)` call).

## 6. Design

### 6.1 File layout after the change

```
helmagent.dev/
├── public/
│   ├── index.html            # rewritten head; trimmed inline <style>; deferred JS
│   ├── styles.css            # GENERATED by `bun run build` (gitignored)
│   └── fonts/                # GENERATED, copied from @fontsource (gitignored)
│       ├── geist-400.woff2
│       ├── geist-500.woff2
│       ├── geist-600.woff2
│       ├── geist-mono-400.woff2
│       ├── geist-mono-500.woff2
│       └── geist-mono-600.woff2
├── src/
│   └── styles.css            # input: @import "tailwindcss" + @theme + @font-face + custom CSS
├── scripts/
│   └── copy-fonts.mjs        # 1-file Bun script: copies woff2 from node_modules → public/fonts
├── package.json              # + tailwindcss, @fontsource/geist, @fontsource/geist-mono
└── .github/workflows/deploy.yml  # + `bun run build` step
```

### 6.2 `src/styles.css` (Tailwind v4 input)

Structure (Decision 14): `@import "tailwindcss"` first; an explicit `@source "../public/**/*.html";` to lock down which HTML files Tailwind scans (no reliance on auto-detection — predictable and CI-friendly); `@theme` / `@custom-variant` / `@font-face` (order among these is not cascade-sensitive); then custom CSS unlayered at top level.

```css
@import "tailwindcss";
@source "../public/**/*.html";

@theme {
  --color-ink-50:  #f3f5f8;
  --color-ink-100: #e6e9ee;
  /* …all ink/paper/teal/amber/rose/violet tokens mirrored from the `tailwind.config = {...}` script in current public/index.html */

  --font-sans: 'Geist', ui-sans-serif, system-ui, sans-serif;
  --font-mono: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
}

/* Tailwind v4: class-based dark mode. Verified used: dark:bg-ink-950/70, dark:bg-white/5, dark:block, dark:hidden */
@custom-variant dark (&:where(.dark, .dark *));

@font-face {
  font-family: 'Geist';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('/fonts/geist-400.woff2') format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
/* …repeat for 500, 600, and Geist Mono 400/500/600. The `src: url('/fonts/geist-<weight>.woff2')` paths must match the `<link rel="preload" href="…">` URLs byte-for-byte (Decision 13). */

/* All custom CSS currently inside the inline `<style>...</style>` block in public/index.html moves here verbatim — grid-bg, hair, caret, reveal, tk-*, screen-bg, daemon-node, sse-*, pulse, chip, .md, etc. */

/* AC 6 / Decision 10: pulse uses transform+opacity for compositor-only animation */
.pulse::after {
  content: ""; position: absolute; inset: -3px; border-radius: 9999px;
  background: rgba(62,201,182,.5);
  animation: pulse-scale 2.2s ease-out infinite;
}
@keyframes pulse-scale {
  0%   { transform: scale(1);   opacity: .5; }
  80%  { transform: scale(2.5); opacity: 0; }
  100% { transform: scale(2.5); opacity: 0; }
}
```

### 6.3 `public/index.html` head rewrite

Replace, in this order, the following four runs of content in the current `<head>` (text-anchored, not line-numbered, so the edit is robust to file drift):

1. The two `<link rel="preconnect" href="https://fonts.…">` lines.
2. The `<link href="https://fonts.googleapis.com/css2?family=Geist…">` stylesheet.
3. The `<script src="https://cdn.tailwindcss.com">` line.
4. The `<script>tailwind.config = {…}</script>` block.
5. The entire inline `<style>…</style>` block.

…with:

```html
<link rel="stylesheet" href="/styles.css" />
<link rel="preload" as="font" type="font/woff2" href="/fonts/geist-400.woff2" crossorigin />
<link rel="preload" as="font" type="font/woff2" href="/fonts/geist-500.woff2" crossorigin />
<link rel="preload" as="font" type="font/woff2" href="/fonts/geist-600.woff2" crossorigin />
<link rel="preload" as="font" type="font/woff2" href="/fonts/geist-mono-400.woff2" crossorigin />
<script>
  // Theme bootstrap — must run before paint to prevent flash.
  try {
    if (localStorage.getItem('helm-theme') === 'light') {
      document.documentElement.classList.remove('dark');
    }
  } catch {}
</script>
```

Only theme bootstrap goes in `<head>` — it must run before CSS computes against `<html class="dark">`. Route activation stays in the existing end-of-body IIFE: `showRoute(location.pathname)` at line 1231 adds `.route-active` to the correct `[data-route]` element. The IIFE is parser-blocking (no `defer`/`async`) and is followed only by `</body></html>`, so it executes before paint. Route mechanism stays one-and-only-one: `.route-active` toggle on `[data-route]` elements (Decision 15). **Invariant: do not add `defer`/`async` to the end-of-body `<script>`.**

Font preload URLs match `@font-face src:` byte-for-byte (Decision 13). The `crossorigin` attribute matches the fetch mode browsers use for `@font-face` (anonymous CORS).

JS-disabled visitors: the existing `[data-route] { display: none; }` + `[data-route].route-active { display: block; }` rules will hide both routes when JS doesn't run. The current page has the same behavior (also JS-dependent for routing); we're not changing it. AC6 covers JS-enabled visitors only.

### 6.4 Deferred JS bottom

Two changes inside the IIFE at end of `<body>`:

- The synchronous IIFE keeps registering click listeners (theme, router, copy, CLI tabs, permission modes, replay) — already cheap.
- The uptime ticker is gated on `IntersectionObserver` (same pattern as the existing kill-the-terminal demo at line ~1342); the `setInterval` only starts when `#uptime-ticker` is visible, and is cleared when it leaves.
- `renderRecent()` moves into a `requestIdleCallback(..., { timeout: 2000 })` (with `setTimeout(..., 200)` fallback). It will run after the `load` event in practice (AC2 wording — see Section 8 step 2).

Concretely, in the existing IIFE replace the "Live uptime ticker" block (`tickUptime` definition + `tickUptime(); setInterval(tickUptime, 1000);`) with:

```js
const startMs = Date.now() - ((4*86400 + 3*3600 + 12*60 + 41) * 1000);
const ticker = document.getElementById('uptime-ticker');
function tickUptime() { /* unchanged body */ }
let uptimeTimer = null;
function startTicker() {
  if (uptimeTimer) return;
  tickUptime();
  uptimeTimer = setInterval(tickUptime, 1000);
}
function stopTicker() { if (uptimeTimer) { clearInterval(uptimeTimer); uptimeTimer = null; } }
if (ticker && 'IntersectionObserver' in window) {
  new IntersectionObserver((entries) => {
    for (const e of entries) e.isIntersecting ? startTicker() : stopTicker();
  }, { threshold: 0 }).observe(ticker);
} else if (ticker) {
  startTicker();
}
```

…and replace the trailing `renderRecent();` (last statement in the IIFE) with:

```js
const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
function deferRender() { idle(() => renderRecent(), { timeout: 2000 }); }
if (document.readyState === 'complete') deferRender();
else window.addEventListener('load', deferRender, { once: true });
```

The `load`-gated form guarantees ordering: the GitHub fetch never races first paint, so AC2 ("no third-party requests during initial render") holds unambiguously.

### 6.5 Build step (`package.json`)

```json
{
  "scripts": {
    "dev": "wrangler dev",
    "build": "bun run build:fonts && bun run build:css",
    "build:fonts": "bun scripts/copy-fonts.mjs",
    "build:css": "bunx @tailwindcss/cli -i src/styles.css -o public/styles.css --minify",
    "deploy": "bun run build && wrangler deploy"
  },
  "devDependencies": {
    "@fontsource/geist": "^5",
    "@fontsource/geist-mono": "^5",
    "@tailwindcss/cli": "^4",
    "tailwindcss": "^4",
    "wrangler": "^4.86.0"
  }
}
```

Notes:
- `dev` does NOT auto-build (Decision 12). First-time setup: `bun install && bun run build && bun run dev`. The README will spell this out.
- `build:css` invokes `bunx @tailwindcss/cli` (not bare `tailwindcss`) — in Tailwind v4 the CLI is in `@tailwindcss/cli` package; `bunx` resolves the bin reliably in both local dev and CI.
- `tailwindcss` (the package, not just the CLI) is also declared so the CLI's peer dependency is explicit.
- Exact versions will be locked by `bun.lock` once `bun install` runs.

### 6.6 `scripts/copy-fonts.mjs`

Tiny Bun script with an explicit allowlist of 6 source → destination pairs (no globs):

- `node_modules/@fontsource/geist/files/geist-latin-400-normal.woff2` → `public/fonts/geist-400.woff2`
- `node_modules/@fontsource/geist/files/geist-latin-500-normal.woff2` → `public/fonts/geist-500.woff2`
- `node_modules/@fontsource/geist/files/geist-latin-600-normal.woff2` → `public/fonts/geist-600.woff2`
- `node_modules/@fontsource/geist-mono/files/geist-mono-latin-400-normal.woff2` → `public/fonts/geist-mono-400.woff2`
- `node_modules/@fontsource/geist-mono/files/geist-mono-latin-500-normal.woff2` → `public/fonts/geist-mono-500.woff2`
- `node_modules/@fontsource/geist-mono/files/geist-mono-latin-600-normal.woff2` → `public/fonts/geist-mono-600.woff2`

For each pair: stat the source, fail with a clear message if missing, copy to destination. Any single missing source aborts the build with `exit(1)`. Exact paths only — a future `@fontsource` change is caught loudly rather than silently producing a fontless build.

### 6.7 GHA workflow

Add one step before `wrangler-action`:

```yaml
- run: bun run build
```

### 6.8 `.gitignore`

Add:
```
public/styles.css
public/fonts/
```

## 7. Files Changed

- `public/index.html` — remove Google Fonts links, runtime Tailwind CDN, inline `tailwind.config` script, large inline `<style>` block. Add `<link rel="stylesheet" href="/styles.css">`, 4 font preloads, tiny synchronous theme bootstrap. Inside the existing end-of-body IIFE: gate uptime ticker on `IntersectionObserver`; gate `renderRecent()` on `load` + `requestIdleCallback`.
- `src/styles.css` — NEW. Tailwind v4 input. Order: `@import "tailwindcss"` → `@theme` (ink/paper/teal/amber/rose/violet tokens + font families) → `@custom-variant dark` → 6 `@font-face` declarations → all custom CSS verbatim from current inline `<style>` (with the `.pulse::after` `box-shadow` animation swapped to `transform: scale + opacity` for compositor-only animation).
- `scripts/copy-fonts.mjs` — NEW. Copies 6 woff2 files from `@fontsource/{geist,geist-mono}` into `public/fonts/`. Exits non-zero on partial copy.
- `package.json` — add `tailwindcss`, `@tailwindcss/cli`, `@fontsource/geist`, `@fontsource/geist-mono` devDeps; add `build`, `build:fonts`, `build:css` scripts; `dev` unchanged (`wrangler dev`); `deploy` runs `bun run build && wrangler deploy`.
- `.github/workflows/deploy.yml` — add `- run: bun run build` step after `bun install` and before `cloudflare/wrangler-action@v3`.
- `.gitignore` — add `public/styles.css`, `public/fonts/`.
- `README.md` — update local-dev instructions: `bun install && bun run build && bun run dev`.

## 8. Verification

1. **[AC1] Lighthouse mobile ≥ 95 (soft).** After deploy, run `npx lighthouse https://helmagent.dev --preset=mobile --view`. Capture Performance score; aim ≥ 95.
2. **[AC2] No third-party requests before the `load` event.** DevTools Network panel, hard-reload `/`. Filter "Third-party requests". Expect zero entries with `startTime < load`. After load, the GitHub `api.github.com/.../releases` request may appear (via `requestIdleCallback`, gated on `load` per Section 6.4).
3. **[AC3] No render-blocking third-party in `<head>`.** `grep -E "cdn\\.tailwindcss\\.com|fonts\\.googleapis|fonts\\.gstatic" public/index.html` → 0 matches.
4. **[AC4] Build + deploy still work.** `bun install && bun run build && bun run dev` serves locally with built CSS. `bun run build && wrangler deploy --dry-run` succeeds. GHA workflow runs end-to-end on a test branch. Confirm `public/styles.css` and `public/fonts/*` all exist after build. The hard wire-size gate is AC7 (~60 KB total) — no per-file size assertion needed.
5. **[AC5] Visual parity.** Visually compare deployed page vs current production at 375 / 768 / 1280 px viewports. No content, hierarchy, or color regressions. Toggle theme and re-check.
6. **[AC6] Behavior parity.** Walk the page: toggle theme, click each CLI tab, click each permission-mode radio, watch kill-the-terminal demo cycle, click copy buttons (verify clipboard + "copied" feedback), navigate to `/changelog` (verify releases render), scroll the page (verify reveal transitions). For the uptime ticker: temporarily add a `console.log('tick')` inside `tickUptime`, scroll the hero out of view, and confirm logs stop within ~1s; scroll back, confirm they resume.
7. **[AC7] Wire size.** DevTools Network panel "transferred" total for `/` first visit (cleared cache): expect ≤ ~60 KB (HTML + styles.css + 4 preloaded fonts + inline JS).
8. **[AC8] Reduced motion.** Toggle "Emulate CSS prefers-reduced-motion: reduce" in DevTools Rendering. Verify orbit / sse-pulse / reveal animations stop. The blinking caret intentionally remains (load-bearing for the message).
9. **Tailwind class coverage spot-check.** Verify the high-risk Tailwind classes (uses of arbitrary values, opacity modifiers, `dark:`) actually produce CSS:
   - `grep -oE 'bg-(white|teal|ink-[0-9]+)/[0-9]+' public/styles.css | sort -u` → matches `bg-white/60`, `bg-white/5`, `bg-ink-950/70`, `bg-teal/10`, etc.
   - `grep -E 'dark:bg-ink-950/70|dark:bg-white/5|dark:block|dark:hidden' public/styles.css` → 4 hits.
   - `grep -E 'text-\[13\.5px\]|text-\[40px\]' public/styles.css` → both present.
   - If any class is missing, Tailwind's content scan missed it — check the explicit `@source "../public/**/*.html";` directive in `src/styles.css` (Section 6.2) and re-run `bun run build:css`.
10. **Font preload accounting.** DevTools Console after first paint: should see no "preloaded resource not used within a few seconds" warnings. If Geist Mono 500/600 emit warnings, that's fine — they're not preloaded (Decision 13), only swapped-in.
