// FROZEN CONTRACTS: bots' routines call these on the live host. Do not "fix" production code to
// make a failing assertion pass; a failure here is a regression in a public bot API.
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { hashPassword } from "../src/auth.js";
import { startServer, postJson } from "./helpers.js";

const EMAIL = "admin@example.com";
const PASSWORD = "a-long-test-password";
const HOOK_KEY = "contract-hook-key";
const REPLY = "contract-reply-token";
const NOON = "2026-06-03T15:00:00-04:00";
const REPLY_URL = "https://bots.ezliftgaragedoorservice.com/api/agent-reply";
const GOOD = "https://api2.cursor.sh/automations/webhook/abc";
const VOL_KEY = "contract-vol-key";

const hits = [];
const listener = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => { hits.push({ url: req.url, body: JSON.parse(raw || "{}") }); res.writeHead(200); res.end("{}"); });
});
let hookPort;
before(async () => { await new Promise((r) => listener.listen(0, "127.0.0.1", r)); hookPort = listener.address().port; });
after(() => listener.close());
beforeEach(() => { hits.length = 0; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withServer(fn) {
  const env = { BOTHUB_ADMIN_EMAIL: EMAIL, BOTHUB_ADMIN_PASSWORD_HASH: hashPassword(PASSWORD), BOTHUB_REPLY_TOKEN: REPLY, BOTHUB_NOW: NOON };
  for (const id of ["ASSCHUB", "DUMMY"]) {
    env[`BOTHUB_WEBHOOK_URL_${id}`] = `http://127.0.0.1:${hookPort}/${id}`;
    env[`BOTHUB_WEBHOOK_KEY_${id}`] = HOOK_KEY;
  }
  const s = await startServer(env);
  try {
    const r = await postJson(s.base + "/api/login", { email: EMAIL, password: PASSWORD });
    const h = { Cookie: (r.headers.get("set-cookie") ?? "").split(";")[0] };
    s.garrettToken = (await (await postJson(s.base + "/api/reply-tokens/garrett/reveal", {}, h)).json()).token;
    await fn(s, h);
  } finally { await s.stop(); }
}
const auth = (t) => (t ? { Authorization: `Bearer ${t}` } : {});
const selfReg = (s, id, token, body, method = "PUT", extra = {}) => fetch(`${s.base}/api/bridge/${id}/self-register`, {
  method, headers: { "Content-Type": "application/json", ...auth(token), ...extra }, body: method === "PUT" ? JSON.stringify(body ?? {}) : undefined,
});
const reply = (s, body, token = REPLY) => postJson(s.base + "/api/agent-reply", body, auth(token));
const post = (s, body, token = REPLY) => postJson(s.base + "/api/agent-post", body, auth(token));
const msgs = async (s, h, room = "group") => (await fetch(`${s.base}/api/messages?room=${room}`, { headers: h })).json();

test("self-register: 401/403, 200 shapes (no key/url echoed), 11th attempt is 429", async () => {
  await withServer(async (s, h) => {
    const good = { url: GOOD, key: VOL_KEY };
    assert.equal((await selfReg(s, "asschub", null, good)).status, 401);
    assert.equal((await selfReg(s, "asschub", "", good, "PUT", { Authorization: "Bearer " })).status, 401);
    assert.equal((await selfReg(s, "asschub", "wrong", good)).status, 401);
    assert.equal((await selfReg(s, "asschub", null, good, "PUT", h)).status, 401); // session cookie alone
    assert.equal((await selfReg(s, "dummy", REPLY, good)).status, 403); // lifteasy token, grok-2 bot
    assert.equal((await selfReg(s, "asschub", s.garrettToken, good)).status, 403); // garrett token, lifteasy bot
    const r = await selfReg(s, "dummy", s.garrettToken, good); // 4 attempts counted so far... plus this one
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.deepEqual(JSON.parse(text), { ok: true, botId: "dummy", set: true });
    assert.ok(!text.includes(VOL_KEY) && !text.includes(GOOD));
    const d = await selfReg(s, "dummy", s.garrettToken, null, "DELETE");
    assert.equal(d.status, 200);
    assert.deepEqual(await d.json(), { ok: true, botId: "dummy", set: false });
    // 10 attempts used (6 failures + PUT + DELETE = 8 so far... top up to 10), the 11th is limited.
    for (let i = 0; i < 2; i++) await selfReg(s, "asschub", "wrong", good);
    const limited = await selfReg(s, "asschub", "wrong", good);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
  });
});

test("agent-reply: 401/403/400/404, idempotent 200, webhook payload shape and reply_url", async () => {
  await withServer(async (s, h) => {
    const body = { job_id: "x", bot_id: "dummy", text: "hi" };
    assert.equal((await reply(s, body, null)).status, 401);
    assert.equal((await reply(s, body, "wrong")).status, 401);
    assert.equal((await reply(s, body, REPLY)).status, 403); // lifteasy token for a grok-2 bot
    assert.equal((await reply(s, { ...body, bot_id: "asschub" }, s.garrettToken)).status, 403);
    assert.equal((await reply(s, body, s.garrettToken)).status, 404); // unknown job

    const send = await postJson(s.base + "/api/messages", { room: "dm:dummy", text: "hello", participants: ["dummy"] }, h);
    assert.equal(send.status, 202);
    for (let i = 0; i < 50 && !hits.length; i++) await sleep(50);
    assert.equal(hits.length, 1);
    const p = hits[0].body;
    assert.deepEqual(Object.keys(p).sort(), ["bot_id", "chain_id", "hop", "job_id", "recent", "reply_url", "room", "speaker", "team_brief", "text"]);
    assert.equal(p.reply_url, REPLY_URL);

    const jobId = p.job_id;
    const T = s.garrettToken;
    assert.equal((await reply(s, { bot_id: "dummy", text: "x" }, T)).status, 400);
    assert.equal((await reply(s, { job_id: jobId, text: "x" }, T)).status, 400);
    assert.equal((await reply(s, { job_id: jobId, bot_id: "dummy" }, T)).status, 400);
    assert.equal((await reply(s, { job_id: jobId, bot_id: "asschub", text: "x" }, REPLY)).status, 404); // wrong bot
    const ok1 = await reply(s, { job_id: jobId, bot_id: "dummy", text: "Done." }, T);
    assert.equal(ok1.status, 200);
    assert.deepEqual(await ok1.json(), { ok: true });
    const ok2 = await reply(s, { job_id: jobId, bot_id: "dummy", text: "Done." }, T);
    assert.equal(ok2.status, 200);
    assert.deepEqual(await ok2.json(), { ok: true });
    assert.equal((await msgs(s, h, "dm:dummy")).filter((m) => m.speaker === "Dummy").length, 1);
  });
});

test("agent-post: 401/403/400, 200 {ok,id}, 21st post is 429", async () => {
  await withServer(async (s) => {
    const b = { bot_id: "asschub", room: "group", text: "hi" };
    assert.equal((await post(s, b, null)).status, 401);
    assert.equal((await post(s, b, "nope")).status, 401);
    assert.equal((await post(s, b, s.garrettToken)).status, 403); // wrong account
    assert.equal((await post(s, { ...b, bot_id: "dummy" })).status, 403); // non-poster
    assert.equal((await post(s, { ...b, bot_id: "no-such-bot" })).status, 403);
    assert.equal((await post(s, { ...b, room: "nowhere" })).status, 400);
    assert.equal((await post(s, { ...b, text: "  " })).status, 400);
    assert.equal((await post(s, { room: "group", text: "hi" })).status, 400);
    const r = await post(s, b);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.ok(j.id);
    for (let i = 1; i < 20; i++) assert.equal((await post(s, b)).status, 200, `post ${i}`);
    const limited = await post(s, b);
    assert.equal(limited.status, 429);
  });
});
