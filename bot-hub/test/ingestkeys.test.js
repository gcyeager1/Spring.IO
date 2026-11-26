import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { hashPassword } from "../src/auth.js";
import { startServer, postJson, cookieOf } from "./helpers.js";

const MASTER = "master-token-for-tests-456";
const REPORT = (account) => ({
  account, plan: "Ultra", percentUsed: 8.1, resetsAt: "2026-12-03T06:36:00-05:00",
  onDemand: "Additional usage credits left: $0", period: "this_week",
  bots: [{ name: "Dummy", sharePct: 48 }], routines: [], reportedAt: "2026-11-26T15:21:00-05:00",
});
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
let s, cookie;
const reveal = async () => (await (await fetch(s.base + "/api/ingest-keys/garrett/reveal", { method: "POST", headers: { Cookie: cookie } })).json()).token;

before(async () => {
  s = await startServer({ BOTHUB_ADMIN_EMAIL: "a@example.com", BOTHUB_ADMIN_PASSWORD_HASH: hashPassword("a-long-test-password"), BOTHUB_INGEST_TOKEN: MASTER });
  const login = await postJson(s.base + "/api/login", { email: "a@example.com", password: "a-long-test-password" });
  cookie = cookieOf(login);
});
after(() => s.stop());

test("key routes need a session", async () => {
  for (const [m, p] of [["GET", "/api/ingest-keys"], ["POST", "/api/ingest-keys/garrett/reveal"], ["POST", "/api/ingest-keys/garrett/regenerate"]]) {
    assert.equal((await fetch(s.base + p, { method: m })).status, 401, p);
    assert.equal((await fetch(s.base + p, { method: m, headers: bearer(MASTER) })).status, 401, p + " master bearer");
  }
});

test("POST without Authorization is 401", async () => {
  assert.equal((await postJson(s.base + "/api/plan-usage", REPORT("garrett"))).status, 401);
});

test("metadata never includes the token", async () => {
  const token = await reveal();
  const r = await fetch(s.base + "/api/ingest-keys", { headers: { Cookie: cookie } });
  const text = await r.text();
  assert.equal(JSON.parse(text).garrett.exists, true);
  assert.ok(!text.includes(token));
  const cfg = await (await fetch(s.base + "/api/config", { headers: { Cookie: cookie } })).text();
  assert.ok(!cfg.includes(token));
});

test("garrett key posts garrett only; master posts both", async () => {
  const token = await reveal();
  assert.ok(token && token.length >= 32);
  const bad = await postJson(s.base + "/api/plan-usage", REPORT("lifteasy"), bearer(token));
  assert.equal(bad.status, 403);
  assert.equal((await postJson(s.base + "/api/plan-usage", REPORT("garrett"), bearer(token))).status, 200);
  // garrett key cannot read
  assert.equal((await fetch(s.base + "/api/plan-usage", { headers: bearer(token) })).status, 401);
  assert.equal((await postJson(s.base + "/api/plan-usage", REPORT("lifteasy"), bearer(MASTER))).status, 200);
  assert.equal((await postJson(s.base + "/api/plan-usage", REPORT("garrett"), bearer(MASTER))).status, 200);
  const got = await (await fetch(s.base + "/api/plan-usage", { headers: bearer(MASTER) })).json();
  assert.equal(got.garrett.bots[0].name, "Dummy");
  assert.equal(got.lifteasy.account, "lifteasy");
});

test("regenerate revokes the old key; token never appears in server output; file is 0600", async () => {
  const old = await reveal();
  const res = await fetch(s.base + "/api/ingest-keys/garrett/regenerate", { method: "POST", headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const fresh = (await res.json()).token;
  assert.notEqual(fresh, old);
  assert.equal((await postJson(s.base + "/api/plan-usage", REPORT("garrett"), bearer(old))).status, 401);
  assert.equal((await postJson(s.base + "/api/plan-usage", REPORT("garrett"), bearer(fresh))).status, 200);
  assert.equal(await reveal(), fresh);
  assert.ok(!s.output().includes(fresh) && !s.output().includes(old));
  const mode = fs.statSync(path.join(s.dataDir, "ingest-key-garrett.json")).mode & 0o777;
  assert.equal(mode, 0o600);
});
