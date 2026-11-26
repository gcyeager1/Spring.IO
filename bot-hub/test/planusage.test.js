import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { hashPassword } from "../src/auth.js";
import { startServer, postJson, cookieOf } from "./helpers.js";
import { fmtShare, isLeftoverBucket, reportFor, validateReport } from "../public/planusage.js";

const TOKEN = "ingest-token-for-tests-123";
const LEFTOVER = "Deleted bots, group chats and other people's bots";
const FIXTURE = {
  account: "lifteasy",
  plan: "Ultra",
  percentUsed: 8.1,
  resetsAt: "2026-12-03T06:36:00-05:00",
  onDemand: "Additional usage credits left: $0",
  period: "this_week",
  bots: [
    { name: "Asschub", sharePct: 48 },
    { name: "Crm", sharePct: 36 },
    { name: "Leads", sharePct: 10 },
    { name: "Addy", sharePct: 6 },
    { name: "Usage", sharePct: 0.5 },
    { name: LEFTOVER, sharePct: 0.5 },
  ],
  reportedAt: "2026-11-26T15:21:00-05:00",
};
const bearer = (t = TOKEN) => ({ Authorization: `Bearer ${t}` });
let s;

before(async () => {
  // Old retired bot ids in the data dir must not break boot or the dashboard.
  s = await startServer({ BOTHUB_ADMIN_EMAIL: "a@example.com", BOTHUB_ADMIN_PASSWORD_HASH: hashPassword("a-long-test-password"), BOTHUB_INGEST_TOKEN: TOKEN }, (dir) => {
    const row = { ts: Date.now(), room: "group", account: "grok-1", bot: "nova", model: "grok-4.7", input: 10, output: 5, cost: 0.001, ok: true };
    fs.writeFileSync(path.join(dir, "usage.jsonl"), JSON.stringify(row) + "\n");
    fs.writeFileSync(path.join(dir, "chat.jsonl"), JSON.stringify({ id: "1", ts: Date.now(), speaker: "Nova", botId: "nova", text: "hi" }) + "\n");
  });
});
after(() => s.stop());

test("plan-usage rejects missing and wrong tokens with the same error", async () => {
  const a = await postJson(s.base + "/api/plan-usage", FIXTURE);
  const b = await postJson(s.base + "/api/plan-usage", FIXTURE, bearer("wrong"));
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.deepEqual(await a.json(), await b.json());
  assert.equal((await fetch(s.base + "/api/plan-usage")).status, 401);
});

test("ingest, read back with the bearer token, usage stays session-only", async () => {
  assert.equal((await postJson(s.base + "/api/plan-usage", { ...FIXTURE, bots: [] }, bearer())).status, 400);
  assert.equal((await postJson(s.base + "/api/plan-usage", { ...FIXTURE, account: "x" }, bearer())).status, 400);
  assert.equal((await postJson(s.base + "/api/plan-usage", { ...FIXTURE, percentUsed: "8" }, bearer())).status, 400);
  const ok = await postJson(s.base + "/api/plan-usage", FIXTURE, bearer());
  assert.equal(ok.status, 200);
  const got = await (await fetch(s.base + "/api/plan-usage", { headers: bearer() })).json();
  assert.equal(got.lifteasy.percentUsed, 8.1);
  assert.equal(got.lifteasy.bots.length, 6);
  assert.equal(got.garrett, null);
  assert.equal((await fetch(s.base + "/api/usage", { headers: bearer() })).status, 401);
  assert.ok(fs.existsSync(path.join(s.dataDir, "plan-usage-latest.json")));
  assert.equal(fs.readFileSync(path.join(s.dataDir, "plan-usage.jsonl"), "utf8").trim().split("\n").length, 1);
});

test("session sees planUsage in /api/usage; old bot ids don't break it", async () => {
  const login = await postJson(s.base + "/api/login", { email: "a@example.com", password: "a-long-test-password" });
  const h = { Cookie: cookieOf(login) };
  const u = await (await fetch(s.base + "/api/usage?days=all", { headers: h })).json();
  assert.equal(u.planUsage.lifteasy.plan, "Ultra");
  assert.equal(u.planUsage.garrett, null);
  // Nova is now a free-account bot: its Grok-era row is split out, not shown as free spend.
  assert.equal(u.byBot.nova.requests, 0);
  assert.equal(u.byBot["nova@grok-1"].requests, 1);
  assert.equal((await fetch(s.base + "/api/plan-usage", { headers: h })).status, 200);
  const cfg = await (await fetch(s.base + "/api/config", { headers: h })).json();
  assert.equal(cfg.bots.length, 15);
  assert.deepEqual(cfg.accounts.map((a) => a.name), ["Lifteasy Door Services", "garrett yeager", "Claude (your plan)", "Free (no usage)"]);
});

test("ingest is disabled when BOTHUB_INGEST_TOKEN is unset", async () => {
  const t = await startServer();
  try {
    assert.equal((await postJson(t.base + "/api/plan-usage", FIXTURE, bearer(""))).status, 401);
    assert.equal((await postJson(t.base + "/api/plan-usage", FIXTURE, bearer("undefined"))).status, 401);
  } finally {
    await t.stop();
  }
});

test("helpers: <1% formatting, leftover bucket, empty account", () => {
  assert.equal(fmtShare(0.5), "<1%");
  assert.equal(fmtShare(48), "48%");
  assert.equal(fmtShare(1.25), "1.3%");
  assert.ok(isLeftoverBucket(LEFTOVER));
  assert.ok(!isLeftoverBucket("Asschub"));
  assert.equal(reportFor({ lifteasy: null, garrett: null }, "garrett"), null);
  assert.equal(validateReport(FIXTURE).report.bots.length, 6);
  assert.ok(validateReport({ ...FIXTURE, bots: [{ name: "a" }] }).error);
});
