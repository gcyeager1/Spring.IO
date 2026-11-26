import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { hashPassword } from "../src/auth.js";
import { startServer, postJson } from "./helpers.js";

const EMAIL = "admin@example.com";
const PASSWORD = "a-long-test-password";
const ENV_KEY = "env-hook-key-111";
const VOL_KEY = "vol-hook-key-222";
const REPLY = "env-reply-token-333";
const GOOD = "https://api2.cursor.sh/automations/webhook/abc";
const NOON = "2026-06-03T15:00:00-04:00";
const BOTS = ["asschub", "leads-lifteasy", "addy", "crm", "usage-bot", "dummy", "crm-builder", "leads-garrett", "ads", "socials", "pawn"];

const hits = [];
const listener = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => { hits.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw || "{}") }); res.writeHead(200); res.end("{}"); });
});
let port;
before(async () => { await new Promise((r) => listener.listen(0, "127.0.0.1", r)); port = listener.address().port; });
after(() => listener.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withServer(extra, fn) {
  const s = await startServer({ BOTHUB_ADMIN_EMAIL: EMAIL, BOTHUB_ADMIN_PASSWORD_HASH: hashPassword(PASSWORD), BOTHUB_NOW: NOON, ...extra });
  try {
    const r = await postJson(s.base + "/api/login", { email: EMAIL, password: PASSWORD });
    const h = { Cookie: (r.headers.get("set-cookie") ?? "").split(";")[0] };
    await fn(s, h);
  } finally { await s.stop(); }
}
const put = (s, h, id, body) => fetch(`${s.base}/api/bridge/${id}`, { method: "PUT", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(body) });
const del = (s, h, id) => fetch(`${s.base}/api/bridge/${id}`, { method: "DELETE", headers: h });
const view = async (s, h) => (await (await fetch(s.base + "/api/bridge", { headers: h })).json()).bots;
const garrettToken = async (s, h) => (await (await postJson(s.base + "/api/reply-tokens/garrett/reveal", {}, h)).json()).token;
const reply = (s, token, body) => postJson(s.base + "/api/agent-reply", body, { Authorization: `Bearer ${token}` });
const seedJob = (id, botId, account) => (dir) => fs.writeFileSync(path.join(dir, "agent-jobs.json"), JSON.stringify({
  jobs: { [id]: { id, botId, room: `dm:${botId}`, account, ts: Date.parse(NOON) - 60_000, status: "open", timeoutNoted: true } }, wakes: [],
}));

test("every new route is 401 without a session, even with ingest/reply bearers", async () => {
  await withServer({ BOTHUB_REPLY_TOKEN: REPLY, BOTHUB_INGEST_TOKEN: "ingest-tok-444" }, async (s, h) => {
    const gt = await garrettToken(s, h);
    const routes = [["GET", "/api/bridge"], ["PUT", "/api/bridge/dummy"], ["DELETE", "/api/bridge/dummy"], ["GET", "/api/reply-tokens"],
      ["POST", "/api/reply-tokens/lifteasy/reveal"], ["POST", "/api/reply-tokens/garrett/reveal"], ["POST", "/api/reply-tokens/garrett/regenerate"]];
    for (const [method, p] of routes) {
      for (const headers of [{}, { Authorization: `Bearer ${REPLY}` }, { Authorization: "Bearer ingest-tok-444" }, { Authorization: `Bearer ${gt}` }]) {
        const r = await fetch(s.base + p, { method, headers: { "Content-Type": "application/json", ...headers }, body: method === "GET" || method === "DELETE" ? undefined : "{}" });
        assert.equal(r.status, 401, `${method} ${p}`);
      }
    }
  });
});

test("URL validation on save; only the 11 Grok bots are accepted; nothing invalid is persisted", async () => {
  await withServer({}, async (s, h) => {
    assert.equal((await put(s, h, "dummy", { url: GOOD, key: VOL_KEY })).status, 200);
    for (const bad of [
      "http://api2.cursor.sh/automations/webhook/abc", "https://evil.com/automations/webhook/x", "https://evilcursor.sh/automations/webhook/x",
      "https://cursor.sh.evil.com/automations/webhook/x", "https://api2.cursor.sh/other/abc", "https://user:pw@api2.cursor.sh/automations/webhook/x",
      "https://user@api2.cursor.sh/automations/webhook/x", "https://api2.cursor.sh:8443/automations/webhook/x", "not a url", "",
    ]) assert.equal((await put(s, h, "ads", { url: bad, key: VOL_KEY })).status, 400, bad);
    assert.equal((await put(s, h, "ads", { url: "https://api2.cursor.sh:443/automations/webhook/x", key: VOL_KEY })).status, 200);
    assert.equal((await put(s, h, "pawn", { url: "https://a.cursor.sh/automations/webhook/x", key: VOL_KEY })).status, 200);
    assert.equal((await put(s, h, "socials", { url: GOOD })).status, 400, "no key anywhere");
    for (const id of ["claude", "nova", "rook", "sage", "nobody"]) {
      assert.equal((await put(s, h, id, { url: GOOD, key: VOL_KEY })).status, 400, id);
      assert.equal((await del(s, h, id)).status, 400, id);
    }
    const v = await view(s, h);
    assert.deepEqual(v.map((b) => b.id), BOTS);
    assert.ok(v.find((b) => b.id === "claude") === undefined);
    assert.equal(v.find((b) => b.id === "socials").keySet, false);
    const saved = JSON.parse(fs.readFileSync(path.join(s.dataDir, "bridge-webhooks.json"), "utf8"));
    assert.deepEqual(Object.keys(saved).sort(), ["ads", "dummy", "pawn"]);
  });
});

test("volume file is 0600; views, config and logs never contain keys or tokens", async () => {
  await withServer({ BOTHUB_REPLY_TOKEN: REPLY, [`BOTHUB_WEBHOOK_URL_ADDY`]: GOOD, [`BOTHUB_WEBHOOK_KEY_ADDY`]: ENV_KEY }, async (s, h) => {
    assert.equal((await put(s, h, "dummy", { url: GOOD, key: VOL_KEY })).status, 200);
    const f = path.join(s.dataDir, "bridge-webhooks.json");
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(s.dataDir, "reply-token-garrett.json")).mode & 0o777, 0o600);
    const gt = await garrettToken(s, h);
    const texts = [];
    for (const p of ["/api/bridge", "/api/config", "/api/reply-tokens"]) texts.push(await (await fetch(s.base + p, { headers: h })).text());
    const put2 = await (await put(s, h, "dummy", { url: GOOD })).text();
    texts.push(put2, await (await del(s, h, "ads")).text());
    for (const t of texts) for (const secret of [VOL_KEY, ENV_KEY, REPLY, gt]) assert.ok(!t.includes(secret));
    const cfg = JSON.parse(texts[1]);
    assert.equal(cfg.bots.find((b) => b.id === "dummy").realAgent, true);
    assert.equal(cfg.bots.find((b) => b.id === "addy").realAgent, true);
    assert.deepEqual(Object.keys(JSON.parse(texts[0]).bots[0]).sort(), ["account", "id", "keySet", "name", "source", "url"]);
    assert.deepEqual(Object.keys(JSON.parse(texts[2]).garrett).sort(), ["createdAt", "exists"]);
    for (const secret of [VOL_KEY, ENV_KEY, REPLY, gt]) assert.ok(!s.output().includes(secret), "logs leaked a secret");
  });
});

test("volume overrides env, applies immediately, and Clear restores env / stand-in", async () => {
  const envUrl = `http://127.0.0.1:${port}/ENV`;
  await withServer({ BOTHUB_REPLY_TOKEN: REPLY, BOTHUB_WEBHOOK_URL_ASSCHUB: envUrl, BOTHUB_WEBHOOK_KEY_ASSCHUB: ENV_KEY }, async (s, h) => {
    const file = path.join(s.dataDir, "bridge-webhooks.json");
    assert.equal((await view(s, h)).find((b) => b.id === "asschub").source, "env");
    // Save through the API (a valid Cursor URL), keeping the env key when none is typed.
    assert.equal((await put(s, h, "asschub", { url: GOOD })).status, 200);
    let a = (await view(s, h)).find((b) => b.id === "asschub");
    assert.deepEqual([a.source, a.url, a.keySet], ["volume", GOOD, true]);
    // Test-only: point the saved entry at the local listener to observe the POST (file is re-read each time).
    fs.writeFileSync(file, JSON.stringify({ asschub: { url: `http://127.0.0.1:${port}/VOL`, key: VOL_KEY } }));
    hits.length = 0;
    let r = await postJson(s.base + "/api/messages", { room: "group", text: "hey @Asschub", participants: ["asschub"] }, h);
    assert.equal(r.status, 202);
    await sleep(300);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].url, "/VOL");
    assert.equal(hits[0].auth, `Bearer ${VOL_KEY}`);
    // Finish the job, then Clear: env is used again.
    assert.equal((await reply(s, REPLY, { job_id: hits[0].body.job_id, bot_id: "asschub", text: "ok" })).status, 200);
    assert.equal((await del(s, h, "asschub")).status, 200);
    a = (await view(s, h)).find((b) => b.id === "asschub");
    assert.deepEqual([a.source, a.url, a.keySet], ["env", envUrl, true]);
    hits.length = 0;
    await postJson(s.base + "/api/messages", { room: "group", text: "hey @Asschub", participants: ["asschub"] }, h);
    await sleep(300);
    assert.equal(hits[0]?.url, "/ENV");
    assert.equal(hits[0]?.auth, `Bearer ${ENV_KEY}`);
  });
  await withServer({}, async (s, h) => { // no env: Clear -> stand-in
    assert.equal((await put(s, h, "dummy", { url: GOOD, key: VOL_KEY })).status, 200);
    const real = async () => (await (await fetch(s.base + "/api/config", { headers: h })).json()).bots.find((b) => b.id === "dummy").realAgent;
    assert.equal(await real(), true);
    await del(s, h, "dummy");
    assert.equal(await real(), false);
    assert.equal((await view(s, h)).find((b) => b.id === "dummy").source, "none");
  });
});

test("Save with a new key replaces it; URL-only save keeps the volume key", async () => {
  await withServer({}, async (s, h) => {
    await put(s, h, "pawn", { url: GOOD, key: VOL_KEY });
    await put(s, h, "pawn", { url: "https://api2.cursor.sh/automations/webhook/second" });
    const f = path.join(s.dataDir, "bridge-webhooks.json");
    let e = JSON.parse(fs.readFileSync(f, "utf8")).pawn;
    assert.deepEqual([e.url, e.key], ["https://api2.cursor.sh/automations/webhook/second", VOL_KEY]);
    await put(s, h, "pawn", { url: GOOD, key: "another-key-555" });
    assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).pawn.key, "another-key-555");
  });
});

test("env reply token: asschub yes, dummy 403; garrett token: dummy yes, asschub 403", async () => {
  const seed = (dir) => {
    fs.writeFileSync(path.join(dir, "agent-jobs.json"), JSON.stringify({
      jobs: {
        a: { id: "a", botId: "asschub", room: "dm:asschub", account: "grok-1", ts: Date.parse(NOON) - 60_000, status: "open", timeoutNoted: true },
        d: { id: "d", botId: "dummy", room: "dm:dummy", account: "grok-2", ts: Date.parse(NOON) - 60_000, status: "open", timeoutNoted: true },
      }, wakes: [],
    }));
  };
  const s = await startServer({ BOTHUB_ADMIN_EMAIL: EMAIL, BOTHUB_ADMIN_PASSWORD_HASH: hashPassword(PASSWORD), BOTHUB_NOW: NOON, BOTHUB_REPLY_TOKEN: REPLY }, seed);
  try {
    const h = { Cookie: (await postJson(s.base + "/api/login", { email: EMAIL, password: PASSWORD })).headers.get("set-cookie").split(";")[0] };
    const gt = await garrettToken(s, h);
    assert.equal((await reply(s, REPLY, { job_id: "d", bot_id: "dummy", text: "x" })).status, 403);
    assert.equal((await reply(s, gt, { job_id: "a", bot_id: "asschub", text: "x" })).status, 403);
    assert.equal((await reply(s, "wrong", { job_id: "a", bot_id: "asschub", text: "x" })).status, 401);
    assert.equal((await reply(s, REPLY, { job_id: "a", bot_id: "asschub", text: "from asschub" })).status, 200);
    assert.equal((await reply(s, gt, { job_id: "d", bot_id: "dummy", text: "from dummy" })).status, 200);
    const m = await (await fetch(s.base + "/api/messages?room=dm:dummy", { headers: h })).json();
    assert.ok(m.some((x) => x.speaker === "Dummy" && x.text === "from dummy"));
  } finally { await s.stop(); }
});

test("regenerating the garrett token revokes the old one immediately", async () => {
  await withServer({}, async (s, h) => {
    const old = await garrettToken(s, h);
    assert.equal((await reply(s, old, { job_id: "nope", bot_id: "dummy", text: "x" })).status, 404); // authenticated
    const r = await (await postJson(s.base + "/api/reply-tokens/garrett/regenerate", {}, h)).json();
    assert.notEqual(r.token, old);
    assert.equal((await reply(s, old, { job_id: "nope", bot_id: "dummy", text: "x" })).status, 401);
    assert.equal((await reply(s, r.token, { job_id: "nope", bot_id: "dummy", text: "x" })).status, 404);
    assert.equal(await garrettToken(s, h), r.token);
  });
});

test("garrett token survives restart in the data dir; lifteasy reveal with env unset creates nothing", async () => {
  await withServer({}, async (s, h) => {
    const files = () => fs.readdirSync(s.dataDir).sort();
    const before = files();
    const r = await postJson(s.base + "/api/reply-tokens/lifteasy/reveal", {}, h);
    assert.equal(r.status, 404);
    assert.ok(!("token" in (await r.json())));
    assert.deepEqual(files(), before);
    assert.ok(!before.some((f) => /lifteasy/.test(f)));
    assert.deepEqual((await (await fetch(s.base + "/api/reply-tokens", { headers: h })).json()).lifteasy, { exists: false });
    // Without the env var nothing but the garrett token authenticates, and only for garrett bots.
    assert.equal((await reply(s, "undefined", { job_id: "x", bot_id: "asschub", text: "x" })).status, 401);
  });
  await withServer({ BOTHUB_REPLY_TOKEN: REPLY }, async (s, h) => {
    const r = await postJson(s.base + "/api/reply-tokens/lifteasy/reveal", {}, h);
    assert.equal((await r.json()).token, REPLY);
    assert.ok(!fs.readdirSync(s.dataDir).some((f) => /lifteasy/.test(f)));
  });
});

const selfReg = (s, id, token, body, method = "PUT", extra = {}) => fetch(`${s.base}/api/bridge/${id}/self-register`, {
  method, headers: { "Content-Type": "application/json", ...(token === null ? {} : { Authorization: `Bearer ${token}` }), ...extra },
  body: method === "PUT" ? JSON.stringify(body ?? {}) : undefined,
});

test("self-register: 401s and account scoping (cookie alone is not enough)", async () => {
  await withServer({ BOTHUB_REPLY_TOKEN: REPLY }, async (s, h) => {
    const gt = await garrettToken(s, h);
    const good = { url: GOOD, key: VOL_KEY };
    assert.equal((await selfReg(s, "asschub", null, good)).status, 401);
    assert.equal((await selfReg(s, "asschub", "", good, "PUT", { Authorization: "Bearer " })).status, 401);
    assert.equal((await selfReg(s, "asschub", "wrong", good)).status, 401);
    assert.equal((await selfReg(s, "asschub", null, good, "PUT", h)).status, 401); // cookie alone
    assert.equal((await selfReg(s, "dummy", REPLY, good)).status, 403);
    assert.equal((await selfReg(s, "asschub", gt, good)).status, 403);
    assert.equal((await selfReg(s, "claude", REPLY, good)).status, 400);
    assert.equal((await selfReg(s, "nova", gt, good)).status, 400);
    assert.equal((await selfReg(s, "rook", REPLY, good)).status, 400);
    assert.equal((await selfReg(s, "sage", gt, good)).status, 400);
    assert.deepEqual(await view(s, h).then((b) => b.filter((x) => x.source === "volume")), []);
  });
});

test("self-register: PUT stores to the volume, leaks nothing, bad input persists nothing", async () => {
  await withServer({ BOTHUB_REPLY_TOKEN: REPLY }, async (s, h) => {
    const gt = await garrettToken(s, h);
    const r = await selfReg(s, "dummy", gt, { url: GOOD, key: VOL_KEY });
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.deepEqual(JSON.parse(text), { ok: true, botId: "dummy", set: true });
    assert.ok(!text.includes(VOL_KEY) && !text.includes(GOOD));
    const d = (await view(s, h)).find((b) => b.id === "dummy");
    assert.equal(d.keySet, true);
    assert.equal(d.source, "volume");
    assert.equal(fs.statSync(path.join(s.dataDir, "bridge-webhooks.json")).mode & 0o777, 0o600);
    const l = await selfReg(s, "asschub", REPLY, { url: GOOD, key: VOL_KEY });
    assert.equal(l.status, 200);
    for (const body of [{ url: GOOD }, { key: VOL_KEY }, { url: "http://api2.cursor.sh/automations/webhook/a", key: VOL_KEY },
      { url: "https://evilcursor.sh/automations/webhook/a", key: VOL_KEY }, { url: "https://api2.cursor.sh/other", key: VOL_KEY }]) {
      assert.equal((await selfReg(s, "pawn", gt, body)).status, 400);
    }
    assert.equal((await view(s, h)).find((b) => b.id === "pawn").source, "none");
    const out = s.output();
    for (const secret of [VOL_KEY, REPLY, gt]) assert.ok(!out.includes(secret));
    assert.ok(out.includes("bridge self-register for dummy"));
  });
});

test("self-register: DELETE is account-scoped, clears volume, env fallback returns", async () => {
  await withServer({ BOTHUB_REPLY_TOKEN: REPLY, BOTHUB_WEBHOOK_URL_ASSCHUB: GOOD, BOTHUB_WEBHOOK_KEY_ASSCHUB: ENV_KEY }, async (s, h) => {
    const gt = await garrettToken(s, h);
    assert.equal((await selfReg(s, "asschub", REPLY, { url: GOOD, key: VOL_KEY })).status, 200);
    assert.equal((await view(s, h)).find((b) => b.id === "asschub").source, "volume");
    assert.equal((await selfReg(s, "asschub", gt, null, "DELETE")).status, 403);
    assert.equal((await selfReg(s, "asschub", null, null, "DELETE")).status, 401);
    const dr = await selfReg(s, "asschub", REPLY, null, "DELETE");
    assert.equal(dr.status, 200);
    assert.deepEqual(await dr.json(), { ok: true, botId: "asschub", set: false });
    assert.equal((await view(s, h)).find((b) => b.id === "asschub").source, "env");
    for (const secret of [VOL_KEY, REPLY, gt, ENV_KEY]) assert.ok(!s.output().includes(secret));
  });
});

test("self-register: 11th attempt from one IP in an hour is 429 with Retry-After", async () => {
  await withServer({ BOTHUB_REPLY_TOKEN: REPLY }, async (s) => {
    for (let i = 0; i < 10; i++) assert.equal((await selfReg(s, "asschub", "bad", {})).status, 401);
    const r = await selfReg(s, "asschub", REPLY, { url: GOOD, key: VOL_KEY });
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get("retry-after")) > 0);
  });
});
