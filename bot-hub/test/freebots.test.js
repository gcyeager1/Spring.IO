import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { hashPassword } from "../src/auth.js";
import { startServer, postJson } from "./helpers.js";
import { loadConfig } from "../src/config.js";
import { callBot, costOf, listPrice } from "../src/providers.js";

const EMAIL = "admin@example.com";
const PASSWORD = "a-long-test-password";
const OLD = { ts: Date.now() - 60_000, room: "dm:nova", account: "grok-1", bot: "nova", model: "grok-4.7", input: 100, cachedInput: 0, cacheWrite: 0, output: 50, cost: 0.01, ok: true };
let s, h;

// BOT_HUB_MOCK is deliberately empty: production-like, no mock, no API keys.
before(async () => {
  s = await startServer(
    { BOT_HUB_MOCK: "", BOTHUB_ADMIN_EMAIL: EMAIL, BOTHUB_ADMIN_PASSWORD_HASH: hashPassword(PASSWORD) },
    (dir) => fs.writeFileSync(path.join(dir, "usage.jsonl"), JSON.stringify(OLD) + "\n"),
  );
  const login = await postJson(s.base + "/api/login", { email: EMAIL, password: PASSWORD });
  h = { Cookie: (login.headers.get("set-cookie") ?? "").split(";")[0] };
});
after(() => s.stop());

const usage = async () => (await fetch(s.base + "/api/usage?days=all", { headers: h })).json();

test("config has 15 bots; nova/rook/sage are on the Free (no usage) account", () => {
  const cfg = loadConfig();
  assert.equal(cfg.bots.length, 15);
  const free = cfg.accountsById.get("free");
  assert.equal(free.name, "Free (no usage)");
  assert.equal(free.provider, "local");
  assert.ok(!free.apiKeyEnv);
  for (const id of ["nova", "rook", "sage"]) assert.equal(cfg.bots.find((b) => b.id === id).account, "free");
  assert.equal(cfg.bots.filter((b) => b.account === "grok-1").length, 5);
  assert.equal(cfg.bots.filter((b) => b.account === "grok-2").length, 6);
  assert.equal(cfg.bots.filter((b) => b.account === "claude").length, 1);
});

test("local provider costs $0 and has no list price", async () => {
  const free = loadConfig().accountsById.get("free");
  const u = { input: 1e6, output: 1e6, cachedInput: 0, cacheWrite: 0 };
  assert.equal(costOf(u, free), 0);
  assert.equal(listPrice(u, { inputPerM: 5, outputPerM: 5 }, free), 0);
  const r = await callBot({ id: "nova", name: "Nova", model: "canned", systemPrompt: "x" }, free, [{ speaker: "You", botId: null, text: "hi" }], ["You", "Nova"], { direct: true });
  assert.ok(r.text && !/mock/i.test(r.text));
  assert.equal(r.apiValue, undefined);
});

test("config API shows free account as ready, not a plan", async () => {
  const cfg = await (await fetch(s.base + "/api/config", { headers: h })).json();
  assert.equal(cfg.mock, false);
  const free = cfg.accounts.find((a) => a.id === "free");
  assert.equal(free.name, "Free (no usage)");
  assert.equal(free.problem, null);
  assert.equal(free.plan, false);
});

test("estimate for a free bot is $0", async () => {
  const res = await postJson(s.base + "/api/estimate", { room: "dm:nova", text: "hello there" }, h);
  const e = await res.json();
  assert.equal(e.message.cost, 0);
  assert.equal(e.message.planCalls, 0);
  assert.equal(e.message.perBot[0].cost, 0);
});

test("non-mock private chats with nova/rook/sage get canned replies at $0 on the free account", async () => {
  const before = await usage();
  for (const id of ["nova", "rook", "sage"]) {
    assert.equal((await postJson(s.base + "/api/messages", { room: `dm:${id}`, text: "hello" }, h)).status, 202);
    let msgs = [];
    for (let i = 0; i < 80; i++) {
      msgs = await (await fetch(`${s.base}/api/messages?room=dm:${id}`, { headers: h })).json();
      if (msgs.some((m) => m.botId === id)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const reply = msgs.find((m) => m.botId === id);
    assert.ok(reply, `${id} replied`);
    assert.ok(!reply.error && !/mock/i.test(reply.text));
    assert.equal(reply.account, "free");
  }
  const after = await usage();
  for (const id of ["grok-1", "grok-2", "claude"]) {
    assert.equal(after.byAccount[id].cost, before.byAccount[id].cost, id);
    assert.equal(after.byAccount[id].requests, before.byAccount[id].requests, id);
  }
  assert.equal(after.byAccount.free.requests, 3);
  assert.equal(after.byAccount.free.cost, 0);
  assert.equal(after.byAccount.free.errors, 0);
  for (const id of ["nova", "rook", "sage"]) assert.equal(after.byBot[id].cost, 0);
});

test("historical Grok-era nova row stays on grok-1, not on the free account or nova's card", async () => {
  const u = await usage();
  assert.equal(u.byAccount["grok-1"].cost, 0.01);
  assert.equal(u.byAccount["grok-1"].requests, 1);
  assert.equal(u.byAccount.free.cost, 0);
  assert.equal(u.byBot["nova@grok-1"].cost, 0.01);
  assert.equal(u.byBot.nova.cost, 0);
  assert.equal(u.byBot.nova.requests, 1); // only the free-era call above
  // the old row is untouched on disk
  const lines = fs.readFileSync(path.join(s.dataDir, "usage.jsonl"), "utf8").trim().split("\n");
  assert.deepEqual(JSON.parse(lines[0]), OLD);
});
