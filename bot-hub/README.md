# Bot Hub

A local web app where your Grok bots and Claude talk to each other (and to you) in one group chat, next to a live dashboard of token usage and estimated cost for each account.

- **Group chat:** pick which bots take part, send a message, and each bot replies in turn. Set **Rounds** to let them go back and forth several times. **Let them talk** continues without a new message from you, and **Stop** ends the conversation after the current reply.
- **Usage dashboard:** total cost, a tile per account, daily cost stacked by account, a per-bot table and a log of recent calls. It updates live as bots reply and has 24h, 7d, 30d and All ranges.

## Quick start

```bash
cd bot-hub
npm install

# Try it with fake replies first (no API keys, no cost):
npm run mock
# open http://localhost:3000
```

## Use your real accounts

1. Copy the example config:
   ```bash
   cp config.example.json config.json
   ```
2. Edit `config.json`:
   - **accounts:** one entry per API account. Three Grok (xAI) accounts and one Claude account are set up by default. `apiKeyEnv` is the **name** of the environment variable that holds that account's key. Keys are never written to the config.
   - **bots:** give each bot a name, an account, a model and a personality (`systemPrompt`). You can put several bots on the same account.
   - **pricing:** USD per 1M tokens, used for the cost estimates. **Check the Grok prices and model names against xAI's current pricing page.** The defaults are placeholders.
3. Set the keys and start the app:
   ```bash
   export XAI_API_KEY_1=...   # Grok account 1
   export XAI_API_KEY_2=...   # Grok account 2
   export XAI_API_KEY_3=...   # Grok account 3
   export ANTHROPIC_API_KEY=...
   npm start
   ```
   On startup the terminal lists which accounts have a key.

## How it works

| File | What it does |
|---|---|
| `src/server.js` | Node HTTP server (no framework). It serves the page, runs the turn-taking loop and pushes live updates to the browser over server-sent events. |
| `src/providers.js` | Calls Grok (xAI's OpenAI-compatible REST API) and Claude (the official `@anthropic-ai/sdk`). Every bot gets the same shared transcript, with other speakers' lines tagged `[Name]:`. |
| `src/store.js` | Appends each chat message and each API call's token usage to `data/*.jsonl`, and builds the dashboard totals from those files. |
| `public/` | The page: chat, dashboard and SVG chart. No build step. |

Claude defaults to `claude-opus-5-5` at `low` effort, which suits quick chat replies. To make it more thoughtful, raise `effort` on the bot in `config.json`. Prompt caching is on, so each new turn pays full price only for the new part of the transcript. Server-side refusal fallback is also on, so if a safety check declines a request, the API retries it on a fallback model.

**Usage numbers only count calls made through Bot Hub.** Usage from other apps or the xAI and Anthropic consoles won't appear here.

## Options

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `127.0.0.1` | Set to `0.0.0.0` to reach it from other devices on your network. There is no login, so do this only on a trusted network. |
| `BOT_HUB_MOCK` | unset | `1` returns fake replies and fake usage |
