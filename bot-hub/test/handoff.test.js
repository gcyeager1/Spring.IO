import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { hashPassword } from "../src/auth.js";
import { startServer, postJson } from "./helpers.js";
import { HANDOFF_CAP } from "../src/realagent.js";

const EMAIL = "admin@example.com";
const PASSWORD = "a-long-test-password";
const HOOK_KEY = "handoff-webhook-key";
const REPLY = "handoff-reply-token";
const NOON = "2026-06-03T15:00:00-04:00";
const NIGHT = "2026-06-03T23:00:00-04:00";
const GARRETT_BOTS = ["dummy", "crm-builder", "leads-garrett", "ads", "socials", "pawn"];
const HANDOFF_LINE = "Only Asschub, Dummy and Claude can hand off by @mentioning a bot (max 3 handoffs per chain, then wait for Garrett).";
const WIDE = "asschub,dummy,crm-builder,ads,addy,pawn,socials"; // lets a chain reach hop 3 in tests

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

async function withServer(extra, seed, fn) {
  const env = { BOTHUB_ADMIN_EMAIL: EMAIL, BOTHUB_ADMIN_PASSWORD_HASH: hashPassword(PASSWORD), BOTHUB_REPLY_TOKEN: REPLY, BOTHUB_NOW: NOON };
  for (const id of ["ASSCHUB", "DUMMY", "ADDY", "LEADS_LIFTEASY", "CRM_BUILDER", "ADS", "PAWN", "SOCIALS"]) {
    env[`BOTHUB_WEBHOOK_URL_${id}`] = `http://127.0.0.1:${hookPort}/${id.toLowerCase().replace(/_/g, "-")}`;
    env[`BOTHUB_WEBHOOK_KEY_${id}`] = HOOK_KEY;
  }
  const s = await startServer({ ...env, ...extra }, seed);
  try {
    const r = await postJson(s.base + "/api/login", { email: EMAIL, password: PASSWORD });
    const h = { Cookie: (r.headers.get("set-cookie") ?? "").split(";")[0] };
    s.garrettToken = (await (await postJson(s.base + "/api/reply-tokens/garrett/reveal", {}, h)).json()).token;
    await fn(s, h);
  } finally { await s.stop(); }
}
// The stand-in (nova) run blocks the room briefly, so retry while it answers 409.
async function human(s, h, text, room = "group") {
  for (let i = 0; i < 50; i++) {
    const r = await postJson(s.base + "/api/messages", { room, text, participants: ["nova"] }, h);
    if (r.status !== 409) return r;
    await sleep(60);
  }
  throw new Error("room stayed busy");
}
const botReply = (s, hit, text) => postJson(s.base + "/api/agent-reply", { job_id: hit.body.job_id, bot_id: hit.bot, text },
  { Authorization: `Bearer ${GARRETT_BOTS.includes(hit.bot) ? s.garrettToken : REPLY}` });
const notes = async (s, h, re) => (await (await fetch(`${s.base}/api/messages?room=group`, { headers: h })).json()).filter((m) => m.system && re.test(m.text));
const CAP_NOTE = /^Handoff limit reached \(3\)\. Bots are waiting for Garrett\.$/;

test("hop counting 0 -> 1 -> 2 -> 3 in one chain, cross-account, speaker + payload fields", async () => {
  await withServer({ BOTHUB_HANDOFF_TRIGGERS: WIDE }, null, async (s, h) => {
    assert.equal((await human(s, h, "hey @asschub")).status, 202);
    assert.ok(await until(() => hitsFor("asschub").length === 1));
    const a = hitsFor("asschub")[0].body;
    assert.deepEqual([a.hop, a.speaker], [0, "You"]);
    assert.match(a.chain_id, /^[0-9a-f-]{36}$/);

    await botReply(s, hitsFor("asschub")[0], "over to @dummy"); // grok-1 -> grok-2
    assert.ok(await until(() => hitsFor("dummy").length === 1));
    const d = hitsFor("dummy")[0].body;
    assert.deepEqual([d.hop, d.speaker, d.chain_id, d.text], [1, "Asschub", a.chain_id, "over to @dummy"]);

    await botReply(s, hitsFor("dummy")[0], "next @crm-builder");
    assert.ok(await until(() => hitsFor("crm-builder").length === 1));
    assert.deepEqual([hitsFor("crm-builder")[0].body.hop, hitsFor("crm-builder")[0].body.speaker], [2, "Dummy"]);

    await botReply(s, hitsFor("crm-builder")[0], "and @ads");
    // crm-builder is in the allowed list here, so ads is hop 3 (the last allowed one).
    assert.ok(await until(() => hitsFor("ads").length === 1));
    assert.deepEqual([hitsFor("ads")[0].body.hop, hitsFor("ads")[0].body.chain_id], [3, a.chain_id]);
    assert.equal(HANDOFF_CAP, 3);

    // Hop 4 would exceed the cap: nobody is woken, one note, only once per chain.
    await botReply(s, hitsFor("ads")[0], "finally @pawn");
    assert.ok(await until(async () => (await notes(s, h, CAP_NOTE)).length === 1));
    await sleep(200);
    assert.equal(hitsFor("pawn").length, 0);
    assert.equal((await notes(s, h, CAP_NOTE)).length, 1);
  });
});

test("cap note is posted only once per chain even if several bots hit the cap", async () => {
  await withServer({ BOTHUB_HANDOFF_TRIGGERS: WIDE }, null, async (s, h) => {
    await human(s, h, "go @asschub");
    assert.ok(await until(() => hitsFor("asschub").length === 1));
    await botReply(s, hitsFor("asschub")[0], "@dummy @addy"); // two hop-1 jobs
    assert.ok(await until(() => hitsFor("dummy").length === 1 && hitsFor("addy").length === 1));
    await botReply(s, hitsFor("dummy")[0], "@crm-builder");
    await botReply(s, hitsFor("addy")[0], "@pawn");
    assert.ok(await until(() => hitsFor("crm-builder").length === 1 && hitsFor("pawn").length === 1));
    await botReply(s, hitsFor("crm-builder")[0], "@ads");
    assert.ok(await until(() => hitsFor("ads").length === 1));
    await botReply(s, hitsFor("pawn")[0], "@socials");  // hop 3
    assert.ok(await until(() => hitsFor("socials").length === 1));
    await botReply(s, hitsFor("ads")[0], "@leads-lifteasy");     // would be hop 4
    await botReply(s, hitsFor("socials")[0], "@leads-lifteasy"); // also hop 4
    await sleep(400);
    assert.equal(hitsFor("leads-lifteasy").length, 0);
    assert.equal((await notes(s, h, CAP_NOTE)).length, 1);
  });
});

test("a bot never wakes itself; the same bot mentioned twice in one reply wakes once", async () => {
  await withServer({}, null, async (s, h) => {
    await human(s, h, "@asschub");
    assert.ok(await until(() => hitsFor("asschub").length === 1));
    await botReply(s, hitsFor("asschub")[0], "me @asschub, and @dummy then @Dummy again, @dummy!");
    assert.ok(await until(() => hitsFor("dummy").length === 1));
    await sleep(300);
    assert.equal(hitsFor("asschub").length, 1, "no self-wake");
    assert.equal(hitsFor("dummy").length, 1, "same-message dedupe");
  });
});

test("per-chain dedupe: A -> B -> A ping-pong is blocked, silently", async () => {
  await withServer({}, null, async (s, h) => {
    await human(s, h, "@asschub");
    assert.ok(await until(() => hitsFor("asschub").length === 1));
    await botReply(s, hitsFor("asschub")[0], "@dummy");
    assert.ok(await until(() => hitsFor("dummy").length === 1));
    await botReply(s, hitsFor("dummy")[0], "back to you @asschub");
    await sleep(400);
    assert.equal(hitsFor("asschub").length, 1);
    assert.equal((await notes(s, h, /./)).length, 0, "no note for a deduped wake");
  });
});

test("bots outside the allowed list wake nobody, with no note", async () => {
  await withServer({}, null, async (s, h) => {
    await human(s, h, "@addy");
    assert.ok(await until(() => hitsFor("addy").length === 1));
    await botReply(s, hitsFor("addy")[0], "pinging @asschub @dummy @crm-builder");
    await sleep(400);
    assert.equal(hits.length, 1, "only the original human wake");
    assert.equal((await notes(s, h, /./)).length, 0);
  });
});

test("allowed list: default, BOTHUB_HANDOFF_TRIGGERS override, exposed on GET /api/bridge", async () => {
  await withServer({}, null, async (s, h) => {
    const b = await (await fetch(s.base + "/api/bridge", { headers: h })).json();
    assert.equal(b.handoffCap, 3);
    assert.deepEqual(b.handoffTriggers, ["asschub", "dummy", "claude"]);
    assert.deepEqual(b.handoffNames, ["Asschub", "Dummy", "Claude"]);
    assert.equal(b.bots.length, 11);
  });
  await withServer({ BOTHUB_HANDOFF_TRIGGERS: " addy , dummy " }, null, async (s, h) => {
    assert.deepEqual((await (await fetch(s.base + "/api/bridge", { headers: h })).json()).handoffTriggers, ["addy", "dummy"]);
    await human(s, h, "@asschub @addy");
    assert.ok(await until(() => hitsFor("asschub").length === 1 && hitsFor("addy").length === 1));
    await botReply(s, hitsFor("asschub")[0], "@dummy"); // asschub no longer allowed
    await sleep(300);
    assert.equal(hitsFor("dummy").length, 0);
    await botReply(s, hitsFor("addy")[0], "@dummy");    // addy is
    assert.ok(await until(() => hitsFor("dummy").length === 1));
  });
  const { handoffTriggers } = await import("../src/config.js");
  const bots = [{ id: "hubclaude", account: "claude" }, { id: "x", account: "g" }];
  const accounts = [{ id: "claude", provider: "claude-code" }, { id: "g", provider: "xai" }];
  delete process.env.BOTHUB_HANDOFF_TRIGGERS;
  assert.deepEqual(handoffTriggers({ bots, accounts }), ["asschub", "dummy", "hubclaude"]);
  assert.deepEqual(handoffTriggers({ bots, accounts, handoffTriggers: ["x"] }), ["x"]);
});

test("quiet hours block bot-triggered wakes (chain state persisted in agent-jobs.json)", async () => {
  const ts = Date.parse(NIGHT) - 5 * 60_000;
  const seed = (dir) => fs.writeFileSync(path.join(dir, "agent-jobs.json"), JSON.stringify({
    jobs: { j1: { id: "j1", botId: "asschub", room: "group", account: "grok-1", ts, status: "open", timeoutNoted: true, chainId: "c1", hop: 0 } },
    wakes: [], chains: { c1: { ts, woken: ["asschub"], capNoted: false } },
  }));
  await withServer({ BOTHUB_NOW: NIGHT }, seed, async (s, h) => {
    const r = await postJson(s.base + "/api/agent-reply", { job_id: "j1", bot_id: "asschub", text: "@dummy" }, { Authorization: `Bearer ${REPLY}` });
    assert.equal(r.status, 200);
    await sleep(300);
    assert.equal(hits.length, 0);
    assert.equal((await notes(s, h, /offline until 7 AM Eastern.*Dummy was not woken/)).length, 1);
    const saved = JSON.parse(fs.readFileSync(path.join(s.dataDir, "agent-jobs.json"), "utf8"));
    assert.deepEqual(saved.chains.c1.woken, ["asschub"]);
  });
});

test("a new human message always starts a new chain at hop 0", async () => {
  await withServer({}, null, async (s, h) => {
    await human(s, h, "@asschub one");
    assert.ok(await until(() => hitsFor("asschub").length === 1));
    await botReply(s, hitsFor("asschub")[0], "@dummy");
    assert.ok(await until(() => hitsFor("dummy").length === 1));
    await human(s, h, "@asschub two");
    assert.ok(await until(() => hitsFor("asschub").length === 2));
    const [first, second] = hitsFor("asschub").map((x) => x.body);
    assert.equal(second.hop, 0);
    assert.notEqual(second.chain_id, first.chain_id);
    assert.notEqual(second.chain_id, hitsFor("dummy")[0].body.chain_id);
    // The new chain has its own once-per-bot budget: asschub's reply can wake dummy again.
    await botReply(s, hitsFor("dummy")[0], "done"); // free dummy's old job (one in flight per room)
    await botReply(s, hitsFor("asschub")[1], "@dummy");
    assert.ok(await until(() => hitsFor("dummy").length === 2));
    assert.deepEqual([hitsFor("dummy")[1].body.hop, hitsFor("dummy")[1].body.chain_id], [1, second.chain_id]);
  });
});

test("team brief: handoff line is line 2; existing files are migrated without duplicates", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ho-"));
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try {
    const tb = await import("../src/team-brief.js");
    assert.equal(tb.TEAM_BRIEF_HANDOFF, HANDOFF_LINE);
    const f = path.join(dir, "team-brief.txt");
    const R = tb.TEAM_BRIEF_RULE;
    fs.writeFileSync(f, `${R}\nMy notes\nmore\n`);
    tb.ensureTeamBrief();
    assert.equal(fs.readFileSync(f, "utf8"), `${R}\n${HANDOFF_LINE}\nMy notes\nmore\n`);
    tb.ensureTeamBrief();
    assert.equal(fs.readFileSync(f, "utf8"), `${R}\n${HANDOFF_LINE}\nMy notes\nmore\n`, "idempotent");
    fs.writeFileSync(f, `${R}\nMy notes\n${HANDOFF_LINE}\ntail\n`); // handoff line elsewhere: moved to line 2
    tb.ensureTeamBrief();
    assert.equal(fs.readFileSync(f, "utf8"), `${R}\n${HANDOFF_LINE}\nMy notes\ntail\n`);
    const saved = tb.saveTeamBrief("just mine").text; // save enforces both lines
    assert.deepEqual(saved.split("\n").slice(0, 3), [R, HANDOFF_LINE, "just mine"]);
    assert.equal(tb.saveTeamBrief(saved).text, saved);
  } finally {
    process.env.DATA_DIR = prev;
    if (prev === undefined) delete process.env.DATA_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
