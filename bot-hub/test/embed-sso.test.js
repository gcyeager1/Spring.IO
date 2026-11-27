import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword } from "../src/auth.js";
import { startServer, postJson } from "./helpers.js";

const EMAIL = "admin@example.com";
const PASSWORD = "a-long-test-password";
const SECRET = "sso-secret-sso-secret-sso-secret-1234";
const BASE_ENV = { BOTHUB_ADMIN_EMAIL: EMAIL, BOTHUB_ADMIN_PASSWORD_HASH: hashPassword(PASSWORD) };
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

async function withServer(extra, fn) {
  const s = await startServer({ ...BASE_ENV, ...extra });
  try { await fn(s); } finally { await s.stop(); }
}
const mint = (s, headers = bearer(SECRET), body = {}) => postJson(s.base + "/api/sso/ticket", body, headers);
const ticketOf = (j) => new URL(j.embedUrl).searchParams.get("ticket");
const sso = (s, t) => fetch(`${s.base}/sso?ticket=${encodeURIComponent(t)}`, { redirect: "manual" });

test("frame-ancestors CSP on HTML and API, no X-Frame-Options", async () => {
  await withServer({}, async (s) => {
    for (const p of ["/", "/login", "/api/health"]) {
      const r = await fetch(s.base + p, { redirect: "manual" });
      const csp = r.headers.get("content-security-policy") ?? "";
      assert.match(csp, /^frame-ancestors /, p);
      assert.ok(csp.includes("'self'") && csp.includes("https://crm.ezliftgaragedoorservice.com"), p);
      assert.ok(csp.includes("https://ez-lift-crm-production.up.railway.app") && csp.includes("http://localhost:4721"), p);
      assert.equal(r.headers.get("x-frame-options"), null, p);
    }
  });
});

test("BOTHUB_FRAME_ANCESTORS accepts https and local http only", async () => {
  await withServer({ BOTHUB_FRAME_ANCESTORS: "https://extra.example.com, http://evil.example.com, javascript:x, http://localhost:9999, *, https://a.example.com/path" }, async (s) => {
    const csp = (await fetch(s.base + "/login")).headers.get("content-security-policy");
    assert.ok(csp.includes("https://extra.example.com") && csp.includes("http://localhost:9999"));
    for (const bad of ["evil.example.com", "javascript", " * ", "https://a.example.com"]) assert.ok(!csp.includes(bad), bad);
  });
});

test("mint: 503 when unconfigured, and normal login still works", async () => {
  await withServer({}, async (s) => {
    const r = await mint(s);
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: "SSO is not configured" });
    assert.equal((await sso(s, "anything")).headers.get("location"), "/login");
    assert.equal((await postJson(s.base + "/api/login", { email: EMAIL, password: PASSWORD })).status, 200);
    assert.equal((await (await fetch(s.base + "/api/health")).json()).ok, true);
  });
});

test("mint: 401 without secret / wrong bearer / session cookie only; 200 with the secret", async () => {
  await withServer({ BOTHUB_CRM_SSO_SECRET: SECRET }, async (s) => {
    assert.equal((await mint(s, {})).status, 401);
    assert.equal((await mint(s, bearer("wrong"))).status, 401);
    assert.equal((await mint(s, { Authorization: "Bearer " })).status, 401);
    const login = await postJson(s.base + "/api/login", { email: EMAIL, password: PASSWORD });
    const cookie = { Cookie: (login.headers.get("set-cookie") ?? "").split(";")[0] };
    assert.equal((await mint(s, cookie)).status, 401);
    const r = await mint(s, bearer(SECRET), { email: "o@x.com", name: "Office", source: "web", junk: 1 });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("set-cookie"), null);
    const text = await r.text();
    const j = JSON.parse(text);
    assert.equal(j.ok, true);
    assert.equal(j.expiresIn, 60);
    assert.deepEqual(Object.keys(j).sort(), ["embedUrl", "expiresIn", "ok"]);
    assert.ok(j.embedUrl.startsWith(s.base + "/sso?ticket="));
    assert.ok(j.embedUrl.includes("embed=1"));
    assert.ok(ticketOf(j).length >= 43);
    assert.ok(!/secret|BOTHUB_/i.test(text) && !text.includes(SECRET));
    assert.ok(!s.output().includes(SECRET) && !s.output().includes(ticketOf(j)));
  });
});

test("/sso: valid ticket -> session cookie (Lax) + redirect; single use; garbage -> /login; settings data reachable", async () => {
  await withServer({ BOTHUB_CRM_SSO_SECRET: SECRET }, async (s) => {
    const t = ticketOf(await (await mint(s)).json());
    const r = await sso(s, t);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "/?embed=1");
    const sc = r.headers.get("set-cookie") ?? "";
    assert.match(sc, /bothub_session=/);
    assert.match(sc, /SameSite=Lax/);
    assert.match(sc, /HttpOnly/);
    const again = await sso(s, t);
    assert.equal(again.status, 302);
    assert.equal(again.headers.get("location"), "/login");
    assert.equal(again.headers.get("set-cookie"), null);
    const g = await sso(s, "garbage");
    assert.equal(g.headers.get("location"), "/login");
    assert.equal(g.headers.get("set-cookie"), null);
    assert.equal((await fetch(s.base + "/sso", { redirect: "manual" })).headers.get("location"), "/login");

    const h = { Cookie: sc.split(";")[0] };
    for (const p of ["/api/config", "/api/team-brief", "/api/bridge", "/api/usage?days=all"]) assert.equal((await fetch(s.base + p, { headers: h })).status, 200, p);
    const page = await fetch(s.base + "/?embed=1", { headers: h });
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes('id="view-settings"'));
    assert.ok(!s.output().includes(t));
  });
});

test("CSRF unchanged: cross-origin POST refused, same-origin works", async () => {
  await withServer({ BOTHUB_CRM_SSO_SECRET: SECRET }, async (s) => {
    const x = await mint(s, { ...bearer(SECRET), Origin: "https://crm.ezliftgaragedoorservice.com" });
    assert.equal(x.status, 403);
    assert.equal((await x.json()).error, "Cross-origin request refused");
    assert.equal((await postJson(s.base + "/api/login", { email: EMAIL, password: PASSWORD }, { Origin: s.base })).status, 200);
  });
});

test("mint is rate limited: 31st request in an hour is 429", async () => {
  await withServer({ BOTHUB_CRM_SSO_SECRET: SECRET }, async (s) => {
    for (let i = 0; i < 30; i++) assert.equal((await mint(s)).status, 200, `mint ${i}`);
    const r = await mint(s);
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get("retry-after")) > 0);
  });
});
