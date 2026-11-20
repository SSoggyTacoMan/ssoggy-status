# ssoggy status

Live status page for everything I host — runs on a Cloudflare Worker, so it stays up even when the VPS or Vercel is down.

**Live:** https://status.ssoggy.com

## What it checks

| Category | Services |
|---|---|
| Game | Minecraft (`mc.ssoggy.com:25565`, full server-list handshake → player count) |
| Vercel | TaalSwipe, MiniMusicLab, Sprig, Excel Dash preview, SSoggySouls Docs, Portfolio, Vishandel Volendam |
| Cloudflare Pages | AI Chat, Beleggers Academie (OBA), CEV Dashboard |
| GitHub Pages | `ssoggytacoblud.github.io` |
| Nest VPS | Pterodactyl panel, router, OpenWebUI chat, Pterodactyl node |

Checks run every 60 seconds via a cron trigger. A rolling history of the last 60 checks per target is stored in KV and rendered as the bar sparkline + uptime %.

## Endpoints

- `GET /` — status page (server-rendered, live-refreshes every 30s)
- `GET /api/status` — JSON
- `GET /api/check` — force a check run

## Develop

```bash
npm i -g wrangler   # or: npx wrangler
wrangler dev        # local
wrangler deploy     # production
```

## Adding a service

Append an entry to `TARGETS` in `worker.js`:

```js
{ id: "ptero-node", name: "Pterodactyl Node", group: "Nest VPS", type: "http", url: "https://node.example.com/" }
```

HTTP targets count as **up** for any status ≤ 399 by default; pass `okUpTo: 499` for auth-protected apps (401/403/307 still mean the box is alive). Use `type: "mc"` with `host`/`port` for Minecraft.

## Deploying on push

`.github/workflows/deploy.yml` deploys on every push to `main`. It needs two repo secrets:

- `CLOUDFLARE_API_TOKEN` — token with *Workers Scripts: Edit* + *Workers KV Storage: Edit*
- `CLOUDFLARE_ACCOUNT_ID` — your account ID (Settings → Account ID in the Cloudflare dashboard)
