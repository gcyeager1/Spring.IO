import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword } from "../src/auth.js";
import { startServer, postJson } from "./helpers.js";

const EMAIL = "admin@example.com";
const PASSWORD = "a-long-test-password";
const REPLY = "msgs-reply-token";
const INGEST = "msgs-ingest-token";

async function withServer(fn) {
  const s = await startServer({
    BOTHUB_ADMIN_EMAIL: EMAIL, BOTHUB_ADMIN_PASSWORD_HASH: hashPassword(PASSWORD),
    BOTHUB_REPLY_TOKEN: REPLY, BOTHUB_INGEST_TOKEN: INGEST,
  });
  try {
    const r = await postJson(s.base + "/api/login", { email: EMAIL, password: PASSWORD });
    const h = { Cookie: (r.headers.get("set-cookie") ?? "").split(";")[0] };
    s.garrettToken = (await (await postJson(s.base + "/api/reply-tokens/garrett/reveal", {}, h)).json()).token;
    await fn(s, h);
  } finally { await s.stop(); }
}
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const get = (s, room, headers = {}) => fetch(`${s.base}/api/messages${room ? `?room=${room}` : ""}`, { headers });

test("GET /api/messages: 401 without auth, with a bad bearer, or with an ingest token", async () => {
  await withServer(async (s) => {
    assert.equal((await get(s, "group")).status, 401);
    assert.equal((await get(s, "group", bearer("nope"))).status, 401);
    assert.equal((await get(s, "group", bearer(INGEST))).status, 401);
  });
});

test("GET with the lifteasy reply token matches a session GET; room validation applies", async () => {
  await withServer(async (s, h) => {
    const p = await postJson(s.base + "/api/messages", { room: "dm:asschub", text: "hello there" }, h);
    assert.equal(p.status, 202);
    const viaSession = await (await get(s, "dm:asschub", h)).json();
    assert.ok(viaSession.some((m) => m.text === "hello there"));
    const r = await get(s, "dm:asschub", bearer(REPLY));
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), viaSession);
    const g = await get(s, "group", bearer(REPLY));
    assert.equal(g.status, 200);
    assert.deepEqual(await g.json(), await (await get(s, "group", h)).json());
    const all = await get(s, null, bearer(REPLY));
    assert.equal(all.status, 200);
    assert.deepEqual(await all.json(), await (await get(s, null, h)).json());
    assert.equal((await get(s, "nowhere", bearer(REPLY))).status, 400);
  });
});

test("GET with the garrett reply token is 403 under default agentPosters", async () => {
  await withServer(async (s) => {
    assert.equal((await get(s, "group", bearer(s.garrettToken))).status, 403);
  });
});

test("POST and DELETE with a reply token and no session are 401 and change nothing", async () => {
  await withServer(async (s, h) => {
    await postJson(s.base + "/api/messages", { room: "dm:asschub", text: "keep me" }, h);
    const before = await (await get(s, "dm:asschub", h)).json();
    for (const token of [REPLY, s.garrettToken]) {
      const p = await postJson(s.base + "/api/messages", { room: "dm:asschub", text: "intruder" }, bearer(token));
      assert.equal(p.status, 401);
      const d = await fetch(s.base + "/api/messages?room=dm:asschub", { method: "DELETE", headers: bearer(token) });
      assert.equal(d.status, 401);
    }
    assert.deepEqual(await (await get(s, "dm:asschub", h)).json(), before);
  });
});

test("server output does not contain the reply tokens", async () => {
  await withServer(async (s) => {
    await get(s, "group", bearer(REPLY));
    await get(s, "group", bearer(s.garrettToken));
    assert.ok(!s.output().includes(REPLY));
    assert.ok(!s.output().includes(s.garrettToken));
  });
});
