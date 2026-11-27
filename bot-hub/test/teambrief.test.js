import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashPassword } from "../src/auth.js";
import { startServer, postJson } from "./helpers.js";

const EMAIL = "admin@example.com";
const PASSWORD = "a-long-test-password";
const RULE =
  "BOT HUB RULE: Use minimal usage here. Answer in 1-3 short sentences at the lowest effort. No tools, research, or long reasoning unless Garrett explicitly asks. Real work goes to your main chat, not the hub.";
const HANDOFF = "Only Asschub, Dummy and Claude can hand off by @mentioning a bot (max 3 handoffs per chain, then wait for Garrett).";
const env = { BOTHUB_ADMIN_EMAIL: EMAIL, BOTHUB_ADMIN_PASSWORD_HASH: hashPassword(PASSWORD) };

// Module under test reads DATA_DIR at call time, so point it at a temp dir per test.
async function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-"));
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try { await fn(dir, await import("../src/team-brief.js")); }
  finally { process.env.DATA_DIR = prev; if (prev === undefined) delete process.env.DATA_DIR; fs.rmSync(dir, { recursive: true, force: true }); }
}

test("missing file is seeded with the rule as line 1, mode 0600", () =>
  withDir((dir, tb) => {
    assert.equal(tb.TEAM_BRIEF_RULE, RULE);
    tb.ensureTeamBrief();
    const f = path.join(dir, "team-brief.txt");
    const lines = fs.readFileSync(f, "utf8").split("\n");
    assert.equal(lines[0], RULE);
    assert.equal(lines[1], HANDOFF);
    assert.equal(lines[2], "");
    assert.ok(lines[3].length > 0);
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  }));

test("existing file without the rule gets it prepended, rest preserved", () =>
  withDir((dir, tb) => {
    const f = path.join(dir, "team-brief.txt");
    const old = "Roles:\n- Dummy: CRM\n\nPriority: leads";
    fs.writeFileSync(f, old);
    tb.ensureTeamBrief();
    assert.equal(fs.readFileSync(f, "utf8"), `${RULE}\n${HANDOFF}\n${old}`);
  }));

test("existing file already starting with the rule is not duplicated", () =>
  withDir((dir, tb) => {
    const f = path.join(dir, "team-brief.txt");
    const cur = `${RULE}\n${HANDOFF}\n\nMy notes\n`;
    fs.writeFileSync(f, cur);
    tb.ensureTeamBrief();
    tb.ensureTeamBrief();
    assert.equal(fs.readFileSync(f, "utf8"), cur);
  }));

test("buildPayload includes team_brief with the rule first, read fresh", () =>
  withDir(async (dir, tb) => {
    const { buildPayload } = await import("../src/realagent.js");
    const job = { id: "j1", room: "group" };
    const p = buildPayload(job, { id: "asschub" }, "hi", []);
    assert.equal(p.team_brief.split("\n")[0], RULE);
    tb.saveTeamBrief("Fresh note");
    assert.equal(buildPayload(job, { id: "asschub" }, "hi", []).team_brief, `${RULE}\n${HANDOFF}\nFresh note`);
  }));

test("GET/PUT /api/team-brief: 401 signed out; PUT keeps the rule; GET reflects", async () => {
  const s = await startServer(env);
  try {
    assert.equal((await fetch(s.base + "/api/team-brief")).status, 401);
    const un = await fetch(s.base + "/api/team-brief", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "x" }) });
    assert.equal(un.status, 401);

    const login = await postJson(s.base + "/api/login", { email: EMAIL, password: PASSWORD });
    const h = { Cookie: (login.headers.get("set-cookie") ?? "").split(";")[0] };
    const first = await (await fetch(s.base + "/api/team-brief", { headers: h })).json();
    assert.equal(first.text.split("\n")[0], RULE);

    const put = await fetch(s.base + "/api/team-brief", { method: "PUT", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ text: "Only my notes" }) });
    assert.equal(put.status, 200);
    assert.equal((await put.json()).text, `${RULE}\n${HANDOFF}\nOnly my notes`);
    const got = await (await fetch(s.base + "/api/team-brief", { headers: h })).json();
    assert.equal(got.text, `${RULE}\n${HANDOFF}\nOnly my notes`);
    assert.equal(fs.readFileSync(path.join(s.dataDir, "team-brief.txt"), "utf8"), got.text);
    assert.ok(!s.output().includes("Only my notes"), "brief body must not be logged");
  } finally { await s.stop(); }
});

test("GET /api/team-brief with an account reply token; PUT stays session-only", async () => {
  const LIFT = "lifteasy-reply-token-for-brief-test";
  const s = await startServer({ ...env, BOTHUB_REPLY_TOKEN: LIFT });
  try {
    const bearer = (t) => ({ headers: { Authorization: `Bearer ${t}` } });
    assert.equal((await fetch(s.base + "/api/team-brief", bearer("wrong-token"))).status, 401);

    const lift = await fetch(s.base + "/api/team-brief", bearer(LIFT));
    assert.equal(lift.status, 200);
    assert.equal(lift.headers.get("cache-control"), "no-store");
    const liftBody = await lift.json();
    assert.equal(liftBody.text.split("\n")[0], RULE);

    const login = await postJson(s.base + "/api/login", { email: EMAIL, password: PASSWORD });
    const h = { Cookie: (login.headers.get("set-cookie") ?? "").split(";")[0] };
    const garrett = (await (await postJson(s.base + "/api/reply-tokens/garrett/reveal", {}, h)).json()).token;
    const g = await fetch(s.base + "/api/team-brief", bearer(garrett));
    assert.equal(g.status, 200);
    assert.deepEqual(await g.json(), liftBody);
    const sess = await (await fetch(s.base + "/api/team-brief", { headers: h })).json();
    assert.deepEqual(sess, liftBody);

    for (const t of [LIFT, garrett]) {
      const put = await fetch(s.base + "/api/team-brief", { method: "PUT", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: JSON.stringify({ text: "nope" }) });
      assert.equal(put.status, 401);
    }
    assert.ok(!fs.readFileSync(path.join(s.dataDir, "team-brief.txt"), "utf8").includes("nope"));
    assert.ok(!s.output().includes(LIFT) && !s.output().includes(garrett), "tokens must not be logged");
  } finally { await s.stop(); }
});
