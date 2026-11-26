import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataDir } from "./config.js";

// Claude plan usage, read only from what the `claude` CLI prints (the documented
// `rate_limit_event` stream message). No Anthropic HTTP endpoint is ever called here.

// An empty working folder, so Claude Code doesn't pick up this project's files or settings.
export const CC_CWD = path.join(os.tmpdir(), "bot-hub-claude-code");
fs.mkdirSync(CC_CWD, { recursive: true });

export const WINDOW_KEYS = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"];
const file = () => path.join(dataDir(), "claude-usage.json");

const round1 = (n) => Math.round(n * 10) / 10;
const isoFromSeconds = (s) => {
  const n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

function windowFrom(w) {
  if (!w || typeof w !== "object") return null;
  const u = Number(w.utilization);
  if (w.utilization == null || !Number.isFinite(u)) return null;
  const resetsAt = isoFromSeconds(w.resetsAt);
  if (!resetsAt) return null;
  return { usedPct: round1(u * 100), resetsAt, status: typeof w.status === "string" ? w.status : "allowed" };
}

/** Parse one stream-json object. Returns { five_hour?, seven_day?, ... } or null if not a rate_limit_event. */
export function parseRateLimitEvent(evt) {
  if (!evt || typeof evt !== "object" || evt.type !== "rate_limit_event") return null;
  const info = evt.rate_limit_info;
  if (!info || typeof info !== "object") return null;
  const out = {};
  const uw = info.unifiedWindows;
  if (uw && typeof uw === "object") {
    for (const key of WINDOW_KEYS) {
      const w = windowFrom(uw[key]);
      if (w) out[key] = w;
    }
  }
  if (WINDOW_KEYS.includes(info.rateLimitType) && !out[info.rateLimitType]) {
    const w = windowFrom(info);
    if (w) out[info.rateLimitType] = w;
  }
  return out;
}

/** Parse the stdout of `claude --output-format stream-json`. Tolerates non-JSON lines. */
export function extractFromStreamJson(stdoutText) {
  let result = null;
  let windows = null;
  for (const line of String(stdoutText ?? "").split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let o;
    try { o = JSON.parse(t); } catch { continue; }
    if (o?.type === "result") result = o;
    const w = parseRateLimitEvent(o);
    if (w && Object.keys(w).length) windows = { ...(windows ?? {}), ...w };
  }
  return { result, windows };
}

function readStore() {
  try {
    const d = JSON.parse(fs.readFileSync(file(), "utf8"));
    return d && typeof d === "object" ? d : null;
  } catch {
    return null;
  }
}

/** Merge windows into the stored set (a new value for a window replaces the old one). */
export function recordClaudeUsage(windows, source = "hub", now = Date.now()) {
  if (!windows || !Object.keys(windows).length) return;
  const cur = readStore();
  const merged = { ...(cur?.windows ?? {}) };
  for (const key of WINDOW_KEYS) if (windows[key]) merged[key] = windows[key];
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ windows: merged, updatedAt: new Date(now).toISOString(), source }));
  } catch (e) {
    console.log(`claude usage not saved: ${e?.code ?? "error"}`);
  }
}

export function getClaudeUsage(now = Date.now()) {
  const cur = readStore();
  if (!cur?.windows || !Object.keys(cur.windows).length) return null;
  const windows = {};
  for (const [k, w] of Object.entries(cur.windows)) {
    const past = new Date(w.resetsAt).getTime() <= now;
    windows[k] = past ? { ...w, usedPct: 0, reset: true } : w;
  }
  return { account: "claude", plan: "Claude", windows, updatedAt: cur.updatedAt, source: cur.source };
}

// ---------- Server-side probe ----------

const PROBE_ARGS = [
  "-p", "Reply with just: ok",
  "--output-format", "stream-json", "--verbose",
  "--model", "haiku",
  "--tools", "",
  "--max-turns", "1",
  "--no-session-persistence",
  "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
  "--system-prompt", "Reply with just: ok",
];

const deps = { spawn, now: () => Date.now() };
/** Test hook: swap the spawn function and/or clock. Call with no args to restore. */
export function setClaudeUsageDeps(d = {}) {
  deps.spawn = d.spawn ?? spawn;
  deps.now = d.now ?? (() => Date.now());
}

let running = false;
let lastRunAt = 0;
let probeCommand = "claude";
export const claudeUsageLastRunAt = () => lastRunAt;
export const claudeUsageRunning = () => running;

/** Run the CLI once and record any rate-limit windows. Never throws. Returns { ok, skipped?, error? }. */
export async function refreshClaudeUsageNow(command = probeCommand) {
  if (running) return { ok: false, skipped: "running" };
  running = true;
  lastRunAt = deps.now();
  try {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    const out = await new Promise((resolve, reject) => {
      let child;
      try {
        child = deps.spawn(command, PROBE_ARGS, { cwd: CC_CWD, env, stdio: ["ignore", "pipe", "ignore"] });
      } catch (e) { return reject(e); }
      let stdout = "";
      const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch {} reject(new Error("timed out")); }, 60_000);
      child.stdout?.on("data", (d) => (stdout += d));
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout }); });
    });
    const { windows } = extractFromStreamJson(out.stdout);
    if (!windows) {
      console.log(`claude usage probe failed: ${out.code ? `exit ${out.code}` : "no rate limit data"}`);
      return { ok: false, error: "no rate limit data" };
    }
    recordClaudeUsage(windows, "hub", deps.now());
    return { ok: true };
  } catch (e) {
    console.log(`claude usage probe failed: ${e?.code === "ENOENT" ? "claude not found" : String(e?.message ?? "error").slice(0, 100)}`);
    return { ok: false, error: "failed" };
  } finally {
    running = false;
  }
}

const easternHour = (ms) =>
  Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date(ms))) % 24;

/** One probe tick: skips when data is fresh or outside 7:00-20:59 ET. */
export async function probeTick(intervalMin) {
  const now = deps.now();
  const cur = readStore();
  if (cur?.updatedAt && now - new Date(cur.updatedAt).getTime() < intervalMin * 60_000) return { ok: true, skipped: "fresh" };
  const h = easternHour(now);
  if (h < 7 || h > 20) return { ok: true, skipped: "hours" };
  return refreshClaudeUsageNow();
}

export function startClaudeUsageProbe({ account, intervalMin = Number(process.env.CLAUDE_USAGE_PROBE_MINUTES ?? 60), mock = false } = {}) {
  if (!account || mock || !Number.isFinite(intervalMin) || intervalMin <= 0) return () => {};
  probeCommand = account.command ?? "claude";
  const first = setTimeout(() => void probeTick(intervalMin), 20_000);
  const timer = setInterval(() => void probeTick(intervalMin), intervalMin * 60_000);
  first.unref?.();
  timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
