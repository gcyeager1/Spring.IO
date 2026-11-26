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
import { validateReport, validateClaudeFeed } from "../public/planusage.js";
import { savePlanUsage, getPlanUsage } from "./planusage-store.js";
import { getClaudeUsage, recordClaudeUsage, refreshClaudeUsageNow, startClaudeUsageProbe, claudeUsageLastRunAt, claudeUsageRunning } from "./claude-usage.js";
import * as ra from "./realagent.js";
import { ensureTeamBrief, readTeamBrief, saveTeamBrief } from "./team-brief.js";
import { bridgeView, saveWebhook, clearWebhook, isBridgeBot, BRIDGE_BOTS, validateWebhookUrl } from "./bridge-store.js";
import { replyTokenMeta, revealGarrettReplyToken, revealLifteasyReplyToken, regenerateGarrettReplyToken, replyRole } from "./reply-tokens.js";

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


// ---------- Real agents (webhook bridge) ----------
// A visible note in the room. Hidden so stand-in bots never see it as something to answer.
function addNote(room, text) {
  const msg = addMessage({ id: randomUUID(), ts: ra.nowMs(), room, speaker: "System", botId: null, hidden: true, system: true, text });
  broadcast("message", msg);
}

const timers = new Map(); // job id -> timers
function clearTyping(room) {
  broadcast("status", { running: runningRooms(), done: room });
}
function scheduleJob(job) {
  const age = ra.nowMs() - job.ts;
  const t = [];
  if (!job.timeoutNoted) {
    t.push(setTimeout(() => {
      const j = ra.getJob(job.id);
      if (!j || j.status !== "open" || j.timeoutNoted) return;
      ra.updateJob(job.id, { timeoutNoted: true });
      const name = botsById.get(j.botId)?.name ?? j.botId;
      addNote(j.room, `Still waiting on ${name} - it's taking longer than expected. A late reply will still show up here.`);
    }, Math.max(0, ra.TIMEOUT_NOTE_MS - age)));
  }
  t.push(setTimeout(() => expireJobs(), Math.max(0, ra.EXPIRE_MS - age) + 50));
  for (const x of t) x.unref?.();
  timers.set(job.id, t);
}
function expireJobs() {
  for (const j of ra.expireStale()) {
    for (const x of timers.get(j.id) ?? []) clearTimeout(x);
    timers.delete(j.id);
    addNote(j.room, `No reply from ${botsById.get(j.botId)?.name ?? j.botId} after 30 minutes - giving up on that request.`);
    clearTyping(j.room);
  }
}

/**
 * Decide which real agents a human message wakes, post notes for refusals, and fire webhooks.
 * Real agents never answer as stand-ins; only a human @mention (or their private room) wakes them.
 */
function wakeRealAgents(room, text) {
  const real = cfg.bots.filter((b) => ra.isRealAgent(b));
  if (!real.length) return;
  let targets = [];
  if (isDirect(room)) {
    const b = botsById.get(room.slice(3));
    if (b && ra.isRealAgent(b) && text) targets = [b];
  } else if (text) {
    const m = ra.parseMentions(text, cfg.bots);
    targets = real.filter((b) => m.ids.has(b.id));
    for (const amb of m.ambiguous) {
      if (amb.ids.some((id) => botsById.has(id) && ra.isRealAgent(botsById.get(id)))) {
        const opts = amb.ids.map((id) => `@${id}`).join(" or ");
        addNote(room, `"@${amb.name}" matches more than one bot - nobody was woken. Use ${opts}.`);
      }
    }
  }
  for (const bot of targets) {
    const hook = ra.webhookFor(bot.id);
    if (!ra.withinHours()) {
      addNote(room, `Real bots are offline until 7 AM Eastern (they only run 7 AM-9 PM). ${bot.name} was not woken.`);
      continue;
    }
    if (ra.inFlight(bot.id, room)) {
      addNote(room, `${bot.name} is still working on the previous request in this chat - wait for it before sending another.`);
      continue;
    }
    if (ra.wakesInWindow(bot.account) >= ra.WAKE_CAP) {
      addNote(room, `Wake limit reached for ${cfg.accountsById.get(bot.account)?.name ?? bot.account} (${ra.WAKE_CAP} per hour). ${bot.name} was not woken.`);
      continue;
    }
    const job = ra.createJob({ id: randomUUID(), botId: bot.id, room, account: bot.account });
    const payload = ra.buildPayload(job, bot, text, getChat(room).filter((m) => !m.hidden));
    scheduleJob(job);
    broadcast("typing", { room, botId: bot.id, name: bot.name });
    ra.postWebhook(hook, payload).then((r) => {
      if (r.ok) return;
      for (const x of timers.get(job.id) ?? []) clearTimeout(x);
      timers.delete(job.id);
      ra.updateJob(job.id, { status: "failed" });
      addNote(room, `Couldn't reach ${bot.name} (${r.reason}). Not retrying - send the message again to try once more.`);
      clearTyping(room);
    });
  }
}

function acceptReply(job, bot, body) {
  const account = cfg.accountsById.get(bot.account);
  const error = typeof body.text === "string" && body.text.trim() ? undefined : String(body.error).slice(0, 1000);
  const text = error ? undefined : body.text.slice(0, 20000);
  ra.updateJob(job.id, { status: "done", doneAt: ra.nowMs() });
  for (const x of timers.get(job.id) ?? []) clearTimeout(x);
  timers.delete(job.id);
  // A plan run: no dollar cost and no invented token counts.
  recordUsage({
    ts: ra.nowMs(), room: job.room, account: account.id, bot: bot.id, model: bot.model,
    input: 0, cachedInput: 0, cacheWrite: 0, output: 0, cost: 0,
    plan: error ? undefined : true, apiValue: error ? undefined : 0,
    latencyMs: ra.nowMs() - job.ts, ok: !error, error, realAgent: true, mock: isMock() || undefined,
  });
  broadcast("usage", {});
  const msg = addMessage({
    id: randomUUID(), ts: ra.nowMs(), room: job.room, speaker: bot.name,
    botId: error ? null : bot.id, hidden: error ? true : undefined, account: account.id,
    text: error ? `Error: ${error}` : text, error: Boolean(error), realAgent: true,
  });
  broadcast("message", msg);
  clearTyping(job.room);
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
// Sliding-window limiter for self-register: 10 attempts (any outcome) per rolling hour per IP.
const SELF_REG_MAX = 10, SELF_REG_WINDOW = 3600_000;
const selfRegHits = new Map();
/** 0 if allowed (and counted), else seconds to wait. */
function selfRegisterHit(ip) {
  const now = Date.now();
  const arr = (selfRegHits.get(ip) ?? []).filter((t) => now - t < SELF_REG_WINDOW);
  if (arr.length >= SELF_REG_MAX) { selfRegHits.set(ip, arr); return Math.max(1, Math.ceil((arr[0] + SELF_REG_WINDOW - now) / 1000)); }
  arr.push(now);
  selfRegHits.set(ip, arr);
  if (selfRegHits.size > 5000) for (const [k, v] of selfRegHits) if (!v.some((t) => now - t < SELF_REG_WINDOW)) selfRegHits.delete(k);
  return 0;
}
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

    // Cross-site writes are refused (cookies are SameSite=Lax; the Origin/Host check is the CSRF guard).
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
      if (body?.account === "claude") {
        if (role === "garrett") return json(res, 403, { error: "Key not valid for this account" });
        const c = validateClaudeFeed(body);
        if (c.error) return json(res, 400, { error: c.error });
        recordClaudeUsage(c.windows, "feed");
        broadcast("usage", {});
        return json(res, 200, { ok: true });
      }
      if (role === "garrett" && body?.account !== "garrett") return json(res, 403, { error: "Key not valid for this account" });
      const v = validateReport(body);
      if (v.error) return json(res, 400, { error: v.error });
      savePlanUsage(v.report);
      broadcast("usage", {});
      return json(res, 200, { ok: true });
    }
    // Self-register: a bot on its own box sets/clears its webhook with its account reply token.
    // Bearer only (a session cookie alone is not enough). Order: rate limit, auth, account, body, store.
    const selfM = /^\/api\/bridge\/([^/]+)\/self-register$/.exec(url.pathname);
    if (selfM && (req.method === "PUT" || req.method === "DELETE")) {
      const wait = selfRegisterHit(clientIp(req));
      if (wait) { res.setHeader("Retry-After", String(wait)); return json(res, 429, { error: "Too many requests" }); }
      const m = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""));
      const role = replyRole(m?.[1] ?? "", Boolean(m));
      if (!role) return json(res, 401, { error: "Unauthorized" });
      let id;
      try { id = decodeURIComponent(selfM[1]); } catch { id = ""; }
      const bridgeBot = BRIDGE_BOTS.find((b) => b.id === id);
      if (!bridgeBot) return json(res, 400, { error: "Unknown bridge bot" });
      if (bridgeBot.account !== (role === "garrett" ? "grok-2" : "grok-1")) {
        return json(res, 403, { error: "Token not valid for this bot" });
      }
      if (req.method === "DELETE") {
        clearWebhook(id);
        console.log(`bridge self-register cleared for ${id}`);
        return json(res, 200, { ok: true, botId: id, set: false });
      }
      let body;
      try { body = await readBody(req); } catch { return json(res, 400, { error: "Invalid JSON" }); }
      const sUrl = typeof body?.url === "string" ? body.url.trim() : "";
      const sKey = typeof body?.key === "string" ? body.key.trim() : "";
      if (!sUrl || !sKey) return json(res, 400, { error: "Need url and key" });
      const bad = validateWebhookUrl(sUrl);
      if (bad) return json(res, 400, { error: bad });
      const r = saveWebhook(id, sUrl, sKey);
      if (r.error) return json(res, 400, { error: r.error });
      console.log(`bridge self-register for ${id}`);
      return json(res, 200, { ok: true, botId: id, set: true });
    }
    // Real-agent callback: bearer token (BOTHUB_REPLY_TOKEN) instead of a session cookie.
    // Server-to-server, so no Origin header is expected; browsers sending a foreign Origin were
    // already refused above.
    if (url.pathname === "/api/agent-reply" && req.method === "POST") {
      const m = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""));
      const role = replyRole(m?.[1] ?? "", Boolean(m)); // "lifteasy" (env) | "garrett" | null
      if (!role) return json(res, 401, { error: "Unauthorized" });
      let body;
      try { body = await readBody(req); } catch { return json(res, 400, { error: "Invalid JSON" }); }
      const hasText = typeof body?.text === "string" && body.text.trim();
      const hasError = typeof body?.error === "string" && body.error.trim();
      if (typeof body?.job_id !== "string" || typeof body?.bot_id !== "string" || (!hasText && !hasError)) {
        return json(res, 400, { error: "Need job_id, bot_id and text (or error)" });
      }
      const bot = botsById.get(body.bot_id);
      // Each token only speaks for its own account's bots.
      if (bot && bot.account !== (role === "garrett" ? "grok-2" : "grok-1")) {
        return json(res, 403, { error: "Token not valid for this bot" });
      }
      const found = bot ? ra.lookup(body.job_id, body.bot_id) : { state: "missing" };
      if (found.state === "missing") return json(res, 404, { error: "No open job for that job_id and bot_id" });
      if (found.state === "open") acceptReply(found.job, bot, body);
      return json(res, 200, { ok: true }); // already done: first write wins, no duplicate
    }

    if (url.pathname === "/api/plan-usage" && req.method === "GET") {
      if (!authed && !ingestAuthorized(req)) return json(res, 401, { error: "Unauthorized" });
      return json(res, 200, { ...getPlanUsage(), claude: getClaudeUsage() });
    }

    if (url.pathname === "/api/claude-usage/refresh" && req.method === "POST") {
      if (!authed) return json(res, 401, { error: "Unauthorized" });
      if (claudeUsageRunning()) return json(res, 409, { error: "Already refreshing" });
      if (Date.now() - claudeUsageLastRunAt() < 60_000) return json(res, 429, { error: "Refreshed less than a minute ago" });
      const r = await refreshClaudeUsageNow();
      if (r.ok) broadcast("usage", {});
      return json(res, 200, { ok: r.ok, claude: getClaudeUsage() });
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

    // Bridge (real bots): webhook URL/key pairs on the volume. Keys are write-only.
    if (url.pathname === "/api/bridge" && req.method === "GET") return json(res, 200, { bots: bridgeView() });
    const bridgeM = /^\/api\/bridge\/([^/]+)$/.exec(url.pathname);
    if (bridgeM && (req.method === "PUT" || req.method === "DELETE")) {
      const id = decodeURIComponent(bridgeM[1]);
      if (!isBridgeBot(id)) return json(res, 400, { error: "Unknown or non-Grok bot" });
      let r;
      if (req.method === "PUT") {
        let body;
        try { body = await readBody(req); } catch { return json(res, 400, { error: "Invalid JSON" }); }
        r = saveWebhook(id, body?.url, typeof body?.key === "string" ? body.key : "");
        if (!r.error) console.log(`bridge webhook saved for ${id}`);
      } else {
        r = clearWebhook(id);
        if (!r.error) console.log(`bridge webhook cleared for ${id}`);
      }
      if (r.error) return json(res, 400, { error: r.error });
      return json(res, 200, { bot: bridgeView().find((b) => b.id === id) });
    }

    // Team brief (session only): shared notes sent to real agents; the hub rule is always line 1.
    if (url.pathname === "/api/team-brief" && req.method === "GET") {
      res.setHeader("Cache-Control", "no-store");
      return json(res, 200, { text: readTeamBrief() });
    }
    if (url.pathname === "/api/team-brief" && req.method === "PUT") {
      let body;
      try { body = await readBody(req); } catch { return json(res, 400, { error: "Invalid JSON" }); }
      const r = saveTeamBrief(body?.text);
      if (r.error) return json(res, 400, { error: r.error });
      console.log("team brief saved");
      return json(res, 200, { text: r.text });
    }

    // Reply tokens (session only; fetched on click, never in metadata, config or logs).
    if (url.pathname === "/api/reply-tokens" && req.method === "GET") return json(res, 200, replyTokenMeta());
    if (url.pathname === "/api/reply-tokens/lifteasy/reveal" && req.method === "POST") {
      const token = revealLifteasyReplyToken();
      if (!token) return json(res, 404, { error: "BOTHUB_REPLY_TOKEN is not set" });
      console.log("lifteasy reply token revealed");
      res.setHeader("Cache-Control", "no-store");
      return json(res, 200, { token });
    }
    if (url.pathname === "/api/reply-tokens/garrett/reveal" && req.method === "POST") {
      console.log("garrett reply token revealed");
      res.setHeader("Cache-Control", "no-store");
      return json(res, 200, { token: revealGarrettReplyToken(), ...replyTokenMeta().garrett });
    }
    if (url.pathname === "/api/reply-tokens/garrett/regenerate" && req.method === "POST") {
      const token = regenerateGarrettReplyToken();
      console.log("garrett reply token regenerated");
      res.setHeader("Cache-Control", "no-store");
      return json(res, 200, { token, ...replyTokenMeta().garrett });
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
        // Real agents never reply as stand-ins: they are woken by webhook or not at all.
        const standIns = participants.filter((id) => !ra.isRealAgent(botsById.get(id)));
        if (isDirect(room) && !standIns.length && !text) return json(res, 400, { error: "Say something to message a real bot" });
        if (text) {
          broadcast("message", addMessage({ id: randomUUID(), ts: ra.nowMs(), room, speaker: "You", botId: null, text }));
        } else if (!getChat(room).some((m) => !m.hidden)) {
          return json(res, 400, { error: "Say something to start the conversation" });
        }
        if (standIns.length) runConversation(room, standIns, rounds).catch((e) => console.error(e));
        wakeRealAgents(room, text);
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
        planUsage: { ...getPlanUsage(), claude: getClaudeUsage() },
      });
    }

    json(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    json(res, 500, { error: err?.message ?? "Server error" });
  }
});

ensureTeamBrief();

// Resume timers for jobs that were open when the process last stopped.
expireJobs();
for (const j of ra.openJobs()) scheduleJob(j);

startClaudeUsageProbe({ account: cfg.accounts.find((a) => a.provider === "claude-code"), mock: isMock() });

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
