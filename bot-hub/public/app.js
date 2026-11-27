// Bot Hub front end: phone-first chat with a menu sheet, a compact plan-usage row,
// private chats with each bot and a usage details page.
// No build step, no dependencies. Charts are hand-built SVG.

import { fmtShare, fmtPercentUsed, fmtResetEastern, fmtAgo as fmtReportAgo, isLeftoverBucket, reportFor, poolSlices, pieSvg, sliceColor, fmtPoolShare, EMPTY_PLAN_TEXT, claudeWindows, claudeSlices, fmtResetIn } from "/planusage.js";

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const store = {
  get(k, fallback) {
    try {
      const v = localStorage.getItem(`bothub.${k}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`bothub.${k}`, JSON.stringify(v));
    } catch {}
  },
};

const state = {
  config: null,
  days: store.get("days", "7"),
  view: store.get("view2", "group"), // "group" | "dm:<botId>" | "dash"
  botFilter: store.get("botFilter", null), // dashboard: null = all bots
  included: null, // Set of bot ids in the group chat
  rooms: new Map(), // room -> messages
  running: new Set(), // rooms with bots currently replying
  typing: new Map(), // room -> botId
  unread: {}, // room -> count
  usage: null,
  estimate: null, // latest estimate for the next send
  pendingEstimate: {}, // room -> estimate made when you pressed send
  lastSend: null, // { room, est, actual }
};

const isDm = (room) => String(room).startsWith("dm:");
const dmBot = (room) => room.slice(3);
const chatRoom = () => (state.view === "dash" || state.view === "settings" ? null : state.view);

// ---------- formatting ----------
const fmtUSD = (n) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : n === 0 ? "$0" : `$${n.toFixed(4)}`);
const fmtAxisUSD = (n) => (n === 0 ? "$0" : n >= 1 ? `$${+n.toFixed(2)}` : `$${+n.toPrecision(2)}`);
const fmtNum = (n) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(0)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n));
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmtSecs = (ms) => (ms ? `${(ms / 1000).toFixed(1)}s` : "–");
const fmtAgo = (ts) => {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const rangeLabel = () => ({ 1: "last 24h", 7: "last 7 days", 30: "last 30 days", all: "all time" })[state.days];

// ---------- identity: each bot has its own color (config order), never by rank ----------
const bot = (id) => state.config.bots.find((b) => b.id === id);
const botName = (id) => bot(id)?.name ?? id;
const botColor = (id) => {
  const i = state.config.bots.findIndex((b) => b.id === id);
  return i >= 0 && i < 8 ? `var(--series-${i + 1})` : "var(--series-other)";
};
const account = (id) => state.config.accounts.find((a) => a.id === id);
const accountName = (id) => account(id)?.name ?? id;
// Bot name plus its account, so two bots with the same name stay distinguishable.
// Retired bot ids (in old usage data but not in config) just show the stored id.
const botLabel = (id) => (bot(id) ? `${bot(id).name} · ${accountName(bot(id).account)}` : id);
const blankStats = () => ({ planCalls: 0, apiValue: 0, requests: 0, errors: 0, input: 0, cachedInput: 0, cacheWrite: 0, output: 0, cost: 0, latencyN: 0, latencySum: 0, groupCost: 0, directCost: 0, groupCalls: 0, directCalls: 0, daily: {} });
const onPlan = (b) => Boolean(account(b.account)?.plan) || Boolean(b.realAgent);
const realBadge = (b) => (b?.realAgent ? ` <span class="real-badge" title="A real agent: woken by @mention or in its private chat, replies when ready">Real bot</span>` : "");
const tokensIn = (s) => (s.input ?? 0) + (s.cachedInput ?? 0) + (s.cacheWrite ?? 0);
const avgLatency = (s) => (s.latencyN ? s.latencySum / s.latencyN : 0);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) location.href = "/login";
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}
const setStatus = (text) => ($("#note").textContent = text);
function refreshStatusText() {
  const running = state.running.size > 0;
  $("#stopbar").hidden = !running;
  if (!running) {
    $("#status").textContent = "";
    return setStatus("");
  }
  const names = [...state.running].map((r) => (isDm(r) ? botName(dmBot(r)) : "Group"));
  $("#status").textContent = `Replying: ${names.join(", ")}…`;
  setStatus("");
}

// ---------- shared tooltip ----------
const tip = $("#tooltip");
function showTip(e, html) {
  tip.innerHTML = html;
  tip.hidden = false;
  let x = e.clientX + 14;
  let y = e.clientY + 14;
  if (x + tip.offsetWidth > innerWidth - 8) x = e.clientX - tip.offsetWidth - 14;
  if (y + tip.offsetHeight > innerHeight - 8) y = e.clientY - tip.offsetHeight - 14;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}
const hideTip = () => (tip.hidden = true);
const tipRow = (color, label, value) =>
  `<div class="t-row"><span>${color ? `<span class="dot" style="background:${color}"></span>` : ""}${esc(label)}</span><span>${value}</span></div>`;

// ======================= Sidebar =======================

function avatarHtml(b, stateClass = null) {
  const initial = esc((b?.name ?? "?").trim()[0]?.toUpperCase() ?? "?");
  return `<span class="avatar" style="background:${botColor(b.id)}">${initial}${
    stateClass !== null ? `<span class="state ${stateClass}"></span>` : ""
  }</span>`;
}

function botState(b) {
  if ([...state.typing.values()].includes(b.id)) return "busy";
  if (account(b.account).problem) return "bad";
  const last = state.usage?.lastByBot?.[b.id];
  if (last && !last.ok) return "bad";
  return "on";
}

function lastMessageFrom(b) {
  let last = null;
  for (const msgs of state.rooms.values()) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].botId ? msgs[i].botId === b.id : msgs[i].speaker === b.name && (!msgs[i].account || msgs[i].account === b.account)) {
        if (!last || msgs[i].ts > last.ts) last = msgs[i];
        break;
      }
    }
  }
  return last;
}

const unreadBadge = (room) => (state.unread[room] ? `<span class="unread">${state.unread[room]}</span>` : "");

function roomTitle(view) {
  if (view === "dash") return "Usage details";
  if (view === "settings") return "Settings";
  if (isDm(view)) return botName(dmBot(view));
  return "Group chat";
}

// Menu rooms list + the group bot checklist. Name kept so existing callers keep working.
function renderSidebar() {
  const row = (view, label, extra = "") =>
    `<button type="button" class="sheet-row ${state.view === view ? "on" : ""}" data-room="${esc(view)}">${extra}<span class="grow">${label}</span>${unreadBadge(view)}</button>`;
  $("#room-list").innerHTML =
    row("group", "Group chat") +
    state.config.bots
      .map((b) => row(`dm:${b.id}`, `${esc(b.name)} <small>${esc(accountName(b.account))}</small>`, avatarHtml(b, botState(b))))
      .join("");
  $("#bot-list").innerHTML = state.config.bots
    .map(
      (b) => `<div class="check-row">
        <input type="checkbox" class="bot-check" id="bc-${esc(b.id)}" data-id="${esc(b.id)}" ${state.included.has(b.id) ? "checked" : ""} />
        <label for="bc-${esc(b.id)}"><span>${esc(b.name)}${realBadge(b)}</span><small>${esc(accountName(b.account))} · ${esc(b.model)}</small></label>
      </div>`,
    )
    .join("");
  const total = Object.values(state.unread).reduce((n, c) => n + c, 0);
  $("#menu-unread").hidden = !total;
  $("#menu-unread").textContent = total || "";
  $("#bots-btn").textContent = `Bots ${state.included.size}/${state.config.bots.length} ▾`;
  $("#theme-label").textContent = document.documentElement.dataset.theme === "light" ? "Light" : "Dark";
}

function openSheet(id) {
  closeSheets();
  $("#scrim").hidden = false;
  $(id).hidden = false;
}
function closeSheets() {
  $("#scrim").hidden = true;
  $("#menu-sheet").hidden = true;
  $("#bots-sheet").hidden = true;
}

function wireSidebar() {
  $("#menu-btn").addEventListener("click", () => openSheet("#menu-sheet"));
  $("#bots-btn").addEventListener("click", () => openSheet("#bots-sheet"));
  $("#scrim").addEventListener("click", closeSheets);
  addEventListener("keydown", (e) => e.key === "Escape" && closeSheets());
  $("#bot-list").addEventListener("change", (e) => {
    const cb = e.target.closest(".bot-check");
    if (!cb) return;
    cb.checked ? state.included.add(cb.dataset.id) : state.included.delete(cb.dataset.id);
    store.set("participants", [...state.included]);
    renderSidebar();
    scheduleEstimate(0);
  });
  $("#room-list").addEventListener("click", (e) => {
    const r = e.target.closest("[data-room]");
    if (!r) return;
    closeSheets();
    setView(r.dataset.room);
  });
  $("#menu-sheet").addEventListener("click", (e) => {
    const m = e.target.closest("[data-menu]");
    if (!m) return;
    closeSheets();
    setView(m.dataset.menu);
  });
  $("#theme-btn").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    store.set("theme", next);
    renderSidebar();
    if (state.usage) renderUsageRow(state.usage);
  });
}

async function setView(view) {
  if (isDm(view) && !bot(dmBot(view))) view = "group";
  state.view = view;
  store.set("view2", view);
  const chat = view !== "dash" && view !== "settings";
  $("#view-chat").hidden = !chat;
  $("#view-dash").hidden = view !== "dash";
  $("#view-settings").hidden = view !== "settings";
  $("#dock").hidden = !chat;
  $("#chat-name").textContent = roomTitle(view);
  if (view === "settings") { loadFeedKeys(); loadBridge(); loadReplyTokens(); loadTeamBrief(); }
  if (chat) {
    delete state.unread[view];
    if (!state.rooms.has(view)) state.rooms.set(view, await api(`/api/messages?room=${encodeURIComponent(view)}`));
    renderChat();
  } else if (view === "dash" && state.usage) {
    renderDashboard(state.usage);
  }
  renderSidebar();
  scheduleEstimate(0);
  const v = $(`#view-${chat ? "chat" : view}`);
  if (!chat) v.scrollTop = 0;
}

// ======================= Settings: usage feed keys =======================

const FEED_EXAMPLE = `POST ${location.origin}/api/plan-usage
Authorization: Bearer <token>
Content-Type: application/json

{
  "account": "garrett",
  "plan": "Ultra",
  "percentUsed": 8.1,
  "resetsAt": "2026-12-03T06:36:00-05:00",
  "onDemand": "Additional usage credits left: $0",
  "period": "this_week",
  "bots": [{ "name": "Dummy", "sharePct": 48 }],
  "routines": [],
  "reportedAt": "2026-11-26T15:21:00-05:00"
}`;

function hideFeedToken() {
  const t = $("#fk-token");
  t.value = "";
  t.hidden = true;
}
function showFeedMeta(m) {
  $("#fk-meta").textContent = m?.exists ? `created ${m.createdAt ? new Date(m.createdAt).toLocaleString() : "earlier"}` : "no key yet";
}
async function loadFeedKeys() {
  $("#fk-example").textContent = FEED_EXAMPLE;
  hideFeedToken();
  $("#fk-msg").textContent = "";
  try {
    showFeedMeta((await api("/api/ingest-keys")).garrett);
  } catch (e) {
    $("#fk-msg").textContent = e.message;
  }
}
function initFeedKeys() {
  const msg = (t) => ($("#fk-msg").textContent = t);
  $("#fk-reveal").addEventListener("click", async () => {
    try {
      const r = await api("/api/ingest-keys/garrett/reveal", { method: "POST" });
      $("#fk-token").value = r.token;
      $("#fk-token").hidden = false;
      showFeedMeta(r);
      msg("");
    } catch (e) { msg(e.message); }
  });
  $("#fk-copy").addEventListener("click", async () => {
    try {
      const r = await api("/api/ingest-keys/garrett/reveal", { method: "POST" });
      await navigator.clipboard.writeText(r.token);
      msg("Copied to clipboard.");
    } catch (e) { msg("Copy failed: " + e.message); }
  });
  $("#fk-regen").addEventListener("click", async () => {
    if (!confirm("Regenerate the garrett key? The current key stops working immediately and Dummy must be updated.")) return;
    try {
      const r = await api("/api/ingest-keys/garrett/regenerate", { method: "POST" });
      $("#fk-token").value = r.token;
      $("#fk-token").hidden = false;
      showFeedMeta(r);
      msg("New key issued. The previous key is revoked.");
    } catch (e) { msg(e.message); }
  });
}
initFeedKeys();

// ======================= Settings: bridge (real bots) + reply tokens =======================

const BRIDGE_GROUPS = [
  ["grok-1", "Lifteasy Door Services"],
  ["grok-2", "garrett yeager"],
];
const escHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function loadBridge() {
  const msg = $("#bridge-msg");
  msg.textContent = "";
  try {
    const { bots, handoffCap, handoffNames, agentPosterNames } = await api("/api/bridge");
    $("#bridge-handoff").innerHTML = `Bot-to-bot handoffs: max ${escHtml(handoffCap)} per chain<br>Can hand off: ${escHtml((handoffNames ?? []).join(", "))}<br>Can post directly: ${escHtml((agentPosterNames ?? []).join(", "))}`;
    $("#bridge-list").innerHTML = BRIDGE_GROUPS.map(([acct, title]) => `
      <figure class="card">
        <figcaption><span class="card-title">${escHtml(title)}</span></figcaption>
        ${bots.filter((b) => b.account === acct).map((b) => `
          <div class="bridge-row" data-bot="${escHtml(b.id)}" style="margin:10px 0">
            <div><b>${escHtml(b.name)}</b> <code>${escHtml(b.id)}</code>
              <span class="legend" data-role="status">key ${b.keySet ? "set" : "not set"}${b.keySet ? ` (${b.source === "volume" ? "saved" : "env"})` : ""}</span></div>
            <input type="text" data-role="url" value="${escHtml(b.url)}" placeholder="https://api2.cursor.sh/automations/webhook/…" autocomplete="off" spellcheck="false" style="width:100%;font-family:monospace;margin:4px 0" />
            <input type="password" data-role="key" value="" placeholder="leave blank to keep the current key" autocomplete="off" spellcheck="false" style="width:100%;font-family:monospace;margin:4px 0" />
            <div style="display:flex;gap:8px">
              <button type="button" class="ghost small" data-role="save">Save</button>
              <button type="button" class="ghost small" data-role="clear">Clear</button>
            </div>
          </div>`).join("")}
      </figure>`).join("");
  } catch (e) {
    msg.textContent = e.message;
  }
}
async function refreshRealBadges() {
  try {
    state.config = await api("/api/config");
    renderSidebar();
  } catch {}
}
function initBridge() {
  $("#bridge-list").addEventListener("click", async (ev) => {
    const btn = ev.target.closest("button[data-role]");
    if (!btn) return;
    const row = btn.closest(".bridge-row");
    const id = row.dataset.bot;
    const msg = $("#bridge-msg");
    try {
      if (btn.dataset.role === "save") {
        const body = { url: row.querySelector('[data-role="url"]').value.trim() };
        const key = row.querySelector('[data-role="key"]').value;
        if (key) body.key = key;
        await api(`/api/bridge/${encodeURIComponent(id)}`, { method: "PUT", body });
        msg.textContent = `Saved ${id}.`;
      } else {
        if (!confirm(`Clear the saved webhook for ${id}? It falls back to the environment, or to a stand-in.`)) return;
        await api(`/api/bridge/${encodeURIComponent(id)}`, { method: "DELETE" });
        msg.textContent = `Cleared ${id}.`;
      }
      await loadBridge();
      await refreshRealBadges();
    } catch (e) { msg.textContent = `${id}: ${e.message}`; }
  });
}
initBridge();

function showReplyMeta(which, m) {
  $(`#rt-${which}-meta`).textContent = m?.exists
    ? which === "garrett" ? `created ${m.createdAt ? new Date(m.createdAt).toLocaleString() : "earlier"}` : "set"
    : "not set";
}
async function loadReplyTokens() {
  for (const w of ["lifteasy", "garrett"]) {
    const t = $(`#rt-${w}-token`);
    t.value = "";
    t.hidden = true;
    $(`#rt-${w}-msg`).textContent = "";
  }
  try {
    const m = await api("/api/reply-tokens");
    showReplyMeta("lifteasy", m.lifteasy);
    showReplyMeta("garrett", m.garrett);
  } catch (e) { $("#rt-garrett-msg").textContent = e.message; }
}
function initReplyTokens() {
  for (const w of ["lifteasy", "garrett"]) {
    const msg = (t) => ($(`#rt-${w}-msg`).textContent = t);
    $(`#rt-${w}-reveal`).addEventListener("click", async () => {
      try {
        const r = await api(`/api/reply-tokens/${w}/reveal`, { method: "POST" });
        $(`#rt-${w}-token`).value = r.token;
        $(`#rt-${w}-token`).hidden = false;
        msg("");
      } catch (e) { msg(e.message); }
    });
    $(`#rt-${w}-copy`).addEventListener("click", async () => {
      try {
        const r = await api(`/api/reply-tokens/${w}/reveal`, { method: "POST" });
        await navigator.clipboard.writeText(r.token);
        msg("Copied to clipboard.");
      } catch (e) { msg("Copy failed: " + e.message); }
    });
  }
  $("#rt-garrett-regen").addEventListener("click", async () => {
    if (!confirm("Regenerate the garrett reply token? The current token stops working immediately and Dummy must be updated.")) return;
    try {
      const r = await api("/api/reply-tokens/garrett/regenerate", { method: "POST" });
      $("#rt-garrett-token").value = r.token;
      $("#rt-garrett-token").hidden = false;
      showReplyMeta("garrett", r);
      $("#rt-garrett-msg").textContent = "New token issued. The previous token is revoked.";
    } catch (e) { $("#rt-garrett-msg").textContent = e.message; }
  });
}
initReplyTokens();

async function loadTeamBrief() {
  $("#tb-msg").textContent = "";
  try { $("#tb-text").value = (await api("/api/team-brief")).text; } catch (e) { $("#tb-msg").textContent = e.message; }
}
$("#tb-save").addEventListener("click", async () => {
  try {
    const r = await api("/api/team-brief", { method: "PUT", body: { text: $("#tb-text").value } });
    $("#tb-text").value = r.text;
    $("#tb-msg").textContent = "Saved.";
  } catch (e) { $("#tb-msg").textContent = e.message; }
});

// ======================= Usage row (compact donuts under the header) =======================

const USAGE_OPEN_KEY = "usageOpen";
const donutClass = (p) => (p >= 90 ? "bad" : p >= 70 ? "warn" : "ok");
function donutHtml(pct) {
  const r = 16, c = 2 * Math.PI * r;
  const has = Number.isFinite(pct);
  const p = has ? Math.min(Math.max(pct, 0), 100) : 0;
  const label = has ? `${Math.round(pct)}%` : "–";
  return `<span class="u-donut"><svg viewBox="0 0 36 36" aria-hidden="true"><circle class="ring-bg" cx="18" cy="18" r="${r}"/>${
    has ? `<circle class="ring ${donutClass(pct)}" cx="18" cy="18" r="${r}" stroke-dasharray="${((p / 100) * c).toFixed(2)} ${c.toFixed(2)}"/>` : ""
  }</svg><span class="u-pct">${label}</span></span>`;
}

function usageSummary(u) {
  const g = (key) => {
    const r = reportFor(u.planUsage, key);
    return r && Number.isFinite(Number(r.percentUsed)) ? Number(r.percentUsed) : NaN;
  };
  const weekly = claudeWindows(u.planUsage?.claude).find((w) => w.key === "seven_day");
  return [
    { id: "lifteasy", name: "Lifteasy", pct: g("lifteasy") },
    { id: "garrett", name: "garrett", pct: g("garrett") },
    { id: "claude", name: "Claude", pct: weekly ? weekly.usedPct : NaN },
  ];
}

function usageDetailHtml(u) {
  const out = [];
  for (const [key, acctId, title] of [["lifteasy", "grok-1", "Lifteasy"], ["garrett", "grok-2", "garrett"]]) {
    const r = reportFor(u.planUsage, key);
    if (!r) {
      out.push(`<div class="u-line"><b>${esc(title)}</b><span>${EMPTY_PLAN_TEXT}</span></div>`);
      continue;
    }
    const top = poolSlices(r).slices.filter((s) => !s.remaining && s.pct > 0).sort((a, b) => b.pct - a.pct).slice(0, 3);
    const bits = [
      `${esc(r.plan ?? "Plan")} · ${esc(fmtPercentUsed(r.percentUsed))} used`,
      r.resetsAt ? `Resets ${esc(fmtResetEastern(r.resetsAt))}` : "",
      r.onDemand ? esc(r.onDemand) : "",
      top.length ? `Top: ${top.map((s) => `${esc(s.name)} ${fmtPoolShare(s.pct)}`).join(", ")}` : "",
    ].filter(Boolean);
    out.push(`<div class="u-line"><b>${esc(title)}</b>${bits.map((t) => `<span>${t}</span>`).join("")}</div>`);
  }
  const wins = claudeWindows(u.planUsage?.claude);
  const cl = u.planUsage?.claude;
  const lines = wins.length
    ? wins.map((w) => `<span>${esc(w.label)} · ${esc(fmtPercentUsed(w.usedPct))} used${w.reset ? " (reset)" : ` · Resets ${esc(fmtResetEastern(w.resetsAt))}`}</span>`).join("")
    : `<span>${EMPTY_PLAN_TEXT}</span>`;
  out.push(`<div class="u-line"><b>Claude</b>${lines}${cl?.updatedAt ? `<span>Updated ${esc(fmtReportAgo(cl.updatedAt))}</span>` : ""}</div>
    <div class="u-actions"><button type="button" class="ghost small claude-refresh" title="Refresh Claude usage" aria-label="Refresh Claude usage">↻ Refresh Claude</button><span class="u-msg" aria-live="polite"></span></div>`);
  return out.join("");
}

function renderUsageRow(u) {
  const open = store.get(USAGE_OPEN_KEY, false);
  $("#usage-toggle").innerHTML =
    usageSummary(u)
      .map((x) => `<span class="u-item" title="${esc(x.name)} weekly plan used">${donutHtml(x.pct)}<span class="u-name">${esc(x.name)}</span></span>`)
      .join("") + `<span class="u-chev" aria-hidden="true">${open ? "▴" : "▾"}</span>`;
  $("#usage-toggle").setAttribute("aria-expanded", String(open));
  const d = $("#usage-detail");
  d.hidden = !open;
  if (open) {
    const msg = d.querySelector(".u-msg")?.textContent ?? "";
    d.innerHTML = usageDetailHtml(u);
    d.querySelector(".u-msg").textContent = msg;
  }
}

function wireUsageRow() {
  $("#usage-toggle").addEventListener("click", () => {
    store.set(USAGE_OPEN_KEY, !store.get(USAGE_OPEN_KEY, false));
    if (state.usage) renderUsageRow(state.usage);
  });
}

// ======================= Chat (group or private) =======================

function messageHtml(m) {
  const you = m.speaker === "You";
  const b = m.botId ? bot(m.botId) : state.config.bots.find((x) => x.name === m.speaker && (!m.account || x.account === m.account));
  if (m.system) return `<li class="msg sys"><div class="bubble"><div class="body">${esc(m.text)}</div></div></li>`;
  const note = m.note ? `<span class="note">· ${esc(m.note)}</span>` : "";
  const acct = !you && (m.account || b?.account) ? `<span class="note">· ${esc(accountName(m.account ?? b.account))}</span>` : "";
  return `<li class="msg ${you ? "you" : ""} ${m.error ? "err" : ""}">
    <div class="who"><span class="name">${esc(m.speaker)}</span>${acct}<time datetime="${new Date(m.ts).toISOString()}">${fmtTime(m.ts)}</time>${note}</div>
    <div class="bubble"><div class="body">${esc(m.text)}</div></div></li>`;
}

function scrollChat() {
  const v = $("#view-chat");
  v.scrollTop = v.scrollHeight;
}

function renderChatHeader() {
  const room = chatRoom();
  if (isDm(room)) {
    const b = bot(dmBot(room));
    $("#input").placeholder = `Message ${b.name}…`;
  } else {
    $("#input").placeholder = state.included.size ? "Message the group…" : "Pick bots (Bots ▾), then message…";
  }
  $("#chat-name").textContent = roomTitle(state.view);
  document.querySelectorAll(".group-only").forEach((el) => (el.hidden = isDm(room)));
  $("#continue-btn").hidden = isDm(room);
  syncButtons();
}

function renderChat() {
  const room = chatRoom();
  renderChatHeader();
  const list = state.rooms.get(room) ?? [];
  const empty = isDm(room)
    ? `Start a private conversation with ${esc(botName(dmBot(room)))}.`
    : "Say something. The bots you picked (Bots ▾) will take turns replying.";
  $("#messages").innerHTML = list.length ? list.map(messageHtml).join("") : `<li class="empty">${empty}</li>`;
  const typingBot = state.typing.get(room);
  $("#typing").hidden = !typingBot;
  if (typingBot) $("#typing").textContent = `${botName(typingBot)} is typing…`;
  scrollChat();
}

function onMessage(m) {
  const room = m.room ?? "group";
  if (!state.rooms.has(room)) state.rooms.set(room, []);
  state.rooms.get(room).push(m);
  if (state.typing.get(room) && botName(state.typing.get(room)) === m.speaker) state.typing.delete(room);
  if (room === chatRoom()) {
    $("#messages .empty")?.remove();
    $("#messages").insertAdjacentHTML("beforeend", messageHtml(m));
    $("#typing").hidden = !state.typing.get(room);
    scrollChat();
  } else if (m.speaker !== "You") {
    state.unread[room] = (state.unread[room] ?? 0) + 1;
  }
  renderSidebar();
}

function syncButtons() {
  const room = chatRoom();
  const busy = room && state.running.has(room);
  $("#send-btn").disabled = Boolean(busy);
  $("#continue-btn").disabled = Boolean(busy);
  $("#clear-btn").disabled = Boolean(busy);
  $("#stop-btn").disabled = !state.running.size;
  $("#stopbar").hidden = !state.running.size;
}

async function send(text) {
  const room = chatRoom() ?? "group";
  const participants = state.config.bots.filter((b) => state.included.has(b.id)).map((b) => b.id);
  if (room === "group" && !participants.length) return setStatus("Pick at least one bot (Bots ▾) for the group chat.");
  clearTimeout(estimateTimer);
  const est = await requestEstimate(); // fresh, so it matches exactly what's being sent
  const over = overPlanLimit(est);
  if (over.length) {
    const list = over.map((o) => `${o.name} weekly plan usage to about ${Math.round(o.after)}%`).join(" and ");
    if (!confirm(`This send would take ${list}, over 100%. Send anyway?`)) return;
  }
  try {
    await api("/api/messages", { method: "POST", body: { room, text, participants, rounds: Number($("#rounds").value) || 1 } });
    state.pendingEstimate[room] = est?.message.cost ?? 0;
    $("#input").value = "";
    closeSheets();
    scheduleEstimate(0);
    autosize();
    if (state.view !== room) setView(room);
  } catch (e) {
    setStatus(e.message);
  }
}

function autosize() {
  const t = $("#input");
  t.style.height = "auto";
  t.style.height = `${Math.min(t.scrollHeight + 2, 160)}px`;
}

function wireChat() {
  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("#input").value.trim();
    if (text) send(text);
  });
  $("#input").addEventListener("input", autosize);
  $("#input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("#composer").requestSubmit();
    }
  });
  $("#continue-btn").addEventListener("click", () => {
    closeSheets();
    send("");
  });
  $("#stop-btn").addEventListener("click", () => {
    api("/api/stop", { method: "POST", body: {} });
    setStatus("Pausing after the current replies…");
  });
  $("#clear-btn").addEventListener("click", async () => {
    const room = chatRoom();
    const label = isDm(room) ? `your private chat with ${botName(dmBot(room))}` : "the group chat";
    closeSheets();
    if (!confirm(`Clear ${label}? Usage stats are kept.`)) return;
    try {
      await api(`/api/messages?room=${encodeURIComponent(room)}`, { method: "DELETE" });
    } catch (e) {
      setStatus(e.message);
    }
  });
}

// ======================= Usage meter =======================

const meterRoom = () => chatRoom() ?? "group";
const groupParticipants = () => state.config.bots.filter((b) => state.included.has(b.id)).map((b) => b.id);

let estimateTimer = null;
let estimateSeq = 0;
function scheduleEstimate(delay = 250) {
  clearTimeout(estimateTimer);
  estimateTimer = setTimeout(requestEstimate, delay);
}
async function requestEstimate() {
  const seq = ++estimateSeq;
  try {
    const est = await api("/api/estimate", {
      method: "POST",
      body: {
        room: meterRoom(),
        text: $("#input").value.trim(),
        participants: groupParticipants(),
        rounds: Number($("#rounds").value) || 1,
      },
    });
    if (seq !== estimateSeq) return est; // a newer request is on its way
    state.estimate = est;
    renderMeter();
    return est;
  } catch {
    return state.estimate; // the meter is best-effort; keep the last estimate
  }
}

// This send's estimated share of each plan account's weekly limit. The rate is calibrated from
// reported % used against tokens spent on that account. Accounts that can't be calibrated are skipped.
function planPctByAccount(est) {
  const u = state.usage;
  if (!est?.message?.calls || !u) return [];
  const byAcct = { "grok-1": { key: "lifteasy", name: "Lifteasy" }, "grok-2": { key: "garrett", name: "garrett" } };
  const out = new Map();
  for (const r of est.message.perBot ?? []) {
    if (!r.plan) continue;
    const acct = bot(r.bot)?.account;
    const a = byAcct[acct];
    if (!a) continue;
    const used = Number(reportFor(u.planUsage, a.key)?.percentUsed);
    const s = u.byAccount?.[acct];
    const tok = s ? tokensIn(s) + (s.output ?? 0) : 0;
    if (!(used > 0) || !(tok > 0)) continue;
    const e = out.get(acct) ?? { name: a.name, used, add: 0 };
    e.add += (used / tok) * (r.input + r.output);
    out.set(acct, e);
  }
  return [...out.values()];
}

// Dashboard meter: only meaningful for the 7-day range the calibration is based on.
function estimatePlanPct(est) {
  if (state.days !== "7") return null;
  const pct = planPctByAccount(est).reduce((t, e) => t + e.add, 0);
  return pct > 0 ? pct : null;
}

// Accounts whose weekly plan usage this send would push past 100%.
function overPlanLimit(est) {
  return planPctByAccount(est)
    .map((e) => ({ name: e.name, after: e.used + e.add }))
    .filter((e) => e.after > 100);
}

function renderMeter() {
  const pct = estimatePlanPct(state.estimate);
  $("#m-chip").textContent = pct === null ? "" : `≈${pct < 0.1 ? "<0.1" : +pct.toFixed(1)}% of weekly plan`;
}

function wireMeter() {
  $("#input").addEventListener("input", () => scheduleEstimate());
  $("#rounds").addEventListener("input", () => scheduleEstimate(0));
}

// ======================= Charts =======================

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 4, 5, 8, 10].map((m) => m * p).find((m) => m >= v * 1.0001) ?? 10 * p;
}
// Bar with only the data end rounded; the baseline end stays square.
function roundedTop(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
const svgPoint = (svg, e, W, H) => {
  const r = svg.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
};
const widthOf = (el) => Math.max(280, Math.round(el.clientWidth || 380));
const noData = (W, H, msg = "No calls in this range yet") =>
  `<svg viewBox="0 0 ${W} ${H}"><text class="nodata" x="${W / 2}" y="${H / 2}" text-anchor="middle">${msg}</text></svg>`;
const shownBots = () => (state.botFilter ? state.config.bots.filter((b) => b.id === state.botFilter) : state.config.bots);

function rangeStart(u) {
  if (state.days !== "all") return u.since;
  return u.points.length ? Math.min(u.points[0][0], u.now - 86_400_000) : u.now - 86_400_000;
}
function dayList(u) {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  let start;
  if (state.days === "all") {
    const keys = Object.keys(u.byDay).sort();
    start = keys.length ? new Date(`${keys[0]}T00:00:00Z`) : new Date(end);
  } else {
    start = new Date(end.getTime() - (Math.max(Number(state.days), 1) - 1) * 86_400_000);
  }
  const out = [];
  for (let d = start.getTime(); d <= end.getTime(); d += 86_400_000) out.push(new Date(d).toISOString().slice(0, 10));
  return out;
}
function yAxis(W, L, R, y, max, fmt) {
  let s = "";
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    s += `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`;
  }
  return s;
}

// --- Cumulative cost per bot: step lines, crosshair tooltip, direct end labels ---
function renderLine(u) {
  const el = $("#chart-line");
  const W = widthOf(el), H = 240, L = 52, R = 120, T = 12, B = 24;
  if (!u.points.length) return (el.innerHTML = noData(W, H));
  const t0 = rangeStart(u), t1 = u.now;
  const series = shownBots().map((b) => {
    let cum = 0;
    const pts = [[t0, 0]];
    for (const p of u.points) if (p[2] === b.id) pts.push([p[0], (cum += p[3])]);
    return { b, pts, total: cum };
  });
  const max = niceMax(Math.max(...series.map((s) => s.total)));
  const x = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v) => T + (H - T - B) - (v / max) * (H - T - B);

  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative cost by bot">` + yAxis(W, L, R, y, max, fmtAxisUSD);
  const span = t1 - t0;
  for (let i = 0; i <= 4; i++) {
    const t = t0 + (span / 4) * i;
    const lab = span <= 2 * 86_400_000
      ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
    s += `<text x="${x(t)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === 4 ? "end" : "middle"}">${lab}</text>`;
  }
  for (const sr of series) {
    let d = `M${x(sr.pts[0][0])},${y(0)}`;
    for (let i = 1; i < sr.pts.length; i++) d += `H${x(sr.pts[i][0])}V${y(sr.pts[i][1])}`;
    d += `H${x(t1)}`;
    s += `<path d="${d}" fill="none" stroke="${botColor(sr.b.id)}" stroke-width="2" stroke-linejoin="round"/>`;
  }
  const labels = series.map((sr) => ({ sr, y: y(sr.total) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 13);
  for (const l of labels) {
    s += `<text x="${W - R + 6}" y="${l.y + 4}" class="val">${esc(l.sr.b.name)} <tspan fill="var(--text-2)">${fmtUSD(l.sr.total)}</tspan></text>`;
  }
  s += `<line class="crosshair" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>`;
  s += `<rect class="hit-area" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/></svg>`;
  el.innerHTML = s;

  const svg = el.querySelector("svg");
  const cross = svg.querySelector(".crosshair");
  const area = svg.querySelector(".hit-area");
  area.addEventListener("mousemove", (e) => {
    const p = svgPoint(svg, e, W, H);
    const t = t0 + ((p.x - L) / (W - L - R)) * (t1 - t0);
    cross.setAttribute("x1", p.x);
    cross.setAttribute("x2", p.x);
    cross.setAttribute("visibility", "visible");
    const rows = series
      .map((sr) => {
        let v = 0;
        for (const [pt, pv] of sr.pts) {
          if (pt > t) break;
          v = pv;
        }
        return tipRow(botColor(sr.b.id), botLabel(sr.b.id), fmtUSD(v));
      })
      .join("");
    showTip(e, `<div class="t-head">${new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>${rows}`);
  });
  area.addEventListener("mouseleave", () => {
    cross.setAttribute("visibility", "hidden");
    hideTip();
  });
}

// --- Grouped bars: tokens in (faded) vs out (solid) per bot ---
function renderTokenBars(u) {
  const el = $("#chart-tokens");
  $("#legend-tokens").innerHTML =
    `<span><span class="dot" style="background:var(--text-2);opacity:.45"></span>In (faded)</span>` +
    `<span><span class="dot" style="background:var(--text-2)"></span>Out (solid)</span>`;
  const W = widthOf(el), H = 210, L = 44, R = 6, T = 10, B = 24;
  const groups = shownBots().map((b) => {
    const s = u.byBot[b.id] ?? blankStats();
    return { b, tin: tokensIn(s), tout: s.output };
  });
  if (!groups.some((g) => g.tin || g.tout)) return (el.innerHTML = noData(W, H));
  const max = niceMax(Math.max(...groups.map((g) => Math.max(g.tin, g.tout))));
  const y = (v) => T + (H - T - B) - (v / max) * (H - T - B);
  const step = (W - L - R) / groups.length;
  const bw = Math.min(28, step * 0.3);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Tokens in and out by bot">` + yAxis(W, L, R, y, max, fmtNum);
  groups.forEach((g, i) => {
    const cx = L + step * i + step / 2;
    const c = botColor(g.b.id);
    s += `<g class="col" data-i="${i}"><rect class="hit" x="${L + step * i}" y="${T}" width="${step}" height="${H - T - B}"/>`;
    const hin = y(0) - y(g.tin), hout = y(0) - y(g.tout);
    if (hin > 0) s += `<path d="${roundedTop(cx - bw - 1, y(g.tin), bw, hin, 4)}" fill="${c}" fill-opacity=".45"/>`;
    if (hout > 0) s += `<path d="${roundedTop(cx + 1, y(g.tout), bw, hout, 4)}" fill="${c}"/>`;
    s += `</g><text x="${cx}" y="${H - 6}" text-anchor="middle">${esc(g.b.name)}</text>`;
  });
  el.innerHTML = s + "</svg>";
  el.querySelectorAll(".col").forEach((gEl) => {
    const g = groups[Number(gEl.dataset.i)];
    gEl.addEventListener("mousemove", (e) =>
      showTip(e, `<div class="t-head">${esc(botLabel(g.b.id))}</div>${tipRow("", "Tokens in", fmtNum(g.tin))}${tipRow("", "Tokens out", fmtNum(g.tout))}`),
    );
    gEl.addEventListener("mouseleave", hideTip);
  });
}

// --- Stacked daily cost by bot ---
function renderDaily(u) {
  const el = $("#chart-daily");
  const bots = shownBots();
  const days = dayList(u);
  const W = widthOf(el), H = 210, L = 48, R = 6, T = 10, B = 24;
  if (!u.total.requests) return (el.innerHTML = noData(W, H));
  const totals = days.map((d) => bots.reduce((s, b) => s + (u.byDay[d]?.[b.id]?.cost ?? 0), 0));
  const max = niceMax(Math.max(...totals));
  const y = (v) => T + (H - T - B) - (v / max) * (H - T - B);
  const step = (W - L - R) / days.length;
  const bw = Math.max(3, Math.min(28, step * 0.6));
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily cost by bot">` + yAxis(W, L, R, y, max, fmtAxisUSD);
  const every = Math.ceil(days.length / 6);
  days.forEach((d, i) => {
    const cx = L + step * i + step / 2;
    s += `<g class="col" data-i="${i}"><rect class="hit" x="${L + step * i}" y="${T}" width="${step}" height="${H - T - B}"/>`;
    const segs = bots.map((b) => ({ b, v: u.byDay[d]?.[b.id]?.cost ?? 0 })).filter((x) => x.v > 0);
    let base = 0;
    segs.forEach((sg, j) => {
      const y0 = y(base), y1 = y(base + sg.v);
      const h = Math.max(0, y0 - y1 - (j > 0 ? 2 : 0)); // 2px gap between stacked segments
      if (h > 0)
        s += j === segs.length - 1
          ? `<path d="${roundedTop(cx - bw / 2, y1, bw, h, 4)}" fill="${botColor(sg.b.id)}"/>`
          : `<rect x="${cx - bw / 2}" y="${y1}" width="${bw}" height="${h}" fill="${botColor(sg.b.id)}"/>`;
      base += sg.v;
    });
    s += `</g>`;
    if (i % every === 0)
      s += `<text x="${cx}" y="${H - 6}" text-anchor="middle">${new Date(`${d}T00:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" })}</text>`;
  });
  el.innerHTML = s + "</svg>";
  el.querySelectorAll(".col").forEach((g) => {
    const i = Number(g.dataset.i);
    g.addEventListener("mousemove", (e) =>
      showTip(e, `<div class="t-head">${days[i]} · ${fmtUSD(totals[i])}</div>${bots
        .map((b) => {
          const st = u.byDay[days[i]]?.[b.id];
          return tipRow(botColor(b.id), botLabel(b.id), `${fmtUSD(st?.cost ?? 0)} · ${st?.requests ?? 0} calls`);
        })
        .join("")}`),
    );
    g.addEventListener("mouseleave", hideTip);
  });
}

// --- Heatmap: calls by weekday x hour, in the viewer's time zone ---
function renderHeat(u) {
  const el = $("#chart-heat");
  const W = widthOf(el), L = 34, T = 4, B = 18, rowH = 22;
  const H = T + rowH * 7 + B;
  if (!u.points.length) return (el.innerHTML = noData(W, H));
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ n: 0, cost: 0 })));
  for (const p of u.points) {
    const d = new Date(p[0]);
    const cell = grid[(d.getDay() + 6) % 7][d.getHours()];
    cell.n += 1;
    cell.cost += p[3];
  }
  const max = Math.max(...grid.flat().map((c) => c.n));
  const cw = (W - L) / 24;
  const level = (n) => (n === 0 ? 0 : Math.min(5, 1 + Math.floor((n / max) * 4.999)));
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Calls by weekday and hour">`;
  grid.forEach((row, r) => {
    s += `<text x="${L - 6}" y="${T + r * rowH + rowH / 2 + 4}" text-anchor="end">${DAYS[r]}</text>`;
    row.forEach((c, h) => {
      s += `<rect class="cell" data-r="${r}" data-h="${h}" x="${L + h * cw + 1}" y="${T + r * rowH + 1}" width="${cw - 2}" height="${rowH - 2}" rx="2" fill="var(--seq-${level(c.n)})"/>`;
    });
  });
  for (let h = 0; h < 24; h += 6) s += `<text x="${L + h * cw}" y="${H - 4}">${String(h).padStart(2, "0")}:00</text>`;
  el.innerHTML = s + "</svg>";
  el.querySelectorAll(".cell").forEach((c) => {
    const r = Number(c.dataset.r), h = Number(c.dataset.h);
    const cell = grid[r][h];
    c.addEventListener("mousemove", (e) =>
      showTip(e, `<div class="t-head">${DAYS[r]} ${String(h).padStart(2, "0")}:00–${String((h + 1) % 24).padStart(2, "0")}:00</div>${tipRow("", "Calls", cell.n)}${tipRow("", "Cost", fmtUSD(cell.cost))}`),
    );
    c.addEventListener("mouseleave", hideTip);
  });
}

// --- Sparkline of one bot's daily cost ---
function sparkline(daily, days, color) {
  const W = 200, H = 32;
  const vals = days.map((d) => daily[d] ?? 0);
  const max = Math.max(...vals);
  if (!max) return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><line x1="0" x2="${W}" y1="${H - 1}" y2="${H - 1}" stroke="var(--border)"/></svg>`;
  const x = (i) => (vals.length === 1 ? W / 2 : (i / (vals.length - 1)) * W);
  const y = (v) => H - 2 - (v / max) * (H - 4);
  const line = vals.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join("");
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${line}L${x(vals.length - 1)},${H}L${x(0)},${H}Z" fill="${color}" fill-opacity=".15"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}

// ======================= Dashboard =======================

function setBotFilter(id) {
  state.botFilter = id;
  store.set("botFilter", id);
  refreshUsage();
}

function renderFilter() {
  const chip = (id, label, color) =>
    `<button type="button" class="chip ${state.botFilter === id ? "on" : ""}" data-bot="${id ?? ""}" role="radio" aria-checked="${state.botFilter === id}">${
      color ? `<span class="dot" style="background:${color}"></span>` : ""
    }${esc(label)}</button>`;
  $("#bot-filter").innerHTML = chip(null, "All bots") + state.config.bots.map((b) => chip(b.id, botLabel(b.id), botColor(b.id))).join("");
}

function renderKpis(u) {
  const t = u.total;
  const kpi = (label, value, cls = "", note = "") =>
    `<div class="kpi"><div class="label">${label}</div><div class="value ${cls}">${value}</div>${note ? `<div class="note">${note}</div>` : ""}</div>`;
  $("#kpis").innerHTML =
    kpi("Total cost", fmtUSD(t.cost)) +
    kpi("Calls", t.requests) +
    kpi("Tokens in", fmtNum(tokensIn(t))) +
    kpi("Tokens out", fmtNum(t.output)) +
    kpi("Group chat", fmtUSD(t.groupCost)) +
    kpi("Private chats", fmtUSD(t.directCost)) +
    kpi("Failed calls", t.errors, t.errors ? "bad" : "") +
    kpi("Avg reply time", fmtSecs(avgLatency(t))) +
    (state.config.accounts.some((a) => a.plan) || state.config.bots.some((b) => b.realAgent)
      ? kpi("Plan runs (no API spend)", t.planCalls, "", `≈ ${fmtUSD(t.apiValue)} at API prices`)
      : "");
}

function renderBotCards(u) {
  const days = dayList(u);
  const all = Object.values(u.byBot).reduce((s, b) => s + b.cost, 0);
  $("#bot-cards").innerHTML = state.config.bots
    .map((b) => {
      const s = u.byBot[b.id] ?? blankStats();
      const c = botColor(b.id);
      const plan = onPlan(b);
      const share = all ? (s.cost / all) * 100 : 0;
      // Plan-covered bots cost nothing per call, so split them by calls instead of dollars.
      const gShare = plan
        ? (s.requests ? (s.groupCalls / s.requests) * 100 : 0)
        : s.cost ? (s.groupCost / s.cost) * 100 : 0;
      const splitHas = plan ? s.requests : s.cost;
      const fmtSplit = (cost, calls) => (plan ? `${calls} calls` : fmtUSD(cost));
      return `<button type="button" class="bot-card ${state.botFilter === b.id ? "on" : ""}" data-bot="${esc(b.id)}"
          aria-pressed="${state.botFilter === b.id}" title="Show only ${esc(botLabel(b.id))} in the charts">
        <span class="top">${avatarHtml(b, botState(b))}<span><span class="nm">${esc(b.name)}</span><br><span class="meta">${esc(accountName(b.account))} · ${esc(b.model)}</span></span></span>
        ${plan
          ? `<span class="cost">Your plan<small>≈ ${fmtUSD(s.apiValue)} at API prices</small></span>
             <span class="share" title="No per-call charge: covered by your Claude subscription"></span>`
          : `<span class="cost">${fmtUSD(s.cost)}<small>${share.toFixed(0)}% of spend</small></span>
             <span class="share"><span style="width:${share}%;background:${c}"></span></span>`}
        ${sparkline(s.daily ?? {}, days, c)}
        <dl>
          <dt>Calls</dt><dd>${s.requests}</dd>
          <dt>Tokens in / out</dt><dd>${fmtNum(tokensIn(s))} / ${fmtNum(s.output)}</dd>
          <dt>Avg reply</dt><dd>${fmtSecs(avgLatency(s))}</dd>
          <dt>Failed</dt><dd class="${s.errors ? "bad" : ""}">${s.errors}</dd>
        </dl>
        <span class="split" title="Group chat ${fmtSplit(s.groupCost, s.groupCalls)} · private chat ${fmtSplit(s.directCost, s.directCalls)}">
          ${splitHas ? `<span style="width:${gShare}%;background:${c}"></span><span style="flex:1;background:${c};opacity:.4"></span>` : ""}
        </span>
        <span class="split-legend"><span>Group ${fmtSplit(s.groupCost, s.groupCalls)}</span><span>Private ${fmtSplit(s.directCost, s.directCalls)}</span></span>
      </button>`;
    })
    .join("");
}

// Bots that appear in old usage data but are no longer in config (e.g. retired ids).
function renderPreviousBots(u) {
  const el = $("#prev-bots");
  const ids = Object.keys(u.byBot ?? {}).filter((id) => !bot(id));
  el.hidden = !ids.length;
  if (!ids.length) return;
  const rows = ids
    .map((id) => {
      const s = u.byBot[id] ?? blankStats();
      const [bid, acct] = id.split("@");
      const label = acct ? `${bot(bid)?.name ?? bid} (earlier, ${accountName(acct)})` : id;
      return `<tr><td>${esc(label)}</td><td class="num">${s.requests}</td><td class="num">${fmtNum(tokensIn(s))} / ${fmtNum(s.output)}</td><td class="num">${fmtUSD(s.cost)}</td></tr>`;
    })
    .join("");
  el.innerHTML = `<h2 class="section">Previous bots</h2><div class="table-wrap"><table><thead><tr><th>Bot (retired id / earlier account)</th><th class="num">Calls</th><th class="num">Tokens in / out</th><th class="num">Cost</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// Subscription usage reports (ingested via POST /api/plan-usage): one donut per account, slices total 100% of the weekly pool.
function renderPlanUsage(u) {
  const html = [["lifteasy", "grok-1"], ["garrett", "grok-2"]]
    .map(([key, acctId]) => {
      const r = reportFor(u.planUsage, key);
      const title = esc(accountName(acctId));
      if (!r) return `<figure class="card plan-card"><figcaption><span class="card-title">${title}</span></figcaption><p class="muted">${EMPTY_PLAN_TEXT}</p></figure>`;
      const { slices } = poolSlices(r);
      const legend = slices
        .map((s, i) => `<li class="${s.leftover ? "leftover muted" : ""}"><span class="dot" style="background:${sliceColor(s, i)}"></span><span class="nm">${esc(s.name)}</span><span class="num">${fmtPoolShare(s.pct)}</span></li>`)
        .join("");
      const extra = [r.onDemand ? esc(r.onDemand) : "", `updated ${esc(fmtReportAgo(r.reportedAt))}`].filter(Boolean).join(" · ");
      return `<figure class="card plan-card">
        <figcaption><span class="card-title">${title}</span><span class="muted">${esc(r.plan ?? "")} · ${fmtPercentUsed(r.percentUsed)} used</span></figcaption>
        <div class="plan-body">${pieSvg(slices)}<ul class="plan-bots">${legend}</ul></div>
        <div class="muted small">${r.resetsAt ? `Resets ${esc(fmtResetEastern(r.resetsAt))}` : "Resets unknown"}</div>
        <div class="muted small">${extra}</div>
      </figure>`;
    })
    .join("");
  $("#plan-usage").innerHTML = html + claudeCard(u.planUsage?.claude);
}

function claudeCard(r) {
  const wins = claudeWindows(r);
  const head = `<figcaption><span class="card-title">Claude</span><button type="button" class="claude-refresh" title="Refresh Claude usage" aria-label="Refresh Claude usage">↻</button></figcaption>`;
  if (!wins.length) return `<figure class="card plan-card claude-card">${head}<p class="muted">${EMPTY_PLAN_TEXT}</p></figure>`;
  const dials = wins
    .map((w) => {
      const when = w.reset ? "Reset" : `Resets ${esc(fmtResetEastern(w.resetsAt))}`;
      const inn = w.key === "five_hour" && !w.reset ? `<div class="muted small">${esc(fmtResetIn(w.resetsAt))}</div>` : "";
      return `<div class="claude-win"><div class="claude-pie">${pieSvg(claudeSlices(w), 84, `${w.label} used`)}<span class="claude-pct">${esc(fmtPercentUsed(w.usedPct))}</span></div><div class="claude-label">${esc(w.label)}</div><div class="muted small">${when}</div>${inn}</div>`;
    })
    .join("");
  return `<figure class="card plan-card claude-card">${head}<div class="claude-wins">${dials}</div><div class="muted small">Updated ${esc(fmtReportAgo(r.updatedAt))}</div></figure>`;
}

document.addEventListener("click", async (e) => {
  const b = e.target.closest?.(".claude-refresh");
  if (!b || b.disabled) return;
  b.disabled = true;
  const msg = b.closest(".usage-detail, .claude-card")?.querySelector(".u-msg");
  if (msg) msg.textContent = "Refreshing…";
  try {
    const res = await fetch("/api/claude-usage/refresh", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (msg) msg.textContent = res.ok ? (data.ok === false ? "Couldn't read Claude usage." : "Updated.") : (data.error ?? "Refresh failed.");
  } catch {
    if (msg) msg.textContent = "Refresh failed.";
  }
  b.disabled = false;
});

function renderAccounts(u) {
  const rows = state.config.accounts
    .map((a) => {
      const s = u.byAccount[a.id] ?? blankStats();
      const bots = state.config.bots.filter((b) => b.account === a.id).map((b) => b.name).join(", ");
      return `<tr><td>${esc(a.name)}</td><td>${esc(bots)}</td><td class="num">${s.requests}</td>
        <td class="num">${fmtNum(tokensIn(s))} / ${fmtNum(s.output)}</td><td class="num">${fmtUSD(s.cost)}</td></tr>`;
    })
    .join("");
  $("#account-table").innerHTML = `<thead><tr><th>Account</th><th>Bots</th><th class="num">Calls</th><th class="num">Tokens in / out</th><th class="num">Cost</th></tr></thead><tbody>${rows}</tbody>`;
}

function renderRecent(u) {
  const rows = u.recent
    .map(
      (r) => `<tr>
        <td>${fmtTime(r.ts)}</td>
        <td><span class="dot" style="background:${botColor(r.bot)}"></span> ${esc(botLabel(r.bot))}</td>
        <td>${isDm(r.room) ? "Private" : "Group"}</td>
        <td>${esc(accountName(r.account))}</td>
        <td>${esc(r.model ?? "")}</td>
        <td class="num">${fmtNum(tokensIn(r))}</td>
        <td class="num">${fmtNum(r.output ?? 0)}</td>
        <td class="num">${r.plan ? `<span title="≈ ${fmtUSD(r.apiValue ?? 0)} at API prices">plan</span>` : fmtUSD(r.cost ?? 0)}</td>
        <td class="num">${fmtSecs(r.latencyMs)}</td>
        <td class="${r.ok ? "" : "err"}">${r.ok ? "ok" : esc(r.error ?? "error")}</td>
      </tr>`,
    )
    .join("");
  $("#recent-table").innerHTML = `<thead><tr><th>Time</th><th>Bot</th><th>Chat</th><th>Account</th><th>Model</th><th class="num">In</th>
    <th class="num">Out</th><th class="num">Cost</th><th class="num">Took</th><th>Status</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="10">No calls in this range yet.</td></tr>`}</tbody>`;
}

function renderDashboard(u) {
  $("#dash-scope").textContent = `· ${state.botFilter ? botLabel(state.botFilter) : "all bots"} · ${rangeLabel()}`;
  document.querySelectorAll("[data-legend=bots]").forEach((el) => {
    el.innerHTML = shownBots()
      .map((b) => `<span><span class="dot" style="background:${botColor(b.id)}"></span>${esc(botLabel(b.id))}</span>`)
      .join("");
  });
  renderFilter();
  renderPlanUsage(u);
  renderKpis(u);
  renderBotCards(u);
  renderPreviousBots(u);
  renderLine(u);
  renderTokenBars(u);
  renderDaily(u);
  renderHeat(u);
  renderAccounts(u);
  renderRecent(u);
}

let usageTimer = null;
async function refreshUsage() {
  clearTimeout(usageTimer);
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const q = new URLSearchParams({ days: state.days, todayStart: String(midnight.getTime()) });
  if (state.botFilter) q.set("bot", state.botFilter);
  try {
    const u = await api(`/api/usage?${q}`);
    state.usage = u;
    renderUsageRow(u);
    renderSidebar();
    if (state.view === "dash") renderDashboard(u);
    renderMeter();
  } catch (e) {
    setStatus(`Couldn't load usage: ${e.message}`);
  }
}
const scheduleUsage = () => {
  clearTimeout(usageTimer);
  usageTimer = setTimeout(refreshUsage, 250);
};

function wireDashboard() {
  const sync = () =>
    document.querySelectorAll(".seg button").forEach((b) => {
      const on = b.dataset.days === state.days;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    });
  sync();
  document.querySelectorAll(".seg button").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.days = btn.dataset.days;
      store.set("days", state.days);
      sync();
      refreshUsage();
    }),
  );
  $("#bot-filter").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (chip) setBotFilter(chip.dataset.bot || null);
  });
  $("#bot-cards").addEventListener("click", (e) => {
    const card = e.target.closest(".bot-card");
    if (card) setBotFilter(state.botFilter === card.dataset.bot ? null : card.dataset.bot);
  });
}

// ======================= Live events =======================

function connectEvents() {
  const es = new EventSource("/api/events");
  es.addEventListener("message", (e) => onMessage(JSON.parse(e.data)));
  es.addEventListener("typing", (e) => {
    const { room, botId, name } = JSON.parse(e.data);
    state.typing.set(room, botId);
    if (room === chatRoom()) {
      $("#typing").textContent = `${name} is typing…`;
      $("#typing").hidden = false;
      scrollChat();
    }
    renderSidebar();
  });
  es.addEventListener("status", (e) => {
    const { running, done, actual } = JSON.parse(e.data);
    state.running = new Set(running);
    if (done && actual && done in state.pendingEstimate) {
      state.lastSend = { room: done, est: state.pendingEstimate[done], actual };
      delete state.pendingEstimate[done];
    }
    if (done) scheduleEstimate(0); // the transcript grew, so the next estimate changes
    if (done) {
      state.typing.delete(done);
      if (done === chatRoom()) $("#typing").hidden = true;
    }
    syncButtons();
    refreshStatusText();
    renderSidebar();
  });
  es.addEventListener("usage", scheduleUsage);
  es.addEventListener("cleared", (e) => {
    const { room } = JSON.parse(e.data);
    state.rooms.set(room, []);
    if (room === chatRoom()) renderChat();
    renderSidebar();
    scheduleEstimate(0);
  });
  es.onerror = () => setStatus("Reconnecting to server…");
  es.onopen = refreshStatusText;
}

// ======================= Boot =======================

(async function boot() {
  const theme = store.get("theme", null);
  if (theme) document.documentElement.dataset.theme = theme;
  state.config = await api("/api/config");
  const saved = store.get("participants", null);
  state.included = new Set((saved ?? state.config.bots.map((b) => b.id)).filter((id) => bot(id)));
  if (state.botFilter && !bot(state.botFilter)) state.botFilter = null;
  $("#mode-badge").hidden = !state.config.mock;

  // Load every room's history once, so sidebar previews are complete.
  for (const m of await api("/api/messages")) {
    if (!state.rooms.has(m.room)) state.rooms.set(m.room, []);
    state.rooms.get(m.room).push(m);
  }
  if (!state.rooms.has("group")) state.rooms.set("group", []);

  wireSidebar();
  wireUsageRow();
  wireChat();
  wireDashboard();
  wireMeter();
  await refreshUsage();
  await setView(state.view);
  connectEvents();

  let rz;
  addEventListener("resize", () => {
    clearTimeout(rz);
    rz = setTimeout(() => state.view === "dash" && state.usage && renderDashboard(state.usage), 150);
  });
  setInterval(refreshUsage, 60_000); // keeps "x min ago" fresh
})().catch((e) => setStatus(`Failed to start: ${e.message}`));

$("#logout-btn")?.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  location.href = "/login";
});
