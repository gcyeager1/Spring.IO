import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ROOT, loadConfig, publicConfig, isMock } from "./config.js";
import { callBot, costOf } from "./providers.js";
import { addMessage, getChat, clearChat, recordUsage, summarizeUsage, isDirect } from "./store.js";

const cfg = loadConfig();
const PORT = Number(process.env.PORT ?? cfg.port ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";
const botsById = new Map(cfg.bots.map((b) => [b.id, b]));

// A room is "group" or "dm:<botId>" (a private chat with one bot).
const validRoom = (room) => room === "group" || (isDirect(room) && botsById.has(room.slice(3)));

// ---------- Server-sent events: live chat + dashboard updates ----------
const listeners = new Set();
function broadcast(type, data) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of listeners) res.write(frame);
}

// ---------- Conversation runner: one run at a time per room ----------
const runs = new Map(); // room -> { stop: boolean }
const runningRooms = () => [...runs.keys()];

async function runConversation(room, participantIds, rounds) {
  const participants = participantIds.map((id) => botsById.get(id));
  const names = ["You", ...participants.map((b) => b.name)];
  const run = { stop: false };
  runs.set(room, run);
  broadcast("status", { running: runningRooms() });
  try {
    for (let r = 0; r < rounds && !run.stop; r++) {
      for (const bot of participants) {
        if (run.stop) break;
        const account = cfg.accountsById.get(bot.account);
        broadcast("typing", { room, botId: bot.id, name: bot.name });
        const started = Date.now();
        let result;
        let error;
        try {
          result = await callBot(bot, account, getChat(room), names, { direct: isDirect(room) });
        } catch (err) {
          error = err?.message ?? String(err);
        }
        const usage = result?.usage ?? { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 };
        recordUsage({
          ts: Date.now(),
          room,
          account: account.id,
          bot: bot.id,
          model: result?.model ?? bot.model,
          ...usage,
          cost: costOf(usage, account.pricing),
          latencyMs: Date.now() - started,
          ok: !error,
          error,
          mock: isMock() || undefined,
        });
        broadcast("usage", {});
        const msg = addMessage({
          id: randomUUID(),
          ts: Date.now(),
          room,
          speaker: bot.name,
          // Error lines are kept out of the bots' view of the transcript.
          botId: error ? null : bot.id,
          hidden: error ? true : undefined,
          account: account.id,
          text: error ? `Error: ${error}` : result.text,
          error: Boolean(error),
          note: result?.note,
        });
        broadcast("message", msg);
      }
    }
  } finally {
    runs.delete(room);
    broadcast("status", { running: runningRooms(), done: room });
  }
}

// ---------- HTTP ----------
function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1e6) throw new Error("Body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  try {
    if (req.method === "GET" && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      res.writeHead(200, { "Content-Type": type });
      fs.createReadStream(path.join(ROOT, "public", file)).pipe(res);
      return;
    }

    if (url.pathname === "/api/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`event: status\ndata: ${JSON.stringify({ running: runningRooms() })}\n\n`);
      listeners.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => {
        clearInterval(ping);
        listeners.delete(res);
      });
      return;
    }

    if (url.pathname === "/api/config" && req.method === "GET") {
      return json(res, 200, publicConfig(cfg));
    }

    if (url.pathname === "/api/messages") {
      if (req.method === "GET") {
        const room = url.searchParams.get("room");
        if (room && !validRoom(room)) return json(res, 400, { error: "Unknown room" });
        return json(res, 200, getChat(room ?? undefined));
      }
      if (req.method === "DELETE") {
        const room = url.searchParams.get("room") ?? "group";
        if (!validRoom(room)) return json(res, 400, { error: "Unknown room" });
        if (runs.has(room)) return json(res, 409, { error: "This chat is still running - pause it first" });
        clearChat(room);
        broadcast("cleared", { room });
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        const room = String(body.room ?? "group");
        if (!validRoom(room)) return json(res, 400, { error: "Unknown room" });
        if (runs.has(room)) return json(res, 409, { error: "Still replying - wait or press Pause" });
        const text = String(body.text ?? "").trim();
        let participants;
        let rounds;
        if (isDirect(room)) {
          participants = [room.slice(3)];
          rounds = 1;
        } else {
          participants = (body.participants ?? []).filter((id) => botsById.has(id));
          rounds = Math.min(Math.max(Number(body.rounds) || 1, 1), 10);
          if (!participants.length) return json(res, 400, { error: "Pick at least one bot for the group" });
        }
        if (text) {
          broadcast("message", addMessage({ id: randomUUID(), ts: Date.now(), room, speaker: "You", botId: null, text }));
        } else if (!getChat(room).some((m) => !m.hidden)) {
          return json(res, 400, { error: "Say something to start the conversation" });
        }
        runConversation(room, participants, rounds).catch((e) => console.error(e));
        return json(res, 202, { ok: true });
      }
    }

    if (url.pathname === "/api/stop" && req.method === "POST") {
      const { room } = await readBody(req);
      for (const [r, run] of runs) if (!room || r === room) run.stop = true;
      return json(res, 200, { ok: true });
    }

    if (url.pathname === "/api/usage" && req.method === "GET") {
      const days = url.searchParams.get("days");
      const since = days === "all" ? 0 : Date.now() - (Number(days) || 7) * 86_400_000;
      const bot = url.searchParams.get("bot");
      const todayStart = Number(url.searchParams.get("todayStart")) || 0;
      return json(res, 200, summarizeUsage(since, cfg.accounts, cfg.bots, bot && botsById.has(bot) ? bot : undefined, todayStart));
    }

    json(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    json(res, 500, { error: err?.message ?? "Server error" });
  }
});

server.listen(PORT, HOST, () => {
  const shown = HOST === "0.0.0.0" ? "localhost" : HOST;
  console.log(`Bot Hub running at http://${shown}:${PORT}`);
  console.log(`Config: ${path.relative(ROOT, cfg.file)}${isMock() ? "  (MOCK mode - no API calls)" : ""}`);
  for (const a of cfg.accounts) {
    const mark = process.env[a.apiKeyEnv] ? "key set " : "NO KEY  ";
    console.log(`  [${mark}] ${a.name} (${a.provider}) - reads $${a.apiKeyEnv}`);
  }
});
