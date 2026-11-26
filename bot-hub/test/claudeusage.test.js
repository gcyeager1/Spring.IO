import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bothub-cu-"));
process.env.DATA_DIR = DIR;
const cu = await import("../src/claude-usage.js");
const { validateClaudeFeed, claudeWindows, claudeSlices, fmtResetIn, pieSvg } = await import("../public/planusage.js");
const { hashPassword } = await import("../src/auth.js");
const { startServer, postJson } = await import("./helpers.js");

const SAMPLE = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed", resetsAt: 1796043600, rateLimitType: "seven_day", overageStatus: "rejected", isUsingOverage: false,
    unifiedWindows: { seven_day: { utilization: 0.02, resetsAt: 1796043600, status: "allowed" } },
  },
};
const clear = () => fs.rmSync(path.join(DIR, "claude-usage.json"), { force: true });
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test("parseRateLimitEvent: unifiedWindows, fallback, overage, garbage", () => {
  const w = cu.parseRateLimitEvent(SAMPLE);
  assert.deepEqual(w.seven_day, { usedPct: 2, resetsAt: new Date(1796043600e3).toISOString(), status: "allowed" });
  const top = cu.parseRateLimitEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.456, resetsAt: 1796043600 } });
  assert.equal(top.five_hour.usedPct, 45.6);
  const noUtil = cu.parseRateLimitEvent({ type: "rate_limit_event", rate_limit_info: { rateLimitType: "five_hour", resetsAt: 1796043600 } });
  assert.deepEqual(noUtil, {});
  const over = cu.parseRateLimitEvent({ type: "rate_limit_event", rate_limit_info: { rateLimitType: "overage", utilization: 0.5, resetsAt: 1796043600, unifiedWindows: { overage: { utilization: 1, resetsAt: 1796043600 }, bogus: { utilization: 1, resetsAt: 1 } } } });
  assert.deepEqual(over, {});
  for (const g of [null, "x", 5, {}, { type: "result" }, { type: "rate_limit_event" }]) assert.equal(cu.parseRateLimitEvent(g), null);
});

test("extractFromStreamJson tolerates junk lines", () => {
  const out = ["not json", JSON.stringify({ type: "system" }), JSON.stringify(SAMPLE), "{broken",
    JSON.stringify({ type: "rate_limit_event", rate_limit_info: { rateLimitType: "five_hour", utilization: 0.1, resetsAt: 1796043600 } }),
    JSON.stringify({ type: "result", subtype: "success", result: "ok" })].join("\n");
  const r = cu.extractFromStreamJson(out);
  assert.equal(r.result.result, "ok");
  assert.deepEqual(Object.keys(r.windows).sort(), ["five_hour", "seven_day"]);
  assert.deepEqual(cu.extractFromStreamJson("nope"), { result: null, windows: null });
});

test("record merges per window; expired window reads as reset", () => {
  clear();
  assert.equal(cu.getClaudeUsage(), null);
  const future = new Date(Date.now() + 3600e3).toISOString();
  const past = new Date(Date.now() - 3600e3).toISOString();
  cu.recordClaudeUsage({ five_hour: { usedPct: 10, resetsAt: past, status: "allowed" }, seven_day: { usedPct: 20, resetsAt: future, status: "allowed" } }, "hub");
  cu.recordClaudeUsage({ seven_day: { usedPct: 30, resetsAt: future, status: "allowed" } }, "feed");
  const g = cu.getClaudeUsage();
  assert.equal(g.account, "claude");
  assert.equal(g.source, "feed");
  assert.equal(g.windows.seven_day.usedPct, 30);
  assert.equal(g.windows.five_hour.usedPct, 0);
  assert.equal(g.windows.five_hour.reset, true);
  assert.ok(g.updatedAt);
});

test("validateClaudeFeed", () => {
  const ok = validateClaudeFeed({ account: "claude", windows: { five_hour: { usedPct: 12.34, resetsAt: 1796043600 }, seven_day: { usedPct: 3, resetsAt: "2026-12-01T00:00:00Z" } } });
  assert.equal(ok.windows.five_hour.usedPct, 12.3);
  assert.equal(ok.windows.five_hour.resetsAt, new Date(1796043600e3).toISOString());
  for (const bad of [null, { account: "x" }, { account: "claude" }, { account: "claude", windows: {} },
    { account: "claude", windows: { five_hour: { usedPct: "1", resetsAt: 1 } } },
    { account: "claude", windows: { five_hour: { usedPct: -1, resetsAt: 1 } } },
    { account: "claude", windows: { five_hour: { usedPct: 1, resetsAt: "nope" } } }]) {
    assert.ok(validateClaudeFeed(bad).error, JSON.stringify(bad));
  }
});

test("claudeWindows ordering/labels and pie markup", () => {
  const f = new Date(Date.now() + 1e7).toISOString();
  const w = claudeWindows({ windows: { seven_day_opus: { usedPct: 5, resetsAt: f }, five_hour: { usedPct: 85, resetsAt: f }, seven_day: { usedPct: 40, resetsAt: f } } });
  assert.deepEqual(w.map((x) => x.label), ["5-hour", "Weekly", "Opus weekly"]);
  assert.deepEqual(claudeWindows(null), []);
  const svg = pieSvg(claudeSlices(w[0]), 84, "5-hour used");
  assert.match(svg, /<title>Used 85%<\/title>/);
  assert.match(svg, /var\(--warn\)/);
  assert.match(pieSvg(claudeSlices(w[1])), /var\(--series-1\)/);
  assert.equal(fmtResetIn(new Date(Date.now() + 134 * 60e3 + 5e3).toISOString()), "in 2h 14m");
  assert.equal(fmtResetIn(new Date(Date.now() - 1000).toISOString()), "now");
});

function fakeSpawn(stdout, calls = []) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => { child.stdout.emit("data", stdout); child.emit("close", 0); });
    return child;
  };
}
const NOON_ET = Date.parse("2026-11-26T17:00:00Z"); // 12:00 EST
const NIGHT_ET = Date.parse("2026-11-26T05:00:00Z"); // 00:00 EST

test("probe: records, skips outside hours, skips when recent", async () => {
  const out = JSON.stringify(SAMPLE) + "\n" + JSON.stringify({ type: "result", subtype: "success", result: "ok" });
  const calls = [];
  clear();
  cu.setClaudeUsageDeps({ spawn: fakeSpawn(out, calls), now: () => NIGHT_ET });
  assert.equal((await cu.probeTick(60)).skipped, "hours");
  assert.equal(calls.length, 0);
  process.env.ANTHROPIC_API_KEY = "should-not-leak";
  cu.setClaudeUsageDeps({ spawn: fakeSpawn(out, calls), now: () => NOON_ET });
  assert.equal((await cu.probeTick(60)).ok, true);
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes("stream-json"));
  assert.equal(calls[0].opts.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(cu.getClaudeUsage(NOON_ET).windows.seven_day.usedPct, 2);
  assert.equal((await cu.probeTick(60)).skipped, "fresh");
  assert.equal(calls.length, 1);
  cu.setClaudeUsageDeps();
});

test("probe failure never throws", async () => {
  clear();
  cu.setClaudeUsageDeps({ spawn: fakeSpawn("garbage"), now: () => NOON_ET });
  const r = await cu.refreshClaudeUsageNow();
  assert.equal(r.ok, false);
  assert.equal(cu.getClaudeUsage(), null);
  cu.setClaudeUsageDeps();
});

// ---- server ----
const TOKEN = "ingest-token-for-tests-123";
const bearer = { Authorization: `Bearer ${TOKEN}` };
let s;
before(async () => {
  s = await startServer({ BOTHUB_ADMIN_EMAIL: "a@example.com", BOTHUB_ADMIN_PASSWORD_HASH: hashPassword("a-long-test-password"), BOTHUB_INGEST_TOKEN: TOKEN });
});
after(() => s?.stop());

test("server: claude feed via /api/plan-usage", async () => {
  assert.equal((await fetch(s.base + "/api/plan-usage")).status, 401);
  assert.equal((await postJson(s.base + "/api/plan-usage", { account: "claude", windows: {} })).status, 401);
  const empty = await (await fetch(s.base + "/api/plan-usage", { headers: bearer })).json();
  assert.ok("claude" in empty);
  assert.equal(empty.claude, null);
  assert.equal((await postJson(s.base + "/api/plan-usage", { account: "claude", windows: { five_hour: { usedPct: "x" } } }, bearer)).status, 400);
  const ok = await postJson(s.base + "/api/plan-usage", { account: "claude", windows: { five_hour: { usedPct: 42, resetsAt: new Date(Date.now() + 3600e3).toISOString() } } }, bearer);
  assert.equal(ok.status, 200);
  const got = await (await fetch(s.base + "/api/plan-usage", { headers: bearer })).json();
  assert.equal(got.claude.windows.five_hour.usedPct, 42);
  assert.equal(got.claude.source, "feed");
  assert.equal((await postJson(s.base + "/api/claude-usage/refresh", {}, bearer)).status, 401);
});
