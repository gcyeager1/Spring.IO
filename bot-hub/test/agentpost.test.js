import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { hashPassword } from "../src/auth.js";
import { startServer, postJson } from "./helpers.js";

const EMAIL = "admin@example.com";
const PASSWORD = "a-long-test-password";
const HOOK_KEY = "post-webhook-key";
const REPLY = "post-reply-token";
const NOON = "2026-06-03T15:00:00-04:00";
const NIGHT = "2026-06-03T23:00:00-04:00";

const hits = [];
const listener = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => { hits.push({ bot: req.url.slice(1), body: JSON.parse(raw || "{}") }); res.writeHead(200); res.end("{}"); });
});
let hookPort;
before(async () => { await new Promise((r) => listener.listen(0, "127.0.0.1", r)); hookPort = listener.address().port; });
after(() => listener.close());
beforeEach(() => { hits.length = 0; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(30); }
  return false;
};
const hitsFor = (bot) => hits.filter((h) => h.bot === bot);

async function withServer(extra, fn) {
  const env = { BOTHUB_ADMIN_EMAIL: EMAIL, BOTHUB_ADMIN_PASSWORD_HASH: hashPassword(PASSWORD), BOTHUB_REPLY_TOKEN: REPLY, BOTHUB_NOW: NOON };
  for (const id of ["ASSCHUB", "DUMMY", "ADDY"]) {
    env[`BOTHUB_WEBHOOK_URL_${id}`] = `http://127.0.0.1:${hookPort}/${id.toLowerCase()}`;
    env[`BOTHUB_WEBHOOK_KEY_${id}`] = HOOK_KEY;
  }
  const s = await startServer({ ...env, ...extra });
  try {
    const r = await postJson(s.base + "/api/login", { email: EMAIL, password: PASSWORD });
    const h = { Cookie: (r.headers.get("set-cookie") ?? "").split(";")[0] };
    s.garrettToken = (await (await postJson(s.base + "/api/reply-tokens/garrett/reveal", {}, h)).json()).token;
    await fn(s, h);
  } finally { await s.stop(); }
}
const post = (s, body, token = REPLY) =>
  postJson(s.base + "/api/agent-post", body, token ? { Authorization: `Bearer ${token}` } : {});
const messages = async (s, h, room = "group") => (await fetch(`${s.base}/api/messages?room=${room}`, { headers: h })).json();

test("401 without a token or with a bad token", async () => {
  await withServer({}, async (s) => {
    const b = { bot_id: "asschub", room: "group", text: "hi" };
    assert.equal((await post(s, b, null)).status, 401);
    assert.equal((await post(s, b, "nope")).status, 401);
  });
});

test("403: garrett token for every grok-2 bot, lifteasy token for non-posters, unknown bot", async () => {
  await withServer({}, async (s, h) => {
    for (const bot_id of ["dummy", "crm-builder", "ads", "pawn"]) {
      assert.equal((await post(s, { bot_id, room: "group", text: "hi" }, s.garrettToken)).status, 403, bot_id);
    }
    assert.equal((await post(s, { bot_id: "asschub", room: "group", text: "hi" }, s.garrettToken)).status, 403);
    assert.equal((await post(s, { bot_id: "addy", room: "group", text: "hi" })).status, 403);
    assert.equal((await post(s, { bot_id: "dummy", room: "group", text: "hi" })).status, 403);
    assert.equal((await post(s, { bot_id: "no-such-bot", room: "group", text: "hi" })).status, 403);
    assert.equal((await messages(s, h)).filter((m) => m.realAgent).length, 0);
  });
});

test("400 for a bad room, empty text or missing fields", async () => {
  await withServer({}, async (s) => {
    assert.equal((await post(s, { bot_id: "asschub", room: "nowhere", text: "hi" })).status, 400);
    assert.equal((await post(s, { bot_id: "asschub", room: "dm:no-such-bot", text: "hi" })).status, 400);
    assert.equal((await post(s, { bot_id: "asschub", room: "group", text: "   " })).status, 400);
    assert.equal((await post(s, { bot_id: "asschub", room: "group" })).status, 400);
    assert.equal((await post(s, { room: "group", text: "hi" })).status, 400);
  });
});

test("200: the post appears in the room as the bot (group and private room); long text is trimmed like replies", async () => {
  await withServer({}, async (s, h) => {
    const r = await post(s, { bot_id: "asschub", room: "group", text: "hello team" });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    const m = (await messages(s, h)).find((x) => x.id === j.id);
    assert.deepEqual([m.speaker, m.botId, m.account, m.text, m.room], ["Asschub", "asschub", "grok-1", "hello team", "group"]);
    assert.equal((await post(s, { bot_id: "asschub", room: "dm:dummy", text: "x".repeat(25000) })).status, 200);
    assert.equal((await messages(s, h, "dm:dummy"))[0].text.length, 20000);
  });
});

test("@mention in a post wakes a bridged bot at hop 1 in a new chain; the poster is never woken", async () => {
  await withServer({}, async (s) => {
    assert.equal((await post(s, { bot_id: "asschub", room: "group", text: "ping @dummy and @asschub" })).status, 200);
    assert.ok(await until(() => hitsFor("dummy").length === 1));
    await sleep(300);
    const d = hitsFor("dummy")[0].body;
    assert.deepEqual([d.hop, d.speaker, d.room], [1, "Asschub", "group"]);
    assert.match(d.chain_id, /^[0-9a-f-]{36}$/);
    assert.equal(hitsFor("asschub").length, 0, "no self-wake");
    await post(s, { bot_id: "asschub", room: "group", text: "again @dummy" });
    await sleep(300); // dummy still in flight in this room: no second webhook
    assert.equal(hitsFor("dummy").length, 1);
  });
  await withServer({}, async (s) => {
    await post(s, { bot_id: "asschub", room: "group", text: "one @addy" });
    assert.ok(await until(() => hitsFor("addy").length === 1));
    await post(s, { bot_id: "asschub", room: "group", text: "two @addy" });
    await sleep(300);
    assert.equal(hitsFor("addy").length, 1, "addy already has an open job in this room");
  });
});

test("posts respect quiet hours: posted, but nobody is woken", async () => {
  await withServer({ BOTHUB_NOW: NIGHT }, async (s, h) => {
    assert.equal((await post(s, { bot_id: "asschub", room: "group", text: "night @dummy" })).status, 200);
    await sleep(300);
    assert.equal(hits.length, 0);
    const msgs = await messages(s, h);
    assert.ok(msgs.some((m) => m.system && /offline until 7 AM Eastern.*Dummy was not woken/.test(m.text)));
  });
});

test("21st post within an hour gets 429", async () => {
  await withServer({}, async (s) => {
    for (let i = 0; i < 20; i++) assert.equal((await post(s, { bot_id: "asschub", room: "group", text: `n${i}` })).status, 200, `post ${i}`);
    const r = await post(s, { bot_id: "asschub", room: "group", text: "one too many" });
    assert.equal(r.status, 429);
    assert.ok((await r.json()).error);
  });
});

test("BOTHUB_AGENT_POSTERS override, exposed on GET /api/bridge", async () => {
  await withServer({}, async (s, h) => {
    const b = await (await fetch(s.base + "/api/bridge", { headers: h })).json();
    assert.deepEqual([b.agentPosters, b.agentPosterNames], [["asschub"], ["Asschub"]]);
  });
  await withServer({ BOTHUB_AGENT_POSTERS: " addy , dummy " }, async (s, h) => {
    const b = await (await fetch(s.base + "/api/bridge", { headers: h })).json();
    assert.deepEqual(b.agentPosters, ["addy", "dummy"]);
    assert.equal((await post(s, { bot_id: "addy", room: "group", text: "hi" })).status, 200);
    assert.equal((await post(s, { bot_id: "asschub", room: "group", text: "hi" })).status, 403);
    assert.equal((await post(s, { bot_id: "dummy", room: "group", text: "hi" })).status, 403, "lifteasy token, grok-2 bot");
    assert.equal((await post(s, { bot_id: "dummy", room: "group", text: "hi" }, s.garrettToken)).status, 200);
  });
});
