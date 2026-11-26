// Real-agent bridge: wake a real Grok Bot agent through its webhook; it answers later by
// POSTing to /api/agent-reply. Pure helpers + a small persisted job store (no secrets stored).
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./config.js";
import { lookupWebhook } from "./bridge-store.js";
import { readTeamBrief } from "./team-brief.js";

// Fixed on purpose: never taken from the client, the environment or the request.
export const REPLY_URL = "https://bots.ezliftgaragedoorservice.com/api/agent-reply";
export const WEBHOOK_TIMEOUT_MS = 8000;
export const TIMEOUT_NOTE_MS = 5 * 60_000; // show "still waiting" after this
export const EXPIRE_MS = 30 * 60_000; // late callbacks accepted until this
export const WAKE_WINDOW_MS = 60 * 60_000;
export const WAKE_CAP = 10; // per account per rolling hour
export const KEEP_MS = 24 * 60_000 * 60; // keep finished jobs so repeat callbacks stay idempotent
export const QUIET_TZ = "America/New_York";

/** Injectable clock: BOTHUB_NOW (ISO timestamp) freezes time for tests. */
export function nowMs() {
  const f = process.env.BOTHUB_NOW;
  if (f) {
    const t = Date.parse(f);
    if (!Number.isNaN(t)) return t;
  }
  return Date.now();
}

/** Webhook config for a bot (volume entry first, then env), or null unless both url and key exist. */
export const webhookFor = (botId) => lookupWebhook(botId);
export const isRealAgent = (bot) => Boolean(webhookFor(bot.id));

/** Real bots may only run 7:00 <= hour-in-New-York < 21:00. */
export function withinHours(ms = nowMs()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: QUIET_TZ, hour: "numeric", hourCycle: "h23" }).formatToParts(new Date(ms));
  const hour = Number(parts.find((p) => p.type === "hour").value);
  return hour >= 7 && hour < 21;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Find @mentions of bots in a human message. Accepts @id, @Name (case-insensitive, trailing
 * punctuation ok) and @Name:accountId. A name shared by several bots is reported as ambiguous.
 * Returns { ids: Set<botId>, ambiguous: [{name, ids}] }.
 */
export function parseMentions(text, bots) {
  const cands = []; // [literal, [botIds], display]
  for (const b of bots) {
    cands.push([b.id, [b.id], b.id]);
    cands.push([`${b.name}:${b.account}`, [b.id], b.name]);
  }
  const byName = new Map();
  for (const b of bots) {
    const k = b.name.toLowerCase();
    byName.set(k, [...(byName.get(k) ?? []), b]);
  }
  for (const list of byName.values()) cands.push([list[0].name, list.map((b) => b.id), list[0].name]);
  cands.sort((a, b) => b[0].length - a[0].length);

  let rest = String(text ?? "");
  const ids = new Set();
  const ambiguous = new Map();
  for (const [lit, botIds, display] of cands) {
    const re = new RegExp(`(^|[^\\w@])@${esc(lit)}(?!\\w|-\\w|:\\w)`, "gi");
    rest = rest.replace(re, (m, pre) => {
      if (botIds.length === 1) ids.add(botIds[0]);
      else ambiguous.set(display.toLowerCase(), { name: display, ids: botIds });
      return pre + " ".repeat(m.length - pre.length);
    });
  }
  return { ids, ambiguous: [...ambiguous.values()] };
}

// ---------- persisted jobs + wake log ----------
const FILE = () => path.join(dataDir(), "agent-jobs.json");
// Loaded lazily: config.js imports this module, so dataDir() isn't usable at load time.
let loaded = null;
function S() {
  if (!loaded) {
    loaded = { jobs: {}, wakes: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(FILE(), "utf8"));
      loaded = { jobs: raw.jobs ?? {}, wakes: raw.wakes ?? [] };
    } catch {}
  }
  return loaded;
}

function save() {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(S()), { mode: 0o600 });
}

/** Drop old records. Returns nothing; call before reads that depend on freshness. */
function prune() {
  const now = nowMs();
  for (const [id, j] of Object.entries(S().jobs)) if (now - j.ts > KEEP_MS) delete S().jobs[id];
  S().wakes = S().wakes.filter((w) => now - w.ts < WAKE_WINDOW_MS);
}

const isOpen = (j, now = nowMs()) => j.status === "open" && now - j.ts <= EXPIRE_MS;

export const getJob = (id) => S().jobs[id];

/** Open, unexpired job for this bot in this room, if any. */
export function inFlight(botId, room) {
  prune();
  const now = nowMs();
  return Object.values(S().jobs).find((j) => j.botId === botId && j.room === room && isOpen(j, now));
}

export function wakesInWindow(account) {
  prune();
  return S().wakes.filter((w) => w.account === account).length;
}

/** Reserve a job (counts against the account cap). Caller must have checked caps first. */
export function createJob(job) {
  prune();
  const j = { ...job, ts: nowMs(), status: "open", timeoutNoted: false };
  S().jobs[j.id] = j;
  S().wakes.push({ ts: j.ts, account: j.account });
  save();
  return j;
}

export function updateJob(id, patch) {
  if (!S().jobs[id]) return;
  Object.assign(S().jobs[id], patch);
  save();
}

/**
 * Look up a job for a callback. Returns { state: "open" | "done" | "missing" , job }.
 * Expired-and-unfinished jobs and wrong-bot lookups are "missing".
 */
export function lookup(jobId, botId) {
  prune();
  const j = S().jobs[jobId];
  if (!j || j.botId !== botId) return { state: "missing" };
  if (j.status === "done") return { state: "done", job: j };
  if (j.status === "open" && isOpen(j)) return { state: "open", job: j };
  return { state: "missing" };
}

/** Jobs still open (for rescheduling timers after a restart). */
export const openJobs = () => Object.values(S().jobs).filter((j) => j.status === "open");

/** Mark open jobs past the 30-minute window as expired; returns the ones that just expired. */
export function expireStale() {
  const now = nowMs();
  const out = [];
  for (const j of Object.values(S().jobs)) {
    if (j.status === "open" && now - j.ts > EXPIRE_MS) {
      j.status = "expired";
      out.push(j);
    }
  }
  if (out.length) save();
  return out;
}

const trim = (s, n) => (String(s).length > n ? String(s).slice(0, n) + "…" : String(s));

/** The webhook payload. */
export function buildPayload(job, bot, text, visible) {
  return {
    job_id: job.id,
    room: job.room,
    bot_id: bot.id,
    speaker: "You",
    text: trim(text, 4000),
    recent: visible.slice(-10).map((m) => ({ speaker: m.speaker, botId: m.botId ?? null, text: trim(m.text ?? "", 1500) })),
    reply_url: REPLY_URL,
    team_brief: readTeamBrief().trimEnd(),
  };
}

/** One attempt, no retry. Resolves { ok } or { ok:false, reason } (never throws, never echoes the key). */
export async function postWebhook(hook, payload) {
  try {
    const res = await fetch(hook.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${hook.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "manual",
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    res.body?.cancel?.().catch(() => {});
    return res.status === 200 ? { ok: true } : { ok: false, reason: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, reason: e?.name === "TimeoutError" ? "timed out after 8s" : "could not connect" };
  }
}
