import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { hashPassword } from "../src/auth.js";
import { startServer, postJson, cookieOf } from "./helpers.js";

const EMAIL = "admin@example.com";
const PASSWORD = "a-long-test-password";
let s;
let cookie;

before(async () => {
  s = await startServer({ BOTHUB_ADMIN_EMAIL: EMAIL, BOTHUB_ADMIN_PASSWORD_HASH: hashPassword(PASSWORD) });
});
after(() => s.stop());

test("health is public and leaks nothing", async () => {
  for (const p of ["/api/health", "/health"]) {
    const res = await fetch(s.base + p);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  }
});

test("protected APIs reject unauthenticated requests", async () => {
  for (const p of ["/api/config", "/api/messages", "/api/usage", "/api/events"]) {
    assert.equal((await fetch(s.base + p)).status, 401, p);
  }
  assert.equal((await postJson(s.base + "/api/messages", { text: "hi" })).status, 401);
});

test("HTML pages redirect to /login; login page is public", async () => {
  const res = await fetch(s.base + "/", { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/login");
  assert.equal((await fetch(s.base + "/app.js", { redirect: "manual" })).status, 302);
  const login = await fetch(s.base + "/login");
  assert.equal(login.status, 200);
  assert.match(await login.text(), /Sign in/);
  assert.equal((await fetch(s.base + "/auth/auth.js")).status, 200);
});

test("setup is closed when an admin is configured", async () => {
  const res = await postJson(s.base + "/api/setup", { email: "x@example.com", password: "another-long-password" });
  assert.equal(res.status, 403);
  const page = await fetch(s.base + "/setup", { redirect: "manual" });
  assert.equal(page.status, 302);
});

test("failed login gives the same answer for unknown email and wrong password", async () => {
  const a = await postJson(s.base + "/api/login", { email: "nobody@example.com", password: "whatever-whatever" });
  const b = await postJson(s.base + "/api/login", { email: EMAIL, password: "wrong-wrong-wrong" });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.deepEqual(await a.json(), await b.json());
  assert.equal(a.headers.get("set-cookie"), null);
});

test("login success sets a secure-flagged httpOnly SameSite cookie", async () => {
  const res = await postJson(s.base + "/api/login", { email: EMAIL.toUpperCase(), password: PASSWORD }, { "X-Forwarded-Proto": "https" });
  assert.equal(res.status, 200);
  const raw = res.headers.get("set-cookie");
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Strict/);
  assert.doesNotMatch(raw, /Secure/); // plain HTTP and proxy trust off -> no Secure
  assert.ok(!raw.includes(PASSWORD));
  cookie = cookieOf(res);
  assert.ok(cookie.length > 60);
});

test("session cookie unlocks the API, UI and SSE", async () => {
  const h = { Cookie: cookie };
  const cfg = await (await fetch(s.base + "/api/config", { headers: h })).json();
  assert.equal(cfg.mock, true);
  assert.ok(!JSON.stringify(cfg).includes("API_KEY"), "public config must not name key env vars");
  assert.ok(!/WEBHOOK|REPLY_TOKEN/.test(JSON.stringify(cfg)), "public config must not name webhook/reply env vars");
  assert.ok(cfg.bots.every((b) => !b.realAgent), "no webhook env set -> every bot is a stand-in");
  assert.equal((await fetch(s.base + "/", { headers: h })).status, 200);
  assert.equal((await fetch(s.base + "/login", { headers: h, redirect: "manual" })).status, 302);

  const ctl = new AbortController();
  const sse = await fetch(s.base + "/api/events", { headers: h, signal: ctl.signal });
  assert.equal(sse.status, 200);
  assert.match(sse.headers.get("content-type"), /text\/event-stream/);
  const { value } = await sse.body.getReader().read();
  assert.match(new TextDecoder().decode(value), /event: status/);
  ctl.abort();
});

test("tampered or forged cookies are rejected", async () => {
  const bad = cookie.slice(0, -3) + (cookie.endsWith("aaa") ? "bbb" : "aaa");
  assert.equal((await fetch(s.base + "/api/config", { headers: { Cookie: bad } })).status, 401);
  assert.equal((await fetch(s.base + "/api/config", { headers: { Cookie: "bothub_session=abc.123.def" } })).status, 401);
});

test("cross-origin writes are refused even with a session", async () => {
  const res = await postJson(s.base + "/api/stop", {}, { Cookie: cookie, Origin: "https://evil.example" });
  assert.equal(res.status, 403);
});

test("mock chat: private room reply is recorded in usage", async () => {
  const h = { Cookie: cookie };
  const post = await postJson(s.base + "/api/messages", { room: "dm:asschub", text: "hello" }, h);
  assert.equal(post.status, 202);
  let msgs;
  for (let i = 0; i < 50; i++) {
    msgs = await (await fetch(s.base + "/api/messages?room=dm:asschub", { headers: h })).json();
    if (msgs.some((m) => m.speaker === "Asschub")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(msgs.some((m) => m.speaker === "You"));
  assert.ok(msgs.some((m) => m.speaker === "Asschub"));
  const usage = await (await fetch(s.base + "/api/usage?days=all", { headers: h })).json();
  assert.ok(JSON.stringify(usage).includes("asschub"));
  assert.ok(fs.existsSync(path.join(s.dataDir, "usage.jsonl")), "usage lives in DATA_DIR");
  assert.ok(fs.existsSync(path.join(s.dataDir, "chat.jsonl")));
  assert.equal((await postJson(s.base + "/api/messages", { room: "dm:nobody", text: "x" }, h)).status, 400);
});

test("logout clears and revokes the session", async () => {
  const res = await postJson(s.base + "/api/logout", {}, { Cookie: cookie });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await fetch(s.base + "/api/config", { headers: { Cookie: cookie } })).status, 401);
});

test("login is rate limited per IP + email", async () => {
  let last;
  for (let i = 0; i < 6; i++) last = await postJson(s.base + "/api/login", { email: "victim@example.com", password: "nope-nope-nope" });
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get("retry-after")) > 0);
  // even the right password is refused for that pair while blocked...
  assert.equal((await postJson(s.base + "/api/login", { email: "victim@example.com", password: PASSWORD })).status, 429);
  // ...but another email from the same IP is not blocked yet
  assert.equal((await postJson(s.base + "/api/login", { email: EMAIL, password: PASSWORD })).status, 200);
});

test("first-run setup: opens only with no admin, creates hash in DATA_DIR, then closes", async () => {
  const t = await startServer({ BOTHUB_SETUP_TOKEN: "tok-123" });
  try {
    const root = await fetch(t.base + "/", { redirect: "manual" });
    assert.equal(root.headers.get("location"), "/setup");
    assert.equal((await fetch(t.base + "/setup")).status, 200);
    assert.equal((await fetch(t.base + "/api/config")).status, 401);

    const short = await postJson(t.base + "/api/setup", { email: "me@example.com", password: "short", token: "tok-123" });
    assert.equal(short.status, 400);
    const noTok = await postJson(t.base + "/api/setup", { email: "me@example.com", password: "a-long-test-password", token: "bad" });
    assert.equal(noTok.status, 403);

    const ok = await postJson(t.base + "/api/setup", { email: "me@example.com", password: "a-long-test-password", token: "tok-123" });
    assert.equal(ok.status, 200);
    const c = cookieOf(ok);
    assert.equal((await fetch(t.base + "/api/config", { headers: { Cookie: c } })).status, 200);

    const file = fs.readFileSync(path.join(t.dataDir, "admin.json"), "utf8");
    assert.match(file, /scrypt\$/);
    assert.ok(!file.includes("a-long-test-password"));

    assert.equal((await postJson(t.base + "/api/setup", { email: "z@example.com", password: "another-long-password", token: "tok-123" })).status, 403);
    assert.equal((await postJson(t.base + "/api/login", { email: "me@example.com", password: "a-long-test-password" })).status, 200);
  } finally {
    await t.stop();
  }
});
