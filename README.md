# Retrospace realtime

The WebSocket backend of [Retrospace](https://retrospace-mauve.vercel.app). A small Express + `ws` server that runs on its own, apart from the
website (which stays on Vercel, where WebSockets cannot be held open).

It carries the **live, throwaway messages** of a board over one open connection per person: cursors, selections, live drags and resizes,
"hello" (who is here), celebrations and thrown emoji. It also **pushes saved changes** (and settings changes, removals) down the same connection,
the moment the website publishes them.

```
 browser ──HTTPS──▶ website (Vercel) ──saves──▶ MongoDB
    │                    │  ▲
    │                    │  └── POST /api/rt/authorize   (signed: "who is this and what may they do?")
    │                    └── publishes "something changed" ──▶ Upstash bus ──┐
    └──WebSocket──▶ this server ◀─────────────────────────────────────────────┘
                        └── also publishes the live messages it receives, so other copies of this server get them
```

- **No database, no encryption keys.** It never touches MongoDB. For each person it asks the website (signed with `REALTIME_SECRET`) for their name,
  avatar and what they may do, and keeps the answer for 5 seconds. Saved changes still go to the website's API.
- **Nothing to turn on here for the website to keep working.** The website only hands browsers this server's address when its `REALTIME_WS_URL` is
  set; a browser that cannot reach this server uses the plain stream, as before.
- **Several copies are fine.** They share the Upstash bus.

## Settings (`.env.example`)

| Name | What |
|---|---|
| `SITE_URL` | The website's address (it is asked who people are). Required. |
| `REALTIME_SECRET` | **This server's own secret, the same value as `REALTIME_SECRET` on the website** (at least 16 characters, e.g. `openssl rand -base64 32`). Signs the WebSocket tickets this server checks and the questions it asks. **Never the website's `RT_SECRET`**: the server refuses to start if that is set. Required. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | **The same Upstash database as the website.** Required. |
| `ALLOWED_ORIGINS` | Site addresses allowed to connect, comma separated. Default: `SITE_URL`. |
| `PORT` | Default 8080. |
| `MAX_CONNECTIONS` | Default 5000 per copy; over that, new connections get 503 and browsers use the plain stream. |
| `RT_WS_MAX_MS` | Longest one connection lives (default 270000). The browser then gets a new ticket from the website, which checks access again. |
| `AUTH_CACHE_MS` | How long what the website said about a person is kept (default 5000). |

## Run, test

```bash
npm install
cp .env.example .env   # fill it in, then:
set -a; . ./.env; set +a; npm start
npm test               # 30 tests, real sockets, no network
node scripts/sim-e2e.mjs https://your-website   # the website, this server and Upstash together (needs the website's REALTIME_WS_URL set)
```

`GET /health` answers `{"ok":true,"connections":…,"rooms":…}`.

## Where it can and cannot run

It needs a host that **keeps a process running and accepts WebSocket connections**: Fly.io, Railway, Render, a VPS, any container host.

**Vercel cannot host it.** Vercel runs code as short-lived serverless functions, which cannot hold a WebSocket open. A Vercel deployment of this repository
may build and may even answer `GET /health`, but a browser can never keep a connection to it, so the website would quietly keep using its plain
stream. Keep the website on Vercel and run this server somewhere else.

## Checking a deployment

- `GET /health` always answers, cheaply.
- `GET /health?check=1` also checks the settings, that the website accepts this server's signature (so `REALTIME_SECRET` matches), and that Upstash answers.
  It never returns a secret, only yes or no and what is wrong.
- On Vercel the same address answers with `"websocket": false` and the same checks, so a deployment's settings can be verified there, but it cannot
  take WebSocket connections (see above).

## Deploy

Any host that keeps a process running and speaks WebSocket: Fly.io, Railway, Render, a VPS. **Keep at least one instance running at all times**
(a stopped instance drops every connection) and put it behind HTTPS (`wss://`): an https page cannot open a `ws://` address.

Fly.io, as an example:

```bash
fly launch --copy-config --no-deploy          # uses fly.toml and the Dockerfile
fly secrets set SITE_URL=https://your-website REALTIME_SECRET=... UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... ALLOWED_ORIGINS=https://your-website
fly deploy
curl https://<app>.fly.dev/health
```

`SITE_URL` must be an address **this server can reach** (in a container, `localhost` is the container itself: use the public address, or `http://host.docker.internal:3000` on your own machine). If the website cannot be asked, connections are refused with 503 and browsers use the plain stream.

Then, **on the website (Vercel)**, set `REALTIME_WS_URL=wss://<app>.fly.dev/ws` and redeploy. To turn this server off for everybody, remove that
variable and redeploy: browsers go back to the plain stream.

## What it checks

A connection needs a WebSocket ticket the website issued for that person and board (`wsTok`, HMAC with `REALTIME_SECRET`, 30 minutes), an `Origin` in `ALLOWED_ORIGINS`, and the website's
answer that the person is in the board, not removed, and the link not revoked (the owner is exempt). Frames over 4 KB or binary frames close the
connection; 30 live messages a second per person; throwing and celebrating follow the board's rules and limits (3 throws per 4.5 s, 1 celebration
per 3 s); cursors and drags are dropped for a connection whose outgoing buffer is backed up. The sender of every message is the person the ticket
was issued to; the name and avatar come from the website, never from the message.

## Keeping in step with the website

Three things are copied from the website and pinned by tests on both sides (`test/vectors.test.mjs` here, `test/rt-authorize.test.mjs` there):
the **WebSocket ticket** format, the **signature** of the authorize question, and the **rules for live messages** (`src/rules.mjs`, the website's
`lib/ephemeral.js`). If you change one on the website, change it here too; the known-answer tests fail on whichever side was forgotten.
