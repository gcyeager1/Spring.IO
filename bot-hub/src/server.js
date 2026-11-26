import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { garrettKeyMeta, revealGarrettKey, regenerateGarrettKey, matchesGarrettKey } from "./ingest-keys.js";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import {
  ROOT, dataDir, loadConfig, publicConfig, isMock, isPlan, accountProblem, claudeCodeVersion,
} from "./config.js";
import { callBot, costOf, listPrice } from "./providers.js";
import {
  getAdmin, setupOpen, createAdmin, checkCredentials, createSession, verifySession, revokeSession,
  parseCookies, sessionCookie, COOKIE, loginBlocked, recordLoginFailure, clearLoginFailures,
} from "./auth.js";
import { addMessage, getChat, clearChat, recordUsage, summarizeUsage, isDirect } from "./store.js";
import { estimateSend } from "./estimate.js";
import { validateReport } from "../public/planusage.js";
import { savePlanUsage, getPlanUsage } from "./planusage-store.js";

const cfg = loadConfig();
const PORT = Number(process.env.PORT ?? cfg.port ?? 3000);
// Hosted (PORT provided by the platform) listens on all interfaces; local default is loopback.
const HOST = process.env.HOST ?? (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
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
  const actual = { calls: 0, input: 0, output: 0, cost: 0, planCalls: 0, apiValue: 0 };
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
        const callCost = costOf(usage, account);
        actual.calls += 1;
        actual.input += usage.input + usage.cachedInput + usage.cacheWrite;
        actual.output += usage.output;
        actual.cost += callCost;
        if (isPlan(account) && !error) {
          actual.planCalls += 1;
          actual.apiValue += result?.apiValue ?? listPrice(usage, account.pricing);
        }
        recordUsage({
          ts: Date.now(),
          room,
          account: account.id,
          bot: bot.id,
          model: result?.model ?? bot.model,
          ...usage,
          cost: callCost,
          // Plan-covered calls: keep their API-equivalent value so the dashboard can show it.
          plan: isPlan(account) || undefined,
          apiValue: isPlan(account) ? (result?.apiValue ?? listPrice(usage, account.pricing)) : undefined,
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
    broadcast("status", { running: runningRooms(), done: room, actual });
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

// ---------- auth helpers ----------
const TRUST_PROXY = process.env.BOTHUB_TRUST_PROXY === "1";
const clientIp = (req) => {
  if (TRUST_PROXY) {
    const xff = String(req.headers["x-forwarded-for"] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1]; // last hop = the proxy's view of the client
  }
  return req.socket.remoteAddress ?? "unknown";
};
const isSecure = (req) => req.socket.encrypted || (TRUST_PROXY && req.headers["x-forwarded-proto"] === "https");
const tokenOf = (req) => parseCookies(req.headers.cookie)[COOKIE];
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Cache-Control": "no-store",
};

function authPage(res, mode) {
  const setup = mode === "setup";
  const envEmail = process.env.BOTHUB_ADMIN_EMAIL;
  const html = fs
    .readFileSync(path.join(ROOT, "public", "auth", "auth.html"), "utf8")
    .replaceAll("__TITLE__", setup ? "Setup" : "Sign in")
    .replaceAll("__SUB__", setup ? "First-run setup: create the admin account." : "Sign in to continue.")
    .replaceAll("__BUTTON__", setup ? "Create admin" : "Sign in")
    .replaceAll("__MODE__", mode)
    .replaceAll("__PWAC__", setup ? "new-password" : "current-password")
    .replaceAll("__MINLEN__", setup ? "12" : "1")
    .replaceAll("__EMAILATTR__", setup && envEmail ? `value="${envEmail.replace(/[^\w@.+-]/g, "")}" readonly` : "")
    .replaceAll("__EXTRA__", setup && process.env.BOTHUB_SETUP_TOKEN ? '<label>Setup token <input name="token" type="password" required></label>' : "");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS });
  res.end(html);
}

const AUTH_STATIC = {
  "/auth/auth.js": "text/javascript; charset=utf-8",
  "/auth/auth.css": "text/css; charset=utf-8",
};

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/planusage.js": ["planusage.js", "text/javascript; charset=utf-8"],
};

// Bearer token for the plan-usage ingest. Constant-time compare on equal-length digests;
// an unset env var means every attempt fails.
const sha = (v) => createHash("sha256").update(String(v)).digest();
// Returns "master" (env token: any account), "garrett" (garrett-only key) or null.
// Both digests are always compared so timing doesn't reveal which token matched.
function ingestRole(req) {
  const master = process.env.BOTHUB_INGEST_TOKEN;
  const m = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""));
  const presented = m?.[1] ?? "";
  const isMaster = timingSafeEqual(sha(presented), sha(master ?? "")) && Boolean(master) && Boolean(m);
  const isGarrett = matchesGarrettKey(presented) && Boolean(m);
  return isMaster ? "master" : isGarrett ? "garrett" : null;
}
const ingestAuthorized = (req) => ingestRole(req) === "master";

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  try {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

    // ----- public routes -----
    if (url.pathname === "/api/health" || url.pathname === "/health") {
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && AUTH_STATIC[url.pathname]) {
      res.writeHead(200, { "Content-Type": AUTH_STATIC[url.pathname] });
      return void fs.createReadStream(path.join(ROOT, "public", url.pathname)).pipe(res);
    }

    // Cross-site writes are refused (cookies are SameSite=Strict as well).
    if (req.method !== "GET" && req.method !== "HEAD" && req.headers.origin) {
      let same = false;
      try { same = new URL(req.headers.origin).host === req.headers.host; } catch {}
      if (!same) return json(res, 403, { error: "Cross-origin request refused" });
    }

    const authed = Boolean(verifySession(tokenOf(req)));

    // Grok plan-usage ingest: bearer token instead of a session cookie.
    if (url.pathname === "/api/plan-usage" && req.method === "POST") {
      const role = ingestRole(req);
      if (!role) return json(res, 401, { error: "Unauthorized" });
      let body;
      try { body = await readBody(req); } catch { return json(res, 400, { error: "Invalid JSON" }); }
      if (role === "garrett" && body?.account !== "garrett") return json(res, 403, { error: "Key not valid for this account" });
      const v = validateReport(body);
      if (v.error) return json(res, 400, { error: v.error });
      savePlanUsage(v.report);
      broadcast("usage", {});
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/plan-usage" && req.method === "GET") {
      if (!authed && !ingestAuthorized(req)) return json(res, 401, { error: "Unauthorized" });
      return json(res, 200, getPlanUsage());
    }

    if (url.pathname === "/login" && req.method === "GET") {
      if (authed) { res.writeHead(302, { Location: "/" }); return void res.end(); }
      if (setupOpen()) { res.writeHead(302, { Location: "/setup" }); return void res.end(); }
      return authPage(res, "login");
    }
    if (url.pathname === "/setup" && req.method === "GET") {
      if (!setupOpen()) { res.writeHead(302, { Location: authed ? "/" : "/login" }); return void res.end(); }
      return authPage(res, "setup");
    }

    if (url.pathname === "/api/setup" && req.method === "POST") {
      const body = await readBody(req);
      const r = createAdmin(body.email, body.password, body.token);
      if (r.error) return json(res, r.status, { error: r.error });
      const { token, maxAgeS } = createSession();
      res.setHeader("Set-Cookie", sessionCookie(token, maxAgeS, isSecure(req)));
      return json(res, 200, { ok: true });
    }

    if (url.pathname === "/api/login" && req.method === "POST") {
      const body = await readBody(req);
      const ip = clientIp(req);
      const wait = loginBlocked(ip, body.email);
      if (wait) {
        res.setHeader("Retry-After", String(wait));
        return json(res, 429, { error: "Too many attempts. Try again later." });
      }
      if (!checkCredentials(body.email, body.password)) {
        recordLoginFailure(ip, body.email);
        return json(res, 401, { error: "Invalid email or password" });
      }
      clearLoginFailures(ip, body.email);
      const { token, maxAgeS } = createSession();
      res.setHeader("Set-Cookie", sessionCookie(token, maxAgeS, isSecure(req)));
      return json(res, 200, { ok: true });
    }

    if (url.pathname === "/api/logout" && req.method === "POST") {
      revokeSession(tokenOf(req));
      res.setHeader("Set-Cookie", sessionCookie("", 0, isSecure(req)));
      return json(res, 200, { ok: true });
    }

    // ----- everything below needs a session -----
    if (!authed) {
      if (url.pathname.startsWith("/api/")) return json(res, 401, { error: "Not signed in" });
      res.writeHead(302, { Location: setupOpen() ? "/setup" : "/login" });
      return void res.end();
    }

    // Usage feed keys (session only; the token is never in metadata, config or logs).
    if (url.pathname === "/api/ingest-keys" && req.method === "GET") {
      return json(res, 200, { garrett: garrettKeyMeta() });
    }
    if (url.pathname === "/api/ingest-keys/garrett/reveal" && req.method === "POST") {
      console.log("garrett ingest token revealed");
      res.setHeader("Cache-Control", "no-store");
      return json(res, 200, { token: revealGarrettKey(), ...garrettKeyMeta() });
    }
    if (url.pathname === "/api/ingest-keys/garrett/regenerate" && req.method === "POST") {
      const token = regenerateGarrettKey();
      console.log("garrett ingest token regenerated");
      res.setHeader("Cache-Control", "no-store");
      return json(res, 200, { token, ...garrettKeyMeta() });
    }

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

    if (url.pathname === "/api/estimate" && req.method === "POST") {
      const body = await readBody(req);
      const room = String(body.room ?? "group");
      if (!validRoom(room)) return json(res, 400, { error: "Unknown room" });
      const participants = (body.participants ?? []).filter((id) => botsById.has(id));
      return json(res, 200, estimateSend(cfg, { room, text: String(body.text ?? ""), participants, rounds: body.rounds }));
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
      return json(res, 200, {
        ...summarizeUsage(since, cfg.accounts, cfg.bots, bot && botsById.has(bot) ? bot : undefined, todayStart),
        planUsage: getPlanUsage(),
      });
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
  console.log(`Login: ${getAdmin() ? `admin ${getAdmin().source === "env" ? "from env" : "from data dir"}` : "NO ADMIN YET - open /setup to create one"}`);
  console.log(`Data: ${dataDir()}`);
  console.log(`Config: ${path.relative(ROOT, cfg.file)}${isMock() ? "  (MOCK mode - no API calls)" : ""}`);
  for (const a of cfg.accounts) {
    const problem = accountProblem(a);
    if (a.provider === "claude-code") {
      const v = claudeCodeVersion(a.command);
      console.log(`  [${problem ? "NOT READY" : "ready    "}] ${a.name} (Claude Code on your plan${v ? `, ${v}` : ""})${problem ? ` - ${problem}` : ""}`);
    } else {
      console.log(`  [${problem ? "NO KEY   " : "key set  "}] ${a.name} (${a.provider}) - reads $${a.apiKeyEnv}`);
    }
  }
});
