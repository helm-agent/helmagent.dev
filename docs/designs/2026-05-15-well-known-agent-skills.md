# Well-Known Agent Skills — Build-Time Mirror

## 1. Background

`helmagent.dev` is a Cloudflare static-assets site (no Worker `main`). We want to publish the `helm` skill at the standard agent-skills discovery paths so the `skills` CLI (and similar agent-skill clients) can install it from `https://helmagent.dev`:

- `/.well-known/agent-skills/index.json` — discovery manifest
- `/.well-known/agent-skills/helm/SKILL.md` — the skill contents

Upstream source of truth is `https://github.com/helm-agent/helm-agent` at `skills/helm/SKILL.md`. Upstream does not publish a discovery `index.json`; we generate one.

## 2. Requirements Summary

- Build-time mirror — no Cloudflare Worker, keep the site fully static.
- One script at build: fetch upstream `SKILL.md`, parse frontmatter, compute digest, emit `SKILL.md` (verbatim) and `index.json` under `public/.well-known/agent-skills/`.
- Wire into `bun run build` so deploys ship the latest mirror.
- Gitignore the generated tree.
- Only `helm` for now; adding a second skill should be one line in a `SKILLS` config array.

## 3. Acceptance Criteria

1. `bun scripts/fetch-skills.mjs` writes `public/.well-known/agent-skills/helm/SKILL.md` with verbatim bytes from `https://raw.githubusercontent.com/helm-agent/helm-agent/main/skills/helm/SKILL.md`.
2. The script writes `public/.well-known/agent-skills/index.json` with `$schema = "https://schemas.agentskills.io/discovery/0.2.0/schema.json"` and `skills[0]` containing `{name: "helm", type: "skill-md", description, url: "/.well-known/agent-skills/helm/SKILL.md", files: ["SKILL.md"], digest: "sha256:<hex>"}`.
3. `description` is the value of the `description:` key in the upstream SKILL.md YAML frontmatter.
4. `digest` is `sha256:<lowercase-hex>` of the SKILL.md bytes that are written to disk.
5. The script exits non-zero on upstream non-200 response or on missing `description` in frontmatter.
6. `package.json` defines `"build:skills": "bun scripts/fetch-skills.mjs"` and `"build"` runs it before `build:fonts` and `build:css`.
7. `.gitignore` excludes `public/.well-known/`.
8. After `bun run build && bun run dev`: `GET /.well-known/agent-skills/index.json` returns 200 with valid JSON matching the schema, and `GET /.well-known/agent-skills/helm/SKILL.md` returns 200 with the verbatim upstream markdown.
9. Adding a second skill requires only adding one entry (a `{name, upstream}` object literal) to the `SKILLS` array at the top of `fetch-skills.mjs`.

## 4. Problem Analysis

- **Approach A — Cloudflare Worker proxy** — runtime fetch from GitHub on each request, cached via CF cache API → rejected: requires switching the site from pure static to Worker+assets, runtime cost, more failure modes. Overkill when content changes rarely.
- **Approach B — Commit mirrored files into the repo by hand** — rejected: drifts from upstream, manual digest computation, no validation.
- **Chosen — Build-time fetch script** — runs in CI on deploy, fetch + validate before any write, no runtime cost, CF CDN caches the static files for free.

## 5. Decision Log

**1. YAML frontmatter parsing strategy**
- Options: A) Add a YAML dep · B) Regex on `description:` line, plain-scalar only · C) Hand-roll full parser
- Decision: **B)** — single field, regex is simplest; no dep growth. KISS.
- Sub-decision: **No quote-stripping.** Only plain YAML scalars are accepted. If the value starts with `"`, `'`, `>`, or `|`, fail with a clear error pointing at upstream. Reviewer round 1 flagged that naive quote-stripping silently corrupts strings containing internal quotes — failing loudly is consistent with Decision #4.

**2. Where the SKILLS list lives**
- Options: A) Inline `const SKILLS` at top of script · B) Separate `scripts/skills.json` · C) Directory convention
- Decision: **A)** — one skill today, promote to JSON when there are 3+. YAGNI.

**3. Failure handling order**
- Options: A) Best-effort sequential writes · B) Write to temp + rename · C) Fetch + validate all, then write all
- Decision: **C)** — fetch + validate everything before opening any file for write, so an upstream HTTP or validation failure leaves the previous build's output untouched. A crash *during* writes (disk full, EACCES, Ctrl-C between two writes) can leave a digest/SKILL.md mismatch on disk; we accept that because the build runs in CI from a clean checkout and a re-run recovers fully. We explicitly do not need atomic rename for a CI build artifact. KISS.

**4. Multi-line / folded description support**
- Options: A) Single-line only, fail otherwise · B) Support YAML `>` and `|` blocks
- Decision: **A)** — upstream is currently single-line; failing loudly is better than silently producing a malformed manifest. YAGNI.

**5. Content-Type for served files**
- Options: A) Trust Cloudflare default MIME for `.md` and `.json` · B) Add a `_headers` file
- Decision: **A)** — verify in Phase 5; only add `_headers` if defaults are wrong.

**6. Build-log verbosity**
- Options: A) Silent on success · B) One line per skill summarising name + digest
- Decision: **B)** — cheap signal in CI logs; helps confirm what was deployed.

**7. Where the build script lives in the build chain**
- Options: A) Before fonts/css · B) After
- Decision: **A)** — independent of CSS/fonts; running first surfaces upstream/network failures before doing the heavier CSS build.

**8. Local cache for upstream fetch**
- Options: A) No cache, network on every build · B) Skip refetch if file exists unless `FORCE=1`
- Decision: **A)** — KISS; network is required for `bun run build` (including local iteration). Upstream is a tiny static file on GitHub's CDN; rate-limit risk is negligible. Reviewer round 1 flagged that offline `bun run build` will fail — accepted trade-off; document it.

**9. JSON-schema validation of the produced `index.json`**
- Options: A) Skip; rely on cited reference shape · B) Fetch the JSON schema and run AJV at build
- Decision: **A)** — KISS. Field names and `type: "skill-md"` are confirmed against a live reference: `conductor.build/.well-known/agent-skills/index.json` (checked 2026-05-15 — same `$schema` URL, identical key names, `type` value `"skill-md"`). No build-time validator. AC8 weakened from "matching the schema" to "matching the documented shape in §6". Re-check if the reference drifts.

## 6. Design

### `scripts/fetch-skills.mjs`

```js
// Pseudocode shape:
const SKILLS = [
  {
    name: "helm",
    upstream: "https://raw.githubusercontent.com/helm-agent/helm-agent/main/skills/helm/SKILL.md",
  },
];

const OUT_DIR = "public/.well-known/agent-skills";
const SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

// 1. For each skill: fetch, validate 200, extract description, sha256.
//    Collect a list of pending writes; do not write yet.
// 2. After all skills succeed: mkdir -p per-skill dirs, overwrite SKILL.md files
//    in place, write index.json. Do NOT rm -rf OUT_DIR — see Data flow step 7.
// 3. Print one line per skill: "✓ <name> <digest>".

function extractDescription(md) {
  // 1. Match the opening "---\n" ... "\n---" frontmatter block at the top of the file.
  //    Reject if no frontmatter block found.
  // 2. Inside the block, find a line: /^description:[ \t]*(.+?)\s*$/m
  // 3. Reject if missing or empty.
  // 4. Reject (with a clear error) if the value starts with `"`, `'`, `>`, or `|` —
  //    we only accept plain YAML scalars. No quote-stripping.
}

async function sha256Hex(bytes) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}
```

### Data flow

1. Iterate `SKILLS`. For each: `fetch(upstream)` → throw on `!res.ok` with status code in the message.
2. `arrayBuffer()` → wrap as `Uint8Array`. **Invariant: this same `Uint8Array` is the input to both `writeFile` and `sha256Hex`. No intermediate `text()` / re-encode round-trip is permitted, because (a) AC1 requires verbatim bytes, and (b) the digest in `index.json` must be reproducible against upstream's raw bytes.**
3. Decode a *separate* UTF-8 string from the bytes for frontmatter parsing only. This decoded string is never written back to disk.
4. Extract `description` via regex on the first `---`-delimited block. Throw on missing/empty/non-plain-scalar.
5. Compute sha256 hex over the `Uint8Array` from step 2.
6. Stage write actions: `{path, bytes}` for SKILL.md and `{path, json}` for index.json.
7. After all skills processed without throwing: ensure per-skill subdirs exist (`mkdir -p`), write all SKILL.md files, write `index.json`. We do **not** `rm -rf OUT_DIR` first — overwriting in place is fine for a CI artifact and avoids a window where the directory exists but is empty.

### Error handling

- Network/fetch error → propagates from `await fetch`; non-zero exit.
- `res.ok === false` → `throw new Error(\`upstream <url> returned <status>\`)`.
- Missing/empty frontmatter description → `throw new Error(\`<name>: SKILL.md frontmatter missing 'description'\`)`.
- All errors crash the script with a non-zero exit, failing `bun run build`.

### `index.json` output shape

```json
{
  "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
  "skills": [
    {
      "name": "helm",
      "type": "skill-md",
      "description": "<from frontmatter>",
      "url": "/.well-known/agent-skills/helm/SKILL.md",
      "files": ["SKILL.md"],
      "digest": "sha256:<hex>"
    }
  ]
}
```

### `package.json` change

Add `"build:skills": "bun scripts/fetch-skills.mjs"`. Update `"build"` to:

```
bun run build:skills && bun run build:fonts && bun run build:css
```

### `.gitignore` change

`.gitignore` already exists at repo root with path-specific entries for other generated files (`public/styles.css`, `public/fonts/`). Append `public/.well-known/` to it. Do not introduce a broader `public/*` ignore.

## 7. Files Changed

- `scripts/fetch-skills.mjs` — new: fetches upstream skills, validates, computes sha256, writes `SKILL.md` + `index.json`.
- `package.json` — add `build:skills` script; prepend it to `build`.
- `.gitignore` — add `public/.well-known/`.

## 8. Verification

Steps are independent and can be run in any order except where they explicitly build on a prior step.

1. [AC1, AC3, AC4] Run `bun scripts/fetch-skills.mjs`; verify `public/.well-known/agent-skills/helm/SKILL.md` exists and that `shasum -a 256` of its bytes matches the `digest` field in `index.json` (without the `sha256:` prefix).
2. [AC1] `diff <(cat public/.well-known/agent-skills/helm/SKILL.md) <(curl -s https://raw.githubusercontent.com/helm-agent/helm-agent/main/skills/helm/SKILL.md)` is empty — confirms verbatim bytes.
3. [AC2] Inspect `index.json` — `$schema = "https://schemas.agentskills.io/discovery/0.2.0/schema.json"`, `skills[0]` shape per §6 §index.json output shape (`name`, `type` = `"skill-md"`, `description`, `url`, `files`, `digest`). Reference shape confirmed against the live `conductor.build` discovery endpoint during design.
4. [AC5] Temporarily point a SKILL entry at a 404 URL; confirm non-zero exit. Temporarily mock upstream to omit `description` (or quote-wrap it) and confirm non-zero exit with a clear error message. Revert after.
5. [AC6] `cat package.json` shows the new script and the updated `build` chain.
6. [AC7] `git check-ignore -v public/.well-known/agent-skills/index.json` confirms the path is ignored.
7. [AC8] After `bun run build`, run `bun run dev`. Before curling, confirm the files exist on disk under `public/.well-known/agent-skills/` — important because `wrangler.jsonc` has `not_found_handling: "single-page-application"`, which would silently return 200 + `index.html` on a missing path. Then:
   - `curl -sf http://localhost:8787/.well-known/agent-skills/index.json` returns 200 + valid JSON (parseable by `jq`).
   - `curl -sf http://localhost:8787/.well-known/agent-skills/helm/SKILL.md` returns 200 and `diff` against upstream raw is empty (this `diff` also catches the SPA-fallback case: `index.html` would differ).
   - Sanity-check the fallback exists by curling a known-missing path under `.well-known/`: it should return `index.html` (200), confirming our 200s above are real assets.
8. [AC9] Visually inspect the `SKILLS` array; confirm adding `{name, upstream}` is the only structural edit required.
