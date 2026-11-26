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

export const getChat = () => chat;

export function clearChat() {
  chat.length = 0;
  fs.writeFileSync(CHAT_FILE, "");
}

/** Aggregate usage since `sinceMs`, by account, by bot and by day (UTC). */
export function summarizeUsage(sinceMs, accounts, bots) {
  const rows = usage.filter((u) => u.ts >= sinceMs);
  const blank = () => ({ requests: 0, errors: 0, input: 0, cachedInput: 0, cacheWrite: 0, output: 0, cost: 0 });
  const add = (acc, u) => {
    acc.requests += 1;
    if (!u.ok) acc.errors += 1;
    acc.input += u.input ?? 0;
    acc.cachedInput += u.cachedInput ?? 0;
    acc.cacheWrite += u.cacheWrite ?? 0;
    acc.output += u.output ?? 0;
    acc.cost += u.cost ?? 0;
  };

  const byAccount = Object.fromEntries(accounts.map((a) => [a.id, blank()]));
  const byBot = Object.fromEntries(bots.map((b) => [b.id, blank()]));
  const byDay = {};
  const total = blank();
  for (const u of rows) {
    (byAccount[u.account] ??= blank()), add(byAccount[u.account], u);
    (byBot[u.bot] ??= blank()), add(byBot[u.bot], u);
    const day = new Date(u.ts).toISOString().slice(0, 10);
    byDay[day] ??= {};
    (byDay[day][u.account] ??= blank()), add(byDay[day][u.account], u);
    add(total, u);
  }
  const latencies = rows.filter((u) => u.ok && u.latencyMs).map((u) => u.latencyMs);
  total.avgLatencyMs = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
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
  // Latest call per account, regardless of range, for the status strip.
  const lastByAccount = {};
  for (const u of usage) lastByAccount[u.account] = { ts: u.ts, ok: u.ok, error: u.error };
  return {
    since: sinceMs,
    now: Date.now(),
    total,
    byAccount,
    byBot,
    byDay,
    points,
    lastByAccount,
    recent: rows.slice(-25).reverse(),
  };
}
