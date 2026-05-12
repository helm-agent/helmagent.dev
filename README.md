# helm.sorrycc.com

Landing page for Helm — an always-on coding agent. Deployed as a Cloudflare Worker with static assets.

## Develop

```bash
bun install
bun run dev
```

## Deploy

Pushes to `main` deploy via GitHub Actions. Manual deploy:

```bash
bun run deploy
```
