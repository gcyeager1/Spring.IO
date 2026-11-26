import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { hashPassword } from "../src/auth.js";
import { startServer, postJson } from "./helpers.js";
import { parseMentions, withinHours } from "../src/realagent.js";
import { loadConfig } from "../src/config.js";

const EMAIL = "admin@example.com";
const PASSWORD = "a-long-test-password";
const HOOK_KEY = "test-webhook-key-abc";
const REPLY = "test-reply-token-xyz";
const NOON = "2026-06-03T15:00:00-04:00"; // 3 PM Eastern (Wednesday)
const REPLY_URL = "https://bots.ezliftgaragedoorservice.com/api/agent-reply";

// Local webhook listener: records every request; behavior is switchable per test.
const hits = [];
let mode = "ok"; // ok | 500 | slow
const listener = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    hits.push({ url: req.url, auth: req.headers.authorization, ctype: req.headers["content-type"], body: JSON.parse(raw || "{}") });
    if (mode === "slow") return; // never answers
    res.writeHead(mode === "500" ? 500 : 200);
    res.end("{}");
  });
});
let hookPort;

const envFor = (extra = {}) => {
  const e = { BOTHUB_ADMIN_EMAIL: EMAIL, BOTHUB_ADMIN_PASSWORD_HASH: hashPassword(PASSWORD), BOTHUB_REPLY_TOKEN: REPLY, BOTHUB_NOW: NOON };
  for (const id of ["ASSCHUB", "DUMMY", "LEADS_LIFTEASY", "ADDY"]) {
    e[`BOTHUB_WEBHOOK_URL_${id}`] = `http://127.0.0.1:${hookPort}/${id}`;
    e[`BOTHUB_WEBHOOK_KEY_${id}`] = HOOK_KEY;
  }
  return { ...e, ...extra };
};
const login = async (s) => {
  const r = await postJson(s.base + "/api/login", { email: EMAIL, password: PASSWORD });
  return { Cookie: (r.headers.get("set-cookie") ?? "").split(";")[0] };
};
const send = (s, h, body) => postJson(s.base + "/api/messages", body, h);
const msgs = async (s, h, room = "group") => (await fetch(`${s.base}/api/messages?room=${encodeURIComponent(room)}`, { headers: h })).json();
const reply = (s, body, token = REPLY) => postJson(s.base + "/api/agent-reply", body, token === null ? {} : { Authorization: `Bearer ${token}` });
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 30)); }
  return false;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => { await new Promise((r) => listener.listen(0, "127.0.0.1", r)); hookPort = listener.address().port; });
after(() => listener.close());
beforeEach(() => { hits.length = 0; mode = "ok"; });

async function withServer(extra, seed, fn) {
  const s = await startServer(envFor(extra), seed);
  try { await fn(s, await login(s)); } finally { await s.stop(); }
}
const wake = async (s, h, text, room = "group", participants = ["asschub"]) => {
  const r = await send(s, h, { room, text, participants });
  assert.equal(r.status, 202);
  await sleep(150);
};

test("bots without both URL and key stay stand-ins; config never leaks URL/key/token", async () => {
  await withServer({ BOTHUB_WEBHOOK_KEY_PAWN: HOOK_KEY, BOTHUB_WEBHOOK_URL_ADS: "http://127.0.0.1:1/x" }, null, async (s, h) => {
    const raw = await (await fetch(s.base + "/api/config", { headers: h })).text();
    const cfg = JSON.parse(raw);
    const real = (id) => cfg.bots.find((b) => b.id === id).realAgent;
    assert.equal(real("asschub"), true);
    assert.equal(real("dummy"), true);
    assert.equal(real("leads-lifteasy"), true);
    assert.ok(!real("pawn"), "key only -> stand-in");
    assert.ok(!real("ads"), "url only -> stand-in");
    assert.ok(!real("crm-builder"));
    for (const secret of [HOOK_KEY, REPLY, "127.0.0.1", "WEBHOOK", "REPLY_TOKEN"]) assert.ok(!raw.includes(secret), `config leaked ${secret}`);
    assert.ok(!s.output().includes(HOOK_KEY) && !s.output().includes(REPLY), "logs must not contain secrets");
  });
});

test("group @mention wakes the bot with the expected payload; 202 returns immediately", async () => {
  await withServer({}, null, async (s, h) => {
    await send(s, h, { room: "group", text: "earlier chatter", participants: ["nova"] });
    await until(async () => (await msgs(s, h)).some((m) => m.speaker === "Nova"));
    mode = "slow"; // even a hanging webhook must not delay the 202
    const t0 = Date.now();
    const r = await send(s, h, { room: "group", text: "hey @Asschub, status?", participants: ["asschub", "nova"] });
    assert.equal(r.status, 202);
    assert.ok(Date.now() - t0 < 3000);
    assert.ok(await until(() => hits.length === 1));
    const hit = hits[0];
    assert.equal(hit.auth, `Bearer ${HOOK_KEY}`);
    assert.equal(hit.ctype, "application/json");
    assert.equal(hit.url, "/ASSCHUB");
    assert.match(hit.body.job_id, /^[0-9a-f-]{36}$/);
    assert.equal(hit.body.room, "group");
    assert.equal(hit.body.bot_id, "asschub");
    assert.equal(hit.body.speaker, "You");
    assert.equal(hit.body.text, "hey @Asschub, status?");
    assert.equal(hit.body.reply_url, REPLY_URL);
    assert.ok(Array.isArray(hit.body.recent) && hit.body.recent.length >= 2);
    assert.deepEqual(Object.keys(hit.body.recent[0]).sort(), ["botId", "speaker", "text"]);
    assert.equal(hit.body.recent.at(-1).text, "hey @Asschub, status?");
    // The ticked real bot never replies as a stand-in.
    await sleep(300);
    assert.ok(!(await msgs(s, h)).some((m) => m.speaker === "Asschub"));
  });
});

test("private room wakes the bot with no @mention", async () => {
  await withServer({}, null, async (s, h) => {
    await wake(s, h, "hello there", "dm:dummy");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].body.room, "dm:dummy");
    assert.equal(hits[0].body.bot_id, "dummy");
    assert.equal(hits[0].url, "/DUMMY");
  });
});

test("no chaining and no wake without a mention", async () => {
  await withServer({}, null, async (s, h) => {
    // Group message with no mention; real bot is ticked.
    await wake(s, h, "just talking, nobody in particular", "group", ["asschub", "nova"]);
    assert.equal(hits.length, 0);
    // A stand-in bot's text mentioning @Asschub must not wake it (mock Nova replies are canned,
    // so inject via a free bot whose reply we can't control; verify the rule at the parser level too).
    await until(async () => (await msgs(s, h)).some((m) => m.speaker === "Nova"));
    assert.equal(hits.length, 0);
    // Only the human speaker can wake: a callback message that mentions @Asschub does not.
    await wake(s, h, "hi @Dummy", "group", ["nova"]);
    assert.equal(hits.length, 1);
    const r = await reply(s, { job_id: hits[0].body.job_id, bot_id: "dummy", text: "psst @Asschub wake up" });
    assert.equal(r.status, 200);
    await sleep(300);
    assert.equal(hits.length, 1, "a bot's reply mentioning another bot must not POST");
  });
});

test("mention parsing: ambiguous names, ids, name:account, punctuation", () => {
  const bots = loadConfig().bots;
  const ids = (t) => [...parseMentions(t, bots).ids].sort();
  assert.deepEqual(ids("@asschub!"), ["asschub"]);
  assert.deepEqual(ids("@ASSCHUB?"), ["asschub"]);
  assert.deepEqual(ids("email me@asschub"), []);
  assert.deepEqual(ids("@Asschubby"), []);
  assert.deepEqual(ids("@crm-builder go"), ["crm-builder"]);
  assert.deepEqual(ids("@CRM Builder go"), ["crm-builder"]);
  assert.deepEqual(ids("@Crm go"), ["crm"]);
  assert.deepEqual(ids("@usage-bot"), ["usage-bot"]);
  assert.deepEqual(ids("@Leads:grok-2 hi"), ["leads-garrett"]);
  assert.deepEqual(ids("@leads-lifteasy, @leads-garrett"), ["leads-garrett", "leads-lifteasy"]);
  const amb = parseMentions("hey @Leads", bots);
  assert.equal(amb.ids.size, 0);
  assert.deepEqual(amb.ambiguous[0].ids.sort(), ["leads-garrett", "leads-lifteasy"]);
});

test("ambiguous @Leads wakes nobody; id-qualified mention does", async () => {
  await withServer({}, null, async (s, h) => {
    await wake(s, h, "@Leads how are numbers?");
    assert.equal(hits.length, 0);
    const note = (await msgs(s, h)).find((m) => m.system);
    assert.ok(note && note.hidden);
    assert.match(note.text, /@leads-lifteasy/);
    assert.match(note.text, /@leads-garrett/);
    await wake(s, h, "@leads-lifteasy how are numbers?");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].body.bot_id, "leads-lifteasy");
  });
});

test("quiet hours (America/New_York): 9 PM and later / before 7 AM refuse, in-window posts", async () => {
  assert.equal(withinHours(Date.parse("2026-06-03T06:59:00-04:00")), false);
  assert.equal(withinHours(Date.parse("2026-06-03T07:00:00-04:00")), true);
  assert.equal(withinHours(Date.parse("2026-06-03T20:59:00-04:00")), true);
  assert.equal(withinHours(Date.parse("2026-06-03T21:00:00-04:00")), false);
  assert.equal(withinHours(Date.parse("2026-01-10T20:30:00-05:00")), true); // winter, Saturday
  await withServer({ BOTHUB_NOW: "2026-06-03T21:30:00-04:00" }, null, async (s, h) => {
    await wake(s, h, "@Asschub hello");
    assert.equal(hits.length, 0);
    assert.ok((await msgs(s, h)).some((m) => m.system && /offline until 7 AM Eastern/.test(m.text)));
  });
  await withServer({ BOTHUB_NOW: "2026-06-06T05:00:00-04:00" }, null, async (s, h) => { // Saturday 5 AM
    await wake(s, h, "hi", "dm:asschub");
    assert.equal(hits.length, 0);
  });
  await withServer({ BOTHUB_NOW: "2026-06-07T15:00:00-04:00" }, null, async (s, h) => { // Sunday 3 PM
    await wake(s, h, "@Asschub hello");
    assert.equal(hits.length, 1);
  });
});

test("10 wakes/hour per account; other accounts unaffected; one in-flight per bot+room", async () => {
  await withServer({}, null, async (s, h) => {
    // asschub, addy, leads-lifteasy are grok-1. Finish each job so in-flight doesn't interfere.
    const finish = async (bot) => {
      const r = await reply(s, { job_id: hits.at(-1).body.job_id, bot_id: bot, text: "done" });
      assert.equal(r.status, 200);
    };
    for (let i = 0; i < 10; i++) {
      await wake(s, h, `ping ${i}`, "dm:asschub");
      assert.equal(hits.length, i + 1);
      await finish("asschub");
    }
    await wake(s, h, "ping 11", "dm:asschub");
    assert.equal(hits.length, 10, "11th wake refused");
    assert.ok((await msgs(s, h, "dm:asschub")).some((m) => m.system && /limit/i.test(m.text)));
    await wake(s, h, "hello", "dm:addy"); // same account, also capped
    assert.equal(hits.length, 10);
    await wake(s, h, "hello", "dm:dummy"); // grok-2: separate cap
    assert.equal(hits.length, 11);
  });
});

test("second wake for the same bot+room while in flight is refused", async () => {
  await withServer({}, null, async (s, h) => {
    await wake(s, h, "first", "dm:dummy");
    assert.equal(hits.length, 1);
    await wake(s, h, "second", "dm:dummy");
    assert.equal(hits.length, 1);
    assert.ok((await msgs(s, h, "dm:dummy")).some((m) => m.system && /still working/.test(m.text)));
    await wake(s, h, "@Dummy other room", "group", ["nova"]); // different room is fine
    assert.equal(hits.length, 2);
  });
});

test("agent-reply auth: missing/wrong/empty bearer -> 401, and other /api routes stay gated", async () => {
  await withServer({}, null, async (s) => {
    const body = { job_id: "x", bot_id: "dummy", text: "hi" };
    assert.equal((await reply(s, body, null)).status, 401);
    assert.equal((await reply(s, body, "wrong")).status, 401);
    assert.equal((await reply(s, body, "")).status, 401);
    assert.equal((await postJson(s.base + "/api/agent-reply", body, { Authorization: "Bearer" })).status, 401);
    assert.equal((await reply(s, body)).status, 404); // right token, no such job
    for (const p of ["/api/config", "/api/messages", "/api/usage"]) assert.equal((await fetch(s.base + p)).status, 401);
    assert.equal((await postJson(s.base + "/api/messages", { text: "x" })).status, 401);
    // A cross-origin browser write is still refused.
    const x = await postJson(s.base + "/api/agent-reply", body, { Authorization: `Bearer ${REPLY}`, Origin: "https://evil.example" });
    assert.equal(x.status, 403);
  });
  await withServer({ BOTHUB_REPLY_TOKEN: "" }, null, async (s) => { // unset/empty token: nothing authenticates
    assert.equal((await reply(s, { job_id: "x", bot_id: "dummy", text: "hi" }, "")).status, 401);
    assert.equal((await reply(s, { job_id: "x", bot_id: "dummy", text: "hi" }, "undefined")).status, 401);
  });
});

test("callback appends once, is idempotent, rejects wrong bot/unknown job, records a $0 plan run", async () => {
  await withServer({}, null, async (s, h) => {
    await wake(s, h, "@Dummy report please");
    const jobId = hits[0].body.job_id;
    assert.equal((await reply(s, { job_id: jobId, bot_id: "asschub", text: "nope" })).status, 404);
    assert.equal((await reply(s, { job_id: "00000000-0000-0000-0000-000000000000", bot_id: "dummy", text: "nope" })).status, 404);
    assert.equal((await reply(s, { job_id: jobId, bot_id: "dummy" })).status, 400);

    assert.equal((await reply(s, { job_id: jobId, bot_id: "dummy", text: "All good." })).status, 200);
    assert.equal((await reply(s, { job_id: jobId, bot_id: "dummy", text: "All good." })).status, 200);
    assert.equal((await reply(s, { job_id: jobId, bot_id: "dummy", text: "A different late answer" })).status, 200);
    assert.equal((await reply(s, { job_id: jobId, bot_id: "dummy", error: "boom" })).status, 200);
    assert.equal((await reply(s, { job_id: jobId, bot_id: "asschub", text: "x" })).status, 404);
    const fromDummy = (await msgs(s, h)).filter((m) => m.speaker === "Dummy");
    assert.equal(fromDummy.length, 1);
    assert.equal(fromDummy[0].text, "All good.");
    assert.equal(fromDummy[0].botId, "dummy");

    const u = await (await fetch(s.base + "/api/usage?days=all", { headers: h })).json();
    assert.equal(u.total.requests, 1);
    assert.equal(u.total.cost, 0);
    assert.equal(u.total.planCalls, 1);
    assert.equal(u.total.input + u.total.output, 0);
    assert.equal(u.recent[0].plan, true);
    assert.equal(u.recent[0].cost, 0);
    assert.equal(u.byBot.dummy.planCalls, 1);
    assert.equal(u.byAccount["grok-2"].cost, 0);

    // In-flight is cleared: the same bot+room can be woken again.
    await wake(s, h, "@Dummy again");
    assert.equal(hits.length, 2);
  });
});

test("callback {error} records an error line (hidden from transcripts), not a plan run", async () => {
  await withServer({}, null, async (s, h) => {
    await wake(s, h, "hi", "dm:dummy");
    const r = await reply(s, { job_id: hits[0].body.job_id, bot_id: "dummy", error: "tool crashed" });
    assert.equal(r.status, 200);
    const m = (await msgs(s, h, "dm:dummy")).find((x) => x.speaker === "Dummy");
    assert.equal(m.text, "Error: tool crashed");
    assert.equal(m.error, true);
    assert.equal(m.hidden, true);
    const u = await (await fetch(s.base + "/api/usage?days=all", { headers: h })).json();
    assert.equal(u.total.errors, 1);
    assert.equal(u.total.cost, 0);
  });
});

test("late callbacks: accepted up to 30 minutes (survives restart), rejected after", async () => {
  const NOW = Date.parse(NOON);
  const job = (id, ageMin) => ({ id, botId: "dummy", room: "dm:dummy", account: "grok-2", ts: NOW - ageMin * 60_000, status: "open", timeoutNoted: true });
  const seed = (dir) => fs.writeFileSync(path.join(dir, "agent-jobs.json"), JSON.stringify({
    jobs: { late: job("late", 20), old: job("old", 31), fresh: job("fresh", 6) },
    wakes: [],
  }));
  await withServer({}, seed, async (s, h) => {
    // 20-minute-old job persisted before "restart" is still matched.
    assert.equal((await reply(s, { job_id: "late", bot_id: "dummy", text: "sorry, late" })).status, 200);
    assert.equal((await reply(s, { job_id: "old", bot_id: "dummy", text: "too late" })).status, 404);
    assert.equal((await reply(s, { job_id: "old", bot_id: "dummy", text: "too late" })).status, 404);
    const texts = (await msgs(s, h, "dm:dummy")).filter((m) => m.speaker === "Dummy").map((m) => m.text);
    assert.deepEqual(texts, ["sorry, late"]);
    // The expired job blocks nothing and a note says we gave up.
    assert.ok((await msgs(s, h, "dm:dummy")).some((m) => m.system && /giving up/.test(m.text)));
    // In-flight job from before the restart blocks a new wake.
    await wake(s, h, "again", "dm:dummy");
    assert.equal(hits.length, 0, "the persisted 6-minute-old job is still in flight for dm:dummy");
    assert.equal((await reply(s, { job_id: "fresh", bot_id: "dummy", text: "ok" })).status, 200);
    await wake(s, h, "again", "dm:dummy");
    assert.equal(hits.length, 1);
  });
});

test("5-minute 'still waiting' note appears for a persisted job, which stays open", async () => {
  const NOW = Date.parse(NOON);
  const seed = (dir) => fs.writeFileSync(path.join(dir, "agent-jobs.json"), JSON.stringify({
    jobs: { slow: { id: "slow", botId: "asschub", room: "dm:asschub", account: "grok-1", ts: NOW - 6 * 60_000, status: "open", timeoutNoted: false } },
    wakes: [],
  }));
  await withServer({}, seed, async (s, h) => {
    assert.ok(await until(async () => (await msgs(s, h, "dm:asschub")).some((m) => m.system && /taking longer/.test(m.text))));
    assert.equal((await reply(s, { job_id: "slow", bot_id: "asschub", text: "here now" })).status, 200);
    assert.equal((await msgs(s, h, "dm:asschub")).filter((m) => m.speaker === "Asschub").length, 1);
  });
});

test("webhook 500 and timeout: one try, no retry, error note shown, room freed", async () => {
  await withServer({}, null, async (s, h) => {
    mode = "500";
    await wake(s, h, "hi", "dm:dummy");
    assert.ok(await until(async () => (await msgs(s, h, "dm:dummy")).some((m) => m.system && /Couldn't reach Dummy \(HTTP 500\)/.test(m.text))));
    await sleep(500);
    assert.equal(hits.length, 1, "no retry");
    mode = "ok";
    await wake(s, h, "again", "dm:dummy"); // failed job doesn't hold the room
    assert.equal(hits.length, 2);
  });
});

test("webhook timeout (8s) is one try", { timeout: 30000 }, async () => {
  await withServer({}, null, async (s, h) => {
    mode = "slow";
    await wake(s, h, "hi", "dm:asschub");
    assert.equal(hits.length, 1);
    assert.ok(await until(async () => (await msgs(s, h, "dm:asschub")).some((m) => m.system && /timed out/.test(m.text)), 15000));
    await sleep(500);
    assert.equal(hits.length, 1, "no retry after timeout");
    assert.ok(!(s.output().includes(HOOK_KEY)));
  });
});
