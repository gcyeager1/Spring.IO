import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";

const DATA = path.join(ROOT, "data");
fs.mkdirSync(DATA, { recursive: true });
const USAGE_FILE = path.join(DATA, "usage.jsonl");
const CHAT_FILE = path.join(DATA, "chat.jsonl");

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

// Rooms: "group" for the group chat, "dm:<botId>" for a private chat with one bot.
// Records written before rooms existed belong to the group chat.
const roomOf = (x) => x.room ?? "group";
export const isDirect = (room) => String(room).startsWith("dm:");

const usage = readJsonl(USAGE_FILE);
const chat = readJsonl(CHAT_FILE);

export function recordUsage(entry) {
  usage.push(entry);
  fs.appendFileSync(USAGE_FILE, JSON.stringify(entry) + "\n");
}

export function addMessage(msg) {
  chat.push(msg);
  fs.appendFileSync(CHAT_FILE, JSON.stringify(msg) + "\n");
  return msg;
}

/** Messages in one room, or every message (each tagged with its room) when room is omitted. */
export const getChat = (room) =>
  room ? chat.filter((m) => roomOf(m) === room) : chat.map((m) => ({ ...m, room: roomOf(m) }));

export function clearChat(room) {
  const keep = chat.filter((m) => roomOf(m) !== room);
  chat.length = 0;
  chat.push(...keep);
  fs.writeFileSync(CHAT_FILE, keep.map((m) => JSON.stringify(m) + "\n").join(""));
}

const blank = () => ({
  requests: 0,
  errors: 0,
  input: 0,
  cachedInput: 0,
  cacheWrite: 0,
  output: 0,
  cost: 0,
  latencySum: 0,
  latencyN: 0,
  groupCost: 0,
  groupCalls: 0,
  directCost: 0,
  directCalls: 0,
});
function add(acc, u) {
  acc.requests += 1;
  if (!u.ok) acc.errors += 1;
  acc.input += u.input ?? 0;
  acc.cachedInput += u.cachedInput ?? 0;
  acc.cacheWrite += u.cacheWrite ?? 0;
  acc.output += u.output ?? 0;
  acc.cost += u.cost ?? 0;
  if (u.ok && u.latencyMs) {
    acc.latencySum += u.latencyMs;
    acc.latencyN += 1;
  }
  if (isDirect(roomOf(u))) {
    acc.directCost += u.cost ?? 0;
    acc.directCalls += 1;
  } else {
    acc.groupCost += u.cost ?? 0;
    acc.groupCalls += 1;
  }
}
const day = (ts) => new Date(ts).toISOString().slice(0, 10);

/**
 * Usage since `sinceMs`. When `botFilter` is set, totals, charts and the call
 * log cover only that bot; the per-bot and per-account breakdowns always
 * cover every bot so they can be compared side by side.
 */
export function summarizeUsage(sinceMs, accounts, bots, botFilter, todayStart = 0) {
  const inRange = usage.filter((u) => u.ts >= sinceMs);
  const rows = botFilter ? inRange.filter((u) => u.bot === botFilter) : inRange;

  const total = blank();
  const byDay = {}; // day -> botId -> stats (filtered)
  for (const u of rows) {
    add(total, u);
    const d = (byDay[day(u.ts)] ??= {});
    add((d[u.bot] ??= blank()), u);
  }

  const byBot = Object.fromEntries(bots.map((b) => [b.id, { ...blank(), daily: {} }]));
  const byAccount = Object.fromEntries(accounts.map((a) => [a.id, blank()]));
  for (const u of inRange) {
    const b = (byBot[u.bot] ??= { ...blank(), daily: {} });
    add(b, u);
    b.daily[day(u.ts)] = (b.daily[day(u.ts)] ?? 0) + (u.cost ?? 0);
    add((byAccount[u.account] ??= blank()), u);
  }

  // Compact per-call points for client-side charts (time series, heatmap), newest 20k.
  const points = rows.slice(-20000).map((u) => [
    u.ts,
    u.account,
    u.bot,
    u.cost ?? 0,
    (u.input ?? 0) + (u.cachedInput ?? 0) + (u.cacheWrite ?? 0),
    u.output ?? 0,
    u.ok ? 1 : 0,
  ]);

  // Latest call per account and per bot, regardless of range, for status indicators.
  const lastByAccount = {};
  const lastByBot = {};
  for (const u of usage) {
    const last = { ts: u.ts, ok: u.ok, error: u.error };
    lastByAccount[u.account] = last;
    lastByBot[u.bot] = last;
  }

  // Spend since the viewer's local midnight, across every bot (for the status strip).
  const today = { cost: 0, calls: 0 };
  if (todayStart) {
    for (const u of usage) {
      if (u.ts >= todayStart) {
        today.cost += u.cost ?? 0;
        today.calls += 1;
      }
    }
  }

  return {
    since: sinceMs,
    today,
    now: Date.now(),
    bot: botFilter ?? null,
    total,
    byBot,
    byAccount,
    byDay,
    points,
    lastByAccount,
    lastByBot,
    recent: rows.slice(-30).reverse().map((u) => ({ ...u, room: roomOf(u) })),
  };
}

/** Read-only view of every usage record (for estimates). */
export const getUsage = () => usage;
