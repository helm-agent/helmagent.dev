# helmagent.dev

Landing page for Helm — an always-on coding agent. Deployed as a Cloudflare Worker with static assets.

## Develop

```bash
bun install
bun run build   # one-time: precompiles Tailwind CSS + copies Geist woff2 fonts
bun run dev
```

Re-run `bun run build` if you edit `src/styles.css` or change Tailwind class usage in `public/index.html`. Generated files (`public/styles.css`, `public/fonts/`) are gitignored.

## Deploy

Pushes to `main` deploy via GitHub Actions (which runs `bun run build` before `wrangler deploy`). Manual deploy:

```bash
bun run deploy
```
