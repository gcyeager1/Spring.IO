import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { hashPassword } from "../src/auth.js";
import { startServer, postJson } from "./helpers.js";
import { sanitizeBody } from "../src/realagent.js";

const EMAIL = "admin@example.com";
const PASSWORD = "a-long-test-password";
const HOOK_KEY = "wakelog-webhook-key-abc";
const REPLY = "wakelog-reply-token-xyz";
const NOON = "2026-06-03T15:00:00-04:00";
const NIGHT = "2026-06-03T23:00:00-04:00";

const hits = [];
let status = 200;
const listener = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    hits.push({ bot: req.url.slice(1), auth: req.headers.authorization, body: JSON.parse(raw || "{}") });
    res.writeHead(status);
    res.end(status >= 400 ? "unauthorized  for\nkey Bearer abcdef123 token 0123456789abcdef0123456789abcdef0123" : "{}");
  });
});
let hookPort;
before(async () => { await new Promise((r) => listener.listen(0, "127.0.0.1", r)); hookPort = listener.address().port; });
after(() => listener.close());
beforeEach(() => { hits.length = 0; status = 200; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(30); }
  return false;
};

async function withServer(extra, seed, fn) {
  const env = {
    BOTHUB_ADMIN_EMAIL: EMAIL, BOTHUB_ADMIN_PASSWORD_HASH: hashPassword(PASSWORD), BOTHUB_REPLY_TOKEN: REPLY, BOTHUB_NOW: NOON,
    BOTHUB_WEBHOOK_URL_ASSCHUB: `http://127.0.0.1:${hookPort}/asschub`, BOTHUB_WEBHOOK_KEY_ASSCHUB: HOOK_KEY,
  };
  const s = await startServer({ ...env, ...extra }, seed);
  try {
    const r = await postJson(s.base + "/api/login", { email: EMAIL, password: PASSWORD });
    await fn(s, { Cookie: (r.headers.get("set-cookie") ?? "").split(";")[0] });
  } finally { await s.stop(); }
}
async function human(s, h, text) {
  for (let i = 0; i < 50; i++) {
    const r = await postJson(s.base + "/api/messages", { room: "group", text, participants: ["nova"] }, h);
    if (r.status !== 409) return r;
    await sleep(60);
  }
  throw new Error("room stayed busy");
}
const notes = async (s, h) => (await (await fetch(`${s.base}/api/messages?room=group`, { headers: h })).json()).filter((m) => m.system).map((m) => m.text);
const noSecrets = (s) => { assert.ok(!s.output().includes(HOOK_KEY)); assert.ok(!s.output().includes(REPLY)); assert.ok(!s.output().includes(`127.0.0.1:${hookPort}/asschub`)); };

test("human @Asschub: one POST, wake + result lines logged, no secrets", async () => {
  await withServer({}, null, async (s, h) => {
    assert.equal((await human(s, h, "@Asschub hi")).status, 202);
    assert.ok(await until(() => /wake: result .*status=200/.test(s.output())));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].body.hop, 0);
    assert.equal(hits[0].body.bot_id, "asschub");
    const out = s.output();
    assert.match(out, /wake: human room=group mentions=asschub real=asschub/);
    assert.match(out, /wake: bot=asschub room=group chain=\S{8} hop=0 source=env result=sent/);
    assert.match(out, /wake: result bot=asschub job=\S{8} status=200 ms=\d+/);
    assert.match(out, /bridge: asschub source=env host=127\.0\.0\.1:\d+/);
    noSecrets(s);
  });
});

test("webhook answering 202 counts as success", async () => {
  status = 202;
  await withServer({}, null, async (s, h) => {
    await human(s, h, "@Asschub hi");
    assert.ok(await until(() => /status=202/.test(s.output())));
    await sleep(200);
    assert.ok(!(await notes(s, h)).some((t) => /Couldn't reach/.test(t)));
  });
});

test("webhook answering 401: note has HTTP 401, result line logged, body redacted, no secrets", async () => {
  status = 401;
  await withServer({}, null, async (s, h) => {
    await human(s, h, "@Asschub hi");
    assert.ok(await until(() => /status=401/.test(s.output())));
    assert.ok(await until(async () => (await notes(s, h)).some((t) => /Couldn't reach Asschub \(HTTP 401\)/.test(t))));
    const out = s.output();
    assert.match(out, /body="unauthorized for key \[redacted\] token \[redacted\]"/);
    noSecrets(s);
  });
});

test("quiet hours logs reason=quiet-hours", async () => {
  await withServer({ BOTHUB_NOW: NIGHT }, null, async (s, h) => {
    await human(s, h, "@Asschub hi");
    assert.ok(await until(() => /result=skip reason=quiet-hours/.test(s.output())));
    assert.equal(hits.length, 0);
  });
});

const seedJob = (ageMin) => (dir) => {
  const ts = Date.parse(NOON) - ageMin * 60_000;
  fs.writeFileSync(path.join(dir, "agent-jobs.json"), JSON.stringify({
    jobs: { oldjob: { id: "oldjob", botId: "asschub", room: "group", account: "grok-1", ts, status: "open", timeoutNoted: true } },
    wakes: [], chains: {},
  }));
};

test("open job older than 10 minutes does not block a new wake", async () => {
  await withServer({}, seedJob(11), async (s, h) => {
    await human(s, h, "@Asschub hi");
    assert.ok(await until(() => hits.length === 1));
    assert.doesNotMatch(s.output(), /reason=in-flight/);
  });
});

test("open job younger than 10 minutes still blocks with reason=in-flight", async () => {
  await withServer({}, seedJob(5), async (s, h) => {
    await human(s, h, "@Asschub hi");
    assert.ok(await until(() => /result=skip reason=in-flight/.test(s.output())));
    assert.equal(hits.length, 0);
  });
});

test("sanitizeBody collapses whitespace, redacts tokens, caps length", () => {
  assert.equal(sanitizeBody("a \n b  Bearer xyz"), "a b [redacted]");
  assert.equal(sanitizeBody("x".repeat(500)), "[redacted]");
  assert.equal(sanitizeBody("word ".repeat(100)).length, 200);
});
