# Fix in-page nav links from /changelog

## 1. Background
On `/changelog`, clicking the top-nav links `Features`, `CLI`, `Docs` (and several footer links) appears to do nothing. The same links work correctly when you are already on `/`.

## 2. Requirements Summary
The SPA router in `public/index.html` only intercepts anchors marked with `data-link`. Hash-only anchors like `href="#features"` bypass the router, so on `/changelog` the URL hash changes but the target section (which lives inside `<div data-route="/">`) is hidden by `.route-active`. The fix is to make hash links route back to `/` first, then scroll to the target.

## 3. Acceptance Criteria
1. On `/changelog`, clicking nav `Features` / `CLI` / `Docs` navigates to `/` and scrolls to the matching section.
2. On `/changelog`, footer links to `#features`, `#install`, `#docs` navigate to `/` and scroll to the matching section.
3. On `/`, hash links continue to scroll within the page (no regression).
4. After such a click the URL is `/#<anchor>` and the section is visible.

## 4. Problem Analysis
- **Approach A — Patch the click handler** to detect hash-only `href` and, when `location.pathname !== '/'`, route to `/` then `scrollIntoView`. -> Chosen. Single change point, no markup churn.
- **Approach B — Rewrite every hash link** to `/#features` and add `data-link`. -> Rejected. Touches many anchors across nav, footer, in-page CTAs; easy to miss new ones added later.
- **Approach C — Listen to `hashchange`** and force-route to `/`. -> Rejected. Implicit; couples routing to hash side-effects and fights with future legitimate hash uses on `/changelog`.

## 5. Decision Log

**1. Where to intercept hash links?**
- Options: A) Existing click handler · B) New `hashchange` listener · C) Modify every anchor
- Decision: **A)** — smallest diff, single source of truth for routing decisions.

**2. How to scroll after route switch?**
- Options: A) Set `location.hash` and rely on browser · B) Explicit `scrollIntoView`
- Decision: **B)** — `showRoute` previously called `window.scrollTo({ top: 0, behavior: 'instant' })` unconditionally, which would clobber the browser's native hash scroll. We refactor `showRoute` to own scroll behavior: top-scroll when no hash, `scrollIntoView` when a hash is supplied. Deterministic and single source of truth.

**3. Same-route hash clicks?**
- Options: A) Intercept and forward hash to `showRoute` · B) Let the browser default handle it
- Decision: **A)** — Revised in Phase 4 review. The existing `data-link` path now parses the hash out of the `href` and forwards it to `showRoute`. This gives us one scroll code path and as a side benefit fixes the existing bug where clicking a sidebar version link on `/changelog` scrolls to top instead of to the release header (because `changelogRendered` short-circuits the in-render hash scroll, and the old `showRoute` did `scrollTo(0)`).

## 6. Design

Two changes in `public/index.html`:

### (a) Make `showRoute` hash-aware

`showRoute` currently always calls `window.scrollTo({ top: 0, behavior: 'instant' })`, which clobbers any hash-anchor scroll. Move that scroll into the no-hash branch and add explicit `scrollIntoView` when a hash is supplied:

```js
function showRoute(path, hash) {
  const target = (path === '/changelog') ? '/changelog' : '/';
  routes.forEach(el => el.classList.toggle('route-active', el.getAttribute('data-route') === target));
  document.title = target === '/changelog' ? 'Helm — Changelog' : 'Helm — An always-on coding agent';
  const id = hash ? decodeURIComponent(hash.replace(/^#/, '')) : '';
  if (target === '/changelog') renderChangelog(); // already handles location.hash on first render
  if (id) {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
    // First cold load of /changelog#tag: articles don't exist yet because
    // renderChangelog is async. We rely on the invariant that callers
    // (click handler + bootstrap + popstate) update history BEFORE calling
    // showRoute, so renderChangelog can read location.hash directly at
    // index.html:1189-1192 once its fetch resolves.
  } else {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
}
```

### (b) Click handler — catch hash links off-route + reuse existing SPA path

```js
document.addEventListener('click', (e) => {
  // Selector widened from a[data-link] to a[href] so we can also intercept
  // bare hash links (#features, #cli, ...) when clicked off the home route.
  const a = e.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href');
  if (!href || href === '#') return; // placeholder link — no-op (e.g. footer "Legal")

  // Hash-only anchor clicked while off-route -> route home and scroll.
  if (href.startsWith('#') && location.pathname !== '/') {
    e.preventDefault();
    history.pushState({}, '', '/' + href); // href starts with '#', so '/' + '#x' === '/#x'
    showRoute('/', href);
    return;
  }

  // Existing SPA route link path.
  if (!a.matches('[data-link]')) return;
  if (href.startsWith('#') || href.startsWith('http')) return;
  e.preventDefault();
  history.pushState({}, '', href);
  const hashIdx = href.indexOf('#');
  const pathPart = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
  const hashPart = hashIdx >= 0 ? href.slice(hashIdx) : '';
  showRoute(pathPart, hashPart);
});
```

### (c) Bootstrap + popstate also pass the hash

```js
window.addEventListener('popstate', () => showRoute(location.pathname, location.hash));
showRoute(location.pathname, location.hash);
```

This also fixes: opening `/#features` directly or reloading after a hash click now scrolls to the section.

Notes:
- No `requestAnimationFrame` needed — `.route-active` toggle is a class change; the element has layout in the same task, so `scrollIntoView` is synchronous-correct.
- Same-route hash clicks on `/changelog` (sidebar tag links, permalink icons) now also scroll correctly because they go through the existing `data-link` path, which now forwards the hash to `showRoute`.
- `renderChangelog` already has its own hash-scroll on first render (index.html:1189-1192); we let it keep that behavior on cold load.

## 7. Files Changed
- `public/index.html` — patch the click handler (intercept off-route hash links and forward hash from `data-link` anchors), refactor `showRoute(path)` → `showRoute(path, hash)` to own scroll behavior, and pass `location.hash` from the bootstrap call and the `popstate` listener.

## 8. Verification
1. [AC1] On `/changelog`, click nav `Features`, `CLI`, `Docs` → URL becomes `/#features` / `/#cli` / `/#docs`, home route is visible, target section is in view.
2. [AC1+2] On `/changelog`, click the header `Install` button → URL becomes `/#install`, home route visible, install section in view.
3. [AC2] On `/changelog`, click footer `Features` (`#features`), `Download` (`#install`), and any of the four `Docs` sublinks (`#docs`) → same expected behavior.
4. [AC3] On `/`, click any nav hash link → page scrolls to the section (no JS error, no double-scroll). Click `Changelog` → still routes to `/changelog`.
5. [AC4] Reload `/#features` directly → home route visible and section in view at top.
6. Regression / side benefit — on `/changelog`, click a sidebar version link → URL becomes `/changelog#vX.Y.Z` and that release is at the top of the viewport.
7. Footer `Legal` (`href="#"`) click on `/changelog` → no navigation, no scroll, no error.
