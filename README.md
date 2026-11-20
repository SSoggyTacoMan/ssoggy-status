# ssoggy status

Live status page for everything I host — runs on a Cloudflare Worker, so it stays up when the VPS or Vercel does not.

**Live:** https://status.ssoggy.com

## What it checks

| Category | Services |
|---|---|
| Game | Minecraft (`mc.ssoggy.com:25565`, full server-list handshake → player count + version) |
| Vercel | TaalSwipe, MiniMusicLab, Sprig, Excel Dash preview, SSoggySouls Docs, Portfolio, Vishandel Volendam |
| Cloudflare Pages | AI Chat, Beleggers Academie (OBA), CEV Dashboard |
| Nest VPS | Pterodactyl panel, router, OpenWebUI chat, Pterodactyl node |

Nest targets are checked on `*.ssoggy.me` until the `*.ssoggy.com` TLS certs are issued by Nest; the `.com` hostnames are listed in each service's copy.

A cron trigger runs every 2 minutes (the free KV tier allows 1,000 writes/day; every minute would be 1,440). The last 90 results per target are stored in KV and rendered as heartbeat bars + uptime %.

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `GET /` | — | status page (server-rendered, refreshes every 30s) |
| `GET /api/status` | — | JSON |
| `GET /admin` | key | copy editor (login form, cookie session) |
| `POST /admin/save` | session | write `about` / `note` / notice overrides to KV |
| `POST /admin/test` | session | run one check of a single target |
| `POST /admin/logout` | session | clear the cookie |
| `POST /api/check` | session | force a full check run |

## Editing the copy

`/admin` → enter the admin key → edit `about` / `note` per service → save.

- Defaults live in `TARGETS` (`about`, `note`); blank fields fall back to them.
- Overrides live in KV under `copy:v1`, so no deploy is needed.
- The key is the `ADMIN_KEY` Worker secret. Rotate it with:

```bash
wrangler secret put ADMIN_KEY
```

## Security notes

- `ADMIN_KEY` is a Worker secret, never committed.
- Login exchanges the key for an `HttpOnly; Secure; SameSite=Strict` cookie (`sha256("session:" + key)`).
- Nonce-based CSP (`default-src 'none'`), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, `noindex`.
- Admin pages are `no-store`; the public page is `private, max-age=20` (never shared-cached, so nonces stay valid).
- POST bodies are capped at 20 KB; saves require a same-origin `Origin`.
- All user-authored copy is HTML-escaped at render time.
- If the secret is missing, `/admin` fails closed.

## Develop

Requires Node ≥ 18 (wrangler). This Mac has no Node installed yet.

```bash
npm i -g wrangler
wrangler dev        # local, http://localhost:8787
wrangler dev --remote  # against real KV
wrangler deploy     # production
```

`wrangler.toml` holds the KV binding, cron and route. `account_id` is intentionally absent — export `CLOUDFLARE_ACCOUNT_ID` instead.

## Deploying

Either `wrangler deploy` locally, or push to `main` and let `.github/workflows/deploy.yml` do it. The workflow needs two repo secrets:

- `CLOUDFLARE_API_TOKEN` — *Workers Scripts: Edit* + *Workers KV Storage: Edit*
- `CLOUDFLARE_ACCOUNT_ID` — account ID from the Cloudflare dashboard

## Adding a service

Append to `TARGETS` in `worker.js`:

```js
{
  id: "ptero-node",
  name: "Pterodactyl Node",
  group: "Nest VPS",
  type: "http",
  url: "https://node.example.com/",
  okUpTo: 499,                    // 4xx still means "the box is alive"
  about: "Wings daemon. 401 is expected.",
  note: "Anything you want shown in the expanded row.",
}
```

`type: "mc"` with `host`/`port` uses a real Minecraft handshake instead of HTTP.
