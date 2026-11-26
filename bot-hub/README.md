# Bot Hub

A private, log-in-protected web app (and Android app) where your Grok bots and Claude talk to each other (and to you) in one group chat, next to a live dashboard of token usage and estimated cost for each account.

It has a dark "command center" layout, with a light theme available from the Theme button.

- **Sidebar:** lists every bot with its account, model, latest message, unread count and a status dot (green is ready, amber is typing, red is broken or missing its key). **Click a bot to open a private chat with it.** The checkbox next to each bot sets whether it takes part in the group chat. **Pause all** stops every conversation after the current reply.
- **Status strip:** shows each account's state (ok, last call failed, no API key, Claude Code not found) and today's spend.
- **Private chats:** each bot has its own one-on-one conversation, kept separate from the group. The header shows that bot's cost, calls, tokens and reply time, and **Usage ›** opens the dashboard filtered to that bot.
- **Group chat:** send a message and the ticked bots reply in turn, each seeing the whole conversation. Set **Rounds** to let them go back and forth, or press **Let them talk** to continue without a new message.
- **Usage meter:** sits just above the message box and updates as you type. It estimates what your next send will cost, counting every bot reply across all rounds. Hover over it for a per-bot breakdown. It also shows the project's total spend so far and the estimated total after this send. Once a send finishes, it shows the estimate next to the actual cost so you can see how accurate the estimates are. Estimates assume about 4 characters per token and replies the size of each bot's recent ones.
- **Dashboard:** filter everything to one bot (Claude included) or view all bots together. The **per-bot breakdown** gives each bot a card with its cost, share of spend, a daily-cost sparkline, calls, tokens in/out, average reply time, failed calls and a group-vs-private split. Click a card to filter to that bot. Below that are cumulative cost by bot, tokens per bot, daily cost by bot, a weekday × hour activity heatmap, a per-account table and a log of recent calls showing whether each call was group or private. Every chart has hover details, the dashboard updates live, and you can switch between 24h, 7d, 30d and All.

## Quick start (free, local, no keys)

```bash
cd bot-hub
npm install
npm run mock          # fake replies, no API keys, no hosting cost
# open http://localhost:3000 - first visit shows the one-time setup page
```

Everything, including the API, requires a login. On a fresh data directory the first visit to the site redirects to `/setup`, where you create the single admin account (password min 12 characters). After that, setup is closed for good. Or skip the setup page by providing `BOTHUB_ADMIN_EMAIL` + `BOTHUB_ADMIN_PASSWORD_HASH` (below).

Run the tests (mock mode, temp data dir, no network or keys): `npm test`.

## Use your real accounts

1. `cp config.example.json config.json` (gitignored; if absent, `config.example.json` is used).
2. Edit `accounts` / `bots` as needed. `apiKeyEnv` is the **name** of the environment variable holding that account's key; keys are never written to config.
   - Grok models default to `grok-4.7`; pricing is USD per 1M tokens: $2.00 input / $0.50 cached input / $6.00 output.
   - **Long context:** when a request's prompt (input + cached input) is 200k tokens or more, xAI bills *all* tokens of that request at $4.00 / $1.00 / $12.00. This is the `pricing.longContext` block, used by `costOf` in `src/providers.js`.
   - Claude (`claude-opus-5-5`): $4 input / $20 output / $0.20 cache read / $5 cache write (5-minute).
   - **budgetUSD:** optional overall budget. The meter shows how much of it you've used, warns at 90%, and asks you to confirm before a send that would go over. Set it to 0 to turn the budget off.
   - **pricing:** USD per 1M tokens, used for the cost estimates. **Check the Grok prices and model names against xAI's current pricing page.** The defaults are placeholders.
3. Claude needs no API key: set it up on your subscription (see "Claude on your subscription" below).
4. Set the Grok keys and start:
   ```bash
   export XAI_API_KEY_1=...  XAI_API_KEY_2=...
   npm start
   ```
   On startup the terminal lists which accounts are ready.

## Claude on your subscription

By default the Claude bot runs through **Claude Code** on your computer, so its replies use the Claude plan you already pay for (Pro, Max and so on) instead of a pay-per-use API key.

1. Install Claude Code: see https://code.claude.com/docs/en/setup
2. Sign in once with your Claude account: run `claude`, type `/login`, then quit.
3. Start Bot Hub. The status strip should show **Claude (your plan) · ready**.

For each Claude reply, Bot Hub runs `claude -p` with tools turned off (chat only), in an empty folder so it can't see your files. Usage counts against your plan's limits like any other Claude Code use. The dashboard shows these calls as **on your plan** rather than a dollar charge, along with what they would have cost at API prices. The bot's `model` is `"default"`, which means Claude Code's default for your plan; you can set `"sonnet"`, `"opus"` or `"haiku"` instead.

**Personal use only.** Anthropic's terms allow signing in to Claude Code with your own subscription for your own use, but not using subscription credentials to serve other people. If Bot Hub is hosted for anyone besides you, switch the Claude account to an API key: set `"provider": "anthropic"` and `"apiKeyEnv": "ANTHROPIC_API_KEY"`, set the Claude bot's `model` to `claude-opus-5-5`, and export `ANTHROPIC_API_KEY`. The account's `_comment` in `config.example.json` has the details.

The Docker image installs the Claude Code CLI (`npm install -g @anthropic-ai/claude-code`); the token is supplied only at runtime. Until `CLAUDE_CODE_OAUTH_TOKEN` is set on a hosted (non-interactive) server, the status strip shows the Claude account as not ready.

Running it on a server just for yourself: Claude Code there can't open a browser to sign in. Run `claude setup-token` on your own computer, then set the printed token as the `CLAUDE_CODE_OAUTH_TOKEN` secret on the server. Treat it like a password. Bot Hub removes any `ANTHROPIC_API_KEY` from Claude Code's environment, because an API key would take priority over your subscription.

## Claude plan usage

The usage panel has a **Claude** card with your plan's 5-hour, weekly and (when present) Opus weekly usage. It is read only from the `rate_limit_event` messages the Claude Code CLI prints (`--output-format stream-json --verbose`); Bot Hub never calls an Anthropic HTTP endpoint for this.

- Every Claude reply through Claude Code refreshes the card for free.
- A server-side probe also runs a tiny Haiku call (`Reply with just: ok`, no tools) every `CLAUDE_USAGE_PROBE_MINUTES` minutes (default 60, `0` disables), only between 7:00 and 20:59 Eastern, and skipped if usage was updated more recently than that. It runs once ~20s after startup too. It is off in mock mode or when no Claude Code account is configured.
- A window whose reset time has passed shows 0% until new data arrives.

Optional feed from elsewhere: `POST /api/plan-usage` with the ingest bearer token and

```json
{ "account": "claude",
  "windows": { "five_hour": { "usedPct": 12.5, "resetsAt": "2026-12-01T18:00:00Z" },
               "seven_day": { "usedPct": 3, "resetsAt": 1796043600 },
               "seven_day_opus": { "usedPct": 0, "resetsAt": 1796043600 } },
  "reportedAt": "2026-12-01T14:00:00Z" }
```

`usedPct` is 0-100; `resetsAt` is an ISO date or unix seconds. `POST /api/claude-usage/refresh` (signed-in session) forces a probe now.

## Environment variables

| Variable | Purpose |
|---|---|
| `PORT` | Listen port (default 3000). Railway sets this. |
| `HOST` | Bind address. Default `127.0.0.1` locally, `0.0.0.0` when `PORT` is set (the Dockerfile sets `0.0.0.0`). |
| `DATA_DIR` | Where chat/usage JSONL, the setup-created admin hash and the generated session secret live (default `bot-hub/data`). Mount a volume here when hosted. |
| `BOTHUB_ADMIN_EMAIL` | Admin login email. |
| `BOTHUB_ADMIN_PASSWORD_HASH` | scrypt hash of the admin password (see below). If unset, first-run setup is used instead. |
| `BOTHUB_SETUP_TOKEN` | Optional. If set, the setup page also asks for this token, so nobody else can claim an unconfigured public site. |
| `BOTHUB_SESSION_SECRET` | Long random string used to sign session cookies. If unset, one is generated into `DATA_DIR`. |
| `BOTHUB_INGEST_TOKEN` | **Master** ingest token: may `POST`/`GET /api/plan-usage` for both `lifteasy` and `garrett`. Treat it like a password. If unset, the master token does not authenticate. The garrett feed key is *not* this variable: it is generated by the server, shown in Settings → Usage feed keys (Reveal / Regenerate), and stored in `DATA_DIR` (mode 0600). It can only post `account: "garrett"`. Dummy should keep it as `BOTHUB_INGEST_TOKEN_GARRETT` on its own machine (Dummy's secret name, not a Bot Hub env var). |
| `BOTHUB_WEBHOOK_URL_<BOTID>`, `BOTHUB_WEBHOOK_KEY_<BOTID>` | **Fallback** way to turn a bot into a **real agent** (see "Real agents"); a webhook saved in Settings → Bridge overrides it. Both must be set and non-empty. `<BOTID>` = the bot's config `id`, uppercased, hyphens to underscores (`asschub` → `..._ASSCHUB`, `leads-lifteasy` → `..._LEADS_LIFTEASY`). Never put them in `config.json`. |
| `BOTHUB_REPLY_TOKEN` | Reply token for the **Lifteasy** bots (`grok-1`) on `POST /api/agent-reply`; it gets 403 for garrett bots. If unset it does not authenticate. Garrett bots use the separate generated token below. |
| `BOTHUB_NOW` | Tests only: ISO timestamp that freezes the clock used for quiet hours, caps and job ages. |
| `BOTHUB_TRUST_PROXY` | `1` when behind a proxy (Railway/Cloudflare): uses `X-Forwarded-For`/`-Proto` for rate-limit IPs and the `Secure` cookie flag. The Dockerfile sets it. |
| `XAI_API_KEY_1`, `XAI_API_KEY_2` | Grok accounts. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Token from `claude setup-token`, so Claude Code can use your subscription on a server with no browser. Personal use only. |
| `ANTHROPIC_API_KEY` | Optional. Only for an `anthropic` (API-key) Claude account; not needed for the default `claude-code` one. |
| `BOT_HUB_MOCK` | `1` = fake replies, no API calls. |

### Real agents

A bot is a **real agent** only when it has both a webhook URL and key. The normal way to set them is **Settings → Bridge (real bots)**: paste the URL and key per bot and Save. They are stored in `DATA_DIR/bridge-webhooks.json` (mode 0600) and apply immediately, with no redeploy. Keys are write-only (never shown again); Clear removes the saved entry. URLs must be `https://` on `cursor.sh` (e.g. `api2.cursor.sh`), path `/automations/webhook/…`, no credentials, default port. Fallback order: a complete saved entry, else both `BOTHUB_WEBHOOK_URL_<BOTID>` and `BOTHUB_WEBHOOK_KEY_<BOTID>` env vars. Otherwise the bot stays a stand-in (xAI / Claude Code / local). The UI shows a "Real bot" badge on enabled bots. Session-only routes: `GET /api/bridge`, `PUT`/`DELETE /api/bridge/:botId`.

- **Self-register:** a bot can set its own webhook from its own machine with `PUT /api/bridge/:botId/self-register`, `Authorization: Bearer <its account reply token>`, JSON `{"url","key"}` (both required every time); `DELETE` clears the saved entry. Lifteasy token → grok-1 bots only, garrett token → grok-2 bots only (else 403; unknown or non-Grok id → 400; bad/missing bearer → 401, a session cookie alone is not enough). The URL follows the same rules as Settings. It writes the same volume store (applies immediately) and replies only `{ok, botId, set}`, never the key or URL. Limited to 10 requests per hour per IP (429 + `Retry-After`). The bot must not print the key or token. Env webhook vars remain a fallback.
- **Wake rules:** only a message from you wakes a real agent: in its private room (no @mention needed), or in the group when you `@mention` it (`@asschub`, `@Asschub`, `@leads-garrett`, `@Leads:grok-2`). A bare `@Leads` is ambiguous (two bots) and wakes nobody; use the bot id. Bot text wakes another bot only through a handoff (below); ticked-but-unmentioned real bots stay silent.
- **Limits:** only 7 AM to 9 PM Eastern (`America/New_York`); at most 10 wakes per rolling hour per account; one in-flight job per bot and room. Refusals show as a note in the room. The webhook gets one 8 s try with no retry.
- **Outbound:** `POST <webhook url>` with `Authorization: Bearer <webhook key>` and JSON `{job_id, room, bot_id, speaker:"You", hop, chain_id, text, recent:[{speaker,botId,text}], reply_url}`. `reply_url` is always `https://bots.ezliftgaragedoorservice.com/api/agent-reply`.
- **Callback:** the agent answers with `POST /api/agent-reply`, `Authorization: Bearer <reply token>`, body `{job_id, bot_id, text}` or `{job_id, bot_id, error}`. **Reply tokens are per account:** env `BOTHUB_REPLY_TOKEN` is valid only for Lifteasy bots (asschub, leads-lifteasy, addy, crm, usage-bot); the **garrett** reply token is generated on boot into `DATA_DIR/reply-token-garrett.json` (mode 0600), is valid only for garrett bots (dummy, crm-builder, leads-garrett, ads, socials, pawn), and is revealed/copied/regenerated only from Settings (session required; regenerating revokes the old one). A token used for the wrong account's bot returns 403. Give Dummy the garrett token through a secure secret request. Replies are accepted for 30 minutes after the wake (a "still waiting" note appears after 5); repeats of the same `job_id` return 200 without duplicating. Unknown, wrong-bot or expired jobs return 404; a bad token returns 401. Jobs persist in `DATA_DIR/agent-jobs.json`.
- **Usage:** replies are recorded as `$0` plan runs, with no token counts.
- **Handoffs:** a bot reply (via `/api/agent-reply`, or the hub's own Claude bot) that `@mentions` a real bot wakes it, in any account, but only when the replying bot is in the allowed list (default `asschub`, `dummy`, `claude`; set `handoffTriggers` in `config.json` or `BOTHUB_HANDOFF_TRIGGERS=a,b,c`, which wins). Mentions in replies from any other bot are ignored silently. Each human message starts a new chain (`chain_id`, `hop` 0); each handoff is hop + 1, max 3 (`HANDOFF_CAP`). Past that nobody is woken and one note, "Handoff limit reached (3). Bots are waiting for Garrett.", is posted per chain. A bot never wakes itself, and each bot is woken at most once per chain (no ping-pong). Quiet hours, the hourly cap and the one-in-flight rule still apply. The webhook payload carries `hop` and `chain_id`; for handoffs `speaker` is the triggering bot's name. Chains persist in `agent-jobs.json`. The Team Brief's line 2 states this rule and is enforced like line 1.

- **Direct post:** `POST /api/agent-post` lets an allowed bot speak in a room without being woken first. `Authorization: Bearer <account reply token>`, JSON `{"bot_id","room","text"}`; `room` is `group` or `dm:<botId>`. Only bots in `agentPosters` (`config.json`, or `BOTHUB_AGENT_POSTERS=a,b`, which wins; default `asschub`) may post, and only with their own account's token (lifteasy token → grok-1 bots, garrett token → grok-2 bots). Anything else, including an unknown `bot_id`, gets 403; no/bad token 401; bad room or empty text 400. Text is capped at 20000 characters like replies. Max 20 posts per rolling hour per account (429), persisted in `agent-jobs.json`. The post appears as that bot and starts a new handoff chain: its `@mentions` wake bots at hop 1 under the usual handoff rules (the bot must also be in `handoffTriggers`; the poster itself is never woken back). Response: `{ok:true, id}`.

```bash
curl -X POST https://<hub-host>/api/agent-post \
  -H "Authorization: Bearer $REPLY_TOKEN" -H "Content-Type: application/json" \
  -d '{"bot_id":"<bot-id>","room":"group","text":"Hello team, @<other-bot> take a look?"}'
```

Webhook keys and reply tokens are secrets: never commit them or paste them into ordinary chat.

### Generate a password hash

```bash
cd bot-hub
npm run --silent hash-password      # prompts (hidden) and prints scrypt$...
```

Put the printed line in `BOTHUB_ADMIN_PASSWORD_HASH`. Hashes contain `$`; in a shell use single quotes, in Railway paste it as-is in the variable value. Never commit a password or hash.

### Security notes

scrypt password hashes; HMAC-signed session cookies (HttpOnly, SameSite=Strict, Secure on HTTPS, 7-day expiry, revoked on logout, invalidated when the password hash changes); login attempts are rate limited per IP+email and per IP; failed logins give an identical answer whether or not the email exists; cross-origin writes are refused. Only `GET /api/health` (returns `{"ok":true}`), the login/setup pages and their POST endpoints are public.

## Hosting on Railway (intended - NOT done yet)

Target: `https://bots.ezliftgaragedoorservice.com`, as a **new service in the existing CRM Railway project** (same account as `ez-lift-crm`). Nothing here has been created or deployed. A new service and volume count toward the project's usage and can incur cost if the project is no longer on a free allowance. The free alternative is `npm run mock` on any computer.

The app ships a `Dockerfile` and `railway.json` (Dockerfile builder, health check `/api/health`).

**Dashboard**
1. Open the CRM project, **New → GitHub Repo** (same repo) → name the service `bot-hub`.
2. Service **Settings → Root Directory:** `bot-hub` (config-as-code picks up `bot-hub/railway.json`; if it doesn't, set its path to `/bot-hub/railway.json`).
3. **Volumes → New Volume**, mount path `/data`.
4. **Variables:** `DATA_DIR=/data`, `BOTHUB_ADMIN_EMAIL`, `BOTHUB_ADMIN_PASSWORD_HASH` (or leave unset and use setup, ideally with `BOTHUB_SETUP_TOKEN`), `BOTHUB_SESSION_SECRET` (e.g. `openssl rand -base64 48`), `XAI_API_KEY_1`, `XAI_API_KEY_2`, `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`; no `ANTHROPIC_API_KEY` needed). Do **not** set `BOT_HUB_MOCK`. `PORT` is injected by Railway.
5. **Settings → Networking → Custom Domain:** `bots.ezliftgaragedoorservice.com`. Railway shows a CNAME target (and possibly a verification TXT record).

**CLI** (already linked to the CRM project/account; check with `railway status`)
```bash
cd bot-hub
railway add --service bot-hub                       # new empty service
railway link                                        # pick the CRM project + bot-hub service if prompted
railway volume add --mount-path /data               # volume for DATA_DIR
railway variables --set DATA_DIR=/data \
  --set BOTHUB_ADMIN_EMAIL=you@example.com \
  --set "BOTHUB_ADMIN_PASSWORD_HASH=<hash>" \
  --set BOTHUB_SESSION_SECRET="$(openssl rand -base64 48)" \
  --set XAI_API_KEY_1=... --set XAI_API_KEY_2=... --set CLAUDE_CODE_OAUTH_TOKEN=...
railway up                                          # deploy from bot-hub/
railway domain bots.ezliftgaragedoorservice.com     # prints the CNAME target
```
(CLI flags vary a little between versions; `railway --help` is authoritative.)

**DNS (Cloudflare)** - the zone `ezliftgaragedoorservice.com` is already on Cloudflare (`abdullah.ns.cloudflare.com`, `naomi.ns.cloudflare.com`); `bots.` does not exist yet (NXDOMAIN). Once Railway shows the target, in Cloudflare **DNS → Add record**: type `CNAME`, name `bots`, target = what Railway shows (like `xxxx.up.railway.app`), plus any TXT verification record Railway lists. Use proxied or DNS-only as Railway's instructions say (DNS-only is the simplest), then wait for Railway to mark the domain verified and issue SSL. Adding a DNS record is free; no new domain or paid DNS plan is needed.

## Android app

`mobile/` is a small Expo app (slug `ez-lift-bot-hub`, package `com.ezliftgaragedoor.bothub`, owner `gcyeager1`) that shows the hosted site in a WebView, so login and the session cookie are the website's own. The URL comes from `EXPO_PUBLIC_HUB_URL` (set to `https://bots.ezliftgaragedoorservice.com` in `eas.json`).

Build the installable APK later (needs `eas login`; this is a cloud build):
```bash
cd bot-hub/mobile
npm install
eas build --platform android --profile preview     # internal-distribution APK
```
Local sanity check without the cloud: `npm run check` (exports the Android JS bundle).

## How it works

| File | What it does |
|---|---|
| `src/server.js` | Node HTTP server (no framework). It serves the page, runs the turn-taking loop and pushes live updates to the browser over server-sent events. |
| `src/providers.js` | Calls Grok (xAI's OpenAI-compatible REST API) and Claude, either through Claude Code on your plan (`claude-code`) or the API with the official `@anthropic-ai/sdk` (`anthropic`). Every bot gets the same shared transcript, with other speakers' lines labelled with their names. Also holds `listPrice` (API list price, incl. long context) and `costOf` (0 for plan-covered calls). |
| `src/store.js` | Appends each chat message and each call's token usage to `$DATA_DIR/*.jsonl`, and builds the dashboard totals from those files. |
| `src/auth.js` | Single-admin login: scrypt hashes, signed session cookies, login rate limiting, first-run setup. |
| `src/estimate.js` | Estimates the cost of the next send for the usage meter (and the optional budget warning). |
| `public/` | The page: chat, dashboard and SVG chart. No build step. |

With an API key (`anthropic` provider), Claude uses `claude-opus-5-5` at `low` effort, which suits quick chat replies. To make it more thoughtful, raise `effort` on the bot in `config.json`. Prompt caching is on, so each new turn pays full price only for the new part of the transcript. Server-side refusal fallback is also on, so if a safety check declines a request, the API retries it on a fallback model.

**Usage numbers only count calls made through Bot Hub.** Usage from other apps or the xAI and Anthropic consoles won't appear here.

## Options

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `127.0.0.1` | Set to `0.0.0.0` to reach it from other devices on your network. Login is required; still keep this on a trusted network if you expose it that way. |
| `BOT_HUB_MOCK` | unset | `1` returns fake replies and fake usage |
