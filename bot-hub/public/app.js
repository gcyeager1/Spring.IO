// Bot Hub front end: sidebar of bots, group chat, private chats with each bot,
// status strip and a usage dashboard with per-bot breakdowns.
// No build step, no dependencies. Charts are hand-built SVG.

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
};

const isDm = (room) => String(room).startsWith("dm:");
const dmBot = (room) => room.slice(3);
const chatRoom = () => (state.view === "dash" ? null : state.view);

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
const blankStats = () => ({ requests: 0, errors: 0, input: 0, cachedInput: 0, cacheWrite: 0, output: 0, cost: 0, latencyN: 0, latencySum: 0, groupCost: 0, directCost: 0, groupCalls: 0, directCalls: 0, daily: {} });
const tokensIn = (s) => (s.input ?? 0) + (s.cachedInput ?? 0) + (s.cacheWrite ?? 0);
const avgLatency = (s) => (s.latencyN ? s.latencySum / s.latencyN : 0);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}
const setStatus = (text) => ($("#status").textContent = text);
function refreshStatusText() {
  if (!state.running.size) return setStatus("Idle");
  const names = [...state.running].map((r) => (isDm(r) ? botName(dmBot(r)) : "Group"));
  setStatus(`Replying: ${names.join(", ")}…`);
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
  if (!state.config.mock && !account(b.account).hasKey) return "bad";
  const last = state.usage?.lastByBot?.[b.id];
  if (last && !last.ok) return "bad";
  return "on";
}

function lastMessageFrom(b) {
  let last = null;
  for (const msgs of state.rooms.values()) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].speaker === b.name) {
        if (!last || msgs[i].ts > last.ts) last = msgs[i];
        break;
      }
    }
  }
  return last;
}

const unreadBadge = (room) => (state.unread[room] ? `<span class="unread">${state.unread[room]}</span>` : "");

function renderSidebar() {
  $("#bot-list").innerHTML = state.config.bots
    .map((b) => {
      const last = lastMessageFrom(b);
      const inGroup = state.included.has(b.id);
      const active = state.view === `dm:${b.id}`;
      return `<li class="bot ${active ? "active" : ""} ${inGroup ? "" : "off"}" data-id="${esc(b.id)}" tabindex="0"
          title="Chat privately with ${esc(b.name)} (${esc(b.model)} on ${esc(accountName(b.account))})">
        <input type="checkbox" class="bot-check" data-id="${esc(b.id)}" ${inGroup ? "checked" : ""}
          aria-label="Include ${esc(b.name)} in the group chat" title="Include in the group chat" />
        ${avatarHtml(b, botState(b))}
        <span class="bot-text">
          <span class="bot-name">${esc(b.name)}${unreadBadge(`dm:${b.id}`)}<small>${last ? fmtTime(last.ts) : ""}</small></span>
          <span class="bot-role">${esc(accountName(b.account))} · ${esc(b.model)}</span>
          <span class="bot-preview">${esc(last ? last.text : "No messages yet")}</span>
        </span>
      </li>`;
    })
    .join("");
  const g = document.querySelector('[data-unread="group"]');
  g.hidden = !state.unread.group;
  g.textContent = state.unread.group ?? "";
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.toggle("on", n.dataset.view === state.view));
}

function wireSidebar() {
  $("#bot-list").addEventListener("change", (e) => {
    const cb = e.target.closest(".bot-check");
    if (!cb) return;
    cb.checked ? state.included.add(cb.dataset.id) : state.included.delete(cb.dataset.id);
    store.set("participants", [...state.included]);
    renderSidebar();
    if (state.view === "group") renderChatHeader();
  });
  $("#bot-list").addEventListener("click", (e) => {
    if (e.target.closest(".bot-check")) return;
    const li = e.target.closest(".bot");
    if (li) setView(`dm:${li.dataset.id}`);
  });
  $("#bot-list").addEventListener("keydown", (e) => {
    const li = e.target.closest(".bot");
    if (li && e.target === li && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      setView(`dm:${li.dataset.id}`);
    }
  });
  document.querySelectorAll(".nav-item").forEach((btn) => btn.addEventListener("click", () => setView(btn.dataset.view)));
  $("#theme-btn").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    store.set("theme", next);
  });
}

async function setView(view) {
  if (isDm(view) && !bot(dmBot(view))) view = "group";
  state.view = view;
  store.set("view2", view);
  const chat = view !== "dash";
  $("#view-chat").hidden = !chat;
  $("#view-dash").hidden = chat;
  if (chat) {
    delete state.unread[view];
    if (!state.rooms.has(view)) state.rooms.set(view, await api(`/api/messages?room=${encodeURIComponent(view)}`));
    renderChat();
  } else if (state.usage) {
    renderDashboard(state.usage);
  }
  renderSidebar();
}

// ======================= Status strip =======================

function renderStatus(u) {
  $("#pills").innerHTML = state.config.accounts
    .map((a) => {
      const last = u.lastByAccount[a.id];
      let cls = "idle";
      let info = "ready";
      if (!state.config.mock && !a.hasKey) {
        cls = "bad";
        info = "no API key";
      } else if (last && !last.ok) {
        cls = "bad";
        info = `last call failed · ${fmtAgo(last.ts)}`;
      } else if (last) {
        cls = "good";
        info = `ok · ${fmtAgo(last.ts)}`;
      }
      return `<span class="pill ${cls}" title="${esc(last?.error ?? "")}"><span class="dot"></span>${esc(a.name)} <span class="muted">${esc(info)}</span></span>`;
    })
    .join("");
  $("#today").innerHTML = `Today <strong>${fmtUSD(u.today.cost)}</strong> · ${u.today.calls} calls`;
}

// ======================= Chat (group or private) =======================

function messageHtml(m) {
  const you = m.speaker === "You";
  const b = m.botId ? bot(m.botId) : state.config.bots.find((x) => x.name === m.speaker);
  const note = m.note ? ` <span class="note">· ${esc(m.note)}</span>` : "";
  const av = you ? "" : b ? avatarHtml(b) : `<span class="avatar" style="background:var(--series-other)">!</span>`;
  return `<li class="msg ${you ? "you" : ""} ${m.error ? "err" : ""}">${av}<div class="bubble">
    <div class="who">${esc(m.speaker)}<time datetime="${new Date(m.ts).toISOString()}">${fmtTime(m.ts)}</time>${note}</div><div class="body">${esc(m.text)}</div></div></li>`;
}

function scrollChat() {
  const v = $("#view-chat");
  v.scrollTop = v.scrollHeight;
}

function renderChatStats() {
  const room = chatRoom();
  const el = $("#chat-stats");
  if (!room || !isDm(room) || !state.usage) {
    el.hidden = true;
    return;
  }
  const s = state.usage.byBot[dmBot(room)] ?? blankStats();
  el.hidden = false;
  el.innerHTML = `<span>Cost <strong>${fmtUSD(s.cost)}</strong></span>
    <span>Calls <strong>${s.requests}</strong></span>
    <span>Tokens <strong>${fmtNum(tokensIn(s))} in / ${fmtNum(s.output)} out</strong></span>
    <span>Avg reply <strong>${fmtSecs(avgLatency(s))}</strong></span>
    <span>Private chat <strong>${fmtUSD(s.directCost)}</strong> · group <strong>${fmtUSD(s.groupCost)}</strong></span>
    <span>${esc(rangeLabel())}</span>`;
}

function renderChatHeader() {
  const room = chatRoom();
  if (isDm(room)) {
    const b = bot(dmBot(room));
    $("#chat-avatar").innerHTML = avatarHtml(b);
    $("#chat-name").textContent = b.name;
    $("#chat-sub").textContent = `Private chat · ${b.model} on ${accountName(b.account)}`;
    $("#input").placeholder = `Message ${b.name}… (Enter to send, Shift+Enter for a new line)`;
  } else {
    $("#chat-avatar").innerHTML = "";
    $("#chat-name").textContent = "Group chat";
    const names = state.config.bots.filter((b) => state.included.has(b.id)).map((b) => b.name);
    $("#chat-sub").textContent = names.length ? names.join(", ") : "No bots selected - tick some in the sidebar";
    $("#input").placeholder = "Message the group… (Enter to send, Shift+Enter for a new line)";
  }
  $("#chat-usage-btn").hidden = !isDm(room);
  document.querySelectorAll(".group-only").forEach((el) => (el.hidden = isDm(room)));
  renderChatStats();
  syncButtons();
}

function renderChat() {
  const room = chatRoom();
  renderChatHeader();
  const list = state.rooms.get(room) ?? [];
  const empty = isDm(room)
    ? `Start a private conversation with ${esc(botName(dmBot(room)))}.`
    : "Tick bots in the sidebar, then say something. They'll take turns replying.";
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
}

async function send(text) {
  const room = chatRoom() ?? "group";
  const participants = state.config.bots.filter((b) => state.included.has(b.id)).map((b) => b.id);
  if (room === "group" && !participants.length) return setStatus("Tick at least one bot in the sidebar for the group chat.");
  try {
    await api("/api/messages", { method: "POST", body: { room, text, participants, rounds: Number($("#rounds").value) || 1 } });
    $("#input").value = "";
    autosize();
    if (state.view === "dash") setView(room);
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
  $("#continue-btn").addEventListener("click", () => send(""));
  $("#stop-btn").addEventListener("click", () => {
    api("/api/stop", { method: "POST", body: {} });
    setStatus("Pausing after the current replies…");
  });
  $("#clear-btn").addEventListener("click", async () => {
    const room = chatRoom();
    const label = isDm(room) ? `your private chat with ${botName(dmBot(room))}` : "the group chat";
    if (!confirm(`Clear ${label}? Usage stats are kept.`)) return;
    try {
      await api(`/api/messages?room=${encodeURIComponent(room)}`, { method: "DELETE" });
    } catch (e) {
      setStatus(e.message);
    }
  });
  $("#chat-usage-btn").addEventListener("click", () => {
    setBotFilter(dmBot(chatRoom()));
    setView("dash");
  });
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
        return tipRow(botColor(sr.b.id), sr.b.name, fmtUSD(v));
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
      showTip(e, `<div class="t-head">${esc(g.b.name)}</div>${tipRow("", "Tokens in", fmtNum(g.tin))}${tipRow("", "Tokens out", fmtNum(g.tout))}`),
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
          return tipRow(botColor(b.id), b.name, `${fmtUSD(st?.cost ?? 0)} · ${st?.requests ?? 0} calls`);
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
  $("#bot-filter").innerHTML = chip(null, "All bots") + state.config.bots.map((b) => chip(b.id, b.name, botColor(b.id))).join("");
}

function renderKpis(u) {
  const t = u.total;
  const kpi = (label, value, cls = "") => `<div class="kpi"><div class="label">${label}</div><div class="value ${cls}">${value}</div></div>`;
  $("#kpis").innerHTML =
    kpi("Total cost", fmtUSD(t.cost)) +
    kpi("Calls", t.requests) +
    kpi("Tokens in", fmtNum(tokensIn(t))) +
    kpi("Tokens out", fmtNum(t.output)) +
    kpi("Group chat", fmtUSD(t.groupCost)) +
    kpi("Private chats", fmtUSD(t.directCost)) +
    kpi("Failed calls", t.errors, t.errors ? "bad" : "") +
    kpi("Avg reply time", fmtSecs(avgLatency(t)));
}

function renderBotCards(u) {
  const days = dayList(u);
  const all = Object.values(u.byBot).reduce((s, b) => s + b.cost, 0);
  $("#bot-cards").innerHTML = state.config.bots
    .map((b) => {
      const s = u.byBot[b.id] ?? blankStats();
      const c = botColor(b.id);
      const share = all ? (s.cost / all) * 100 : 0;
      const gShare = s.cost ? (s.groupCost / s.cost) * 100 : 0;
      return `<button type="button" class="bot-card ${state.botFilter === b.id ? "on" : ""}" data-bot="${esc(b.id)}"
          aria-pressed="${state.botFilter === b.id}" title="Show only ${esc(b.name)} in the charts">
        <span class="top">${avatarHtml(b, botState(b))}<span><span class="nm">${esc(b.name)}</span><br><span class="meta">${esc(accountName(b.account))} · ${esc(b.model)}</span></span></span>
        <span class="cost">${fmtUSD(s.cost)}<small>${share.toFixed(0)}% of spend</small></span>
        <span class="share"><span style="width:${share}%;background:${c}"></span></span>
        ${sparkline(s.daily ?? {}, days, c)}
        <dl>
          <dt>Calls</dt><dd>${s.requests}</dd>
          <dt>Tokens in / out</dt><dd>${fmtNum(tokensIn(s))} / ${fmtNum(s.output)}</dd>
          <dt>Avg reply</dt><dd>${fmtSecs(avgLatency(s))}</dd>
          <dt>Failed</dt><dd class="${s.errors ? "bad" : ""}">${s.errors}</dd>
        </dl>
        <span class="split" title="Group chat ${fmtUSD(s.groupCost)} · private chat ${fmtUSD(s.directCost)}">
          ${s.cost ? `<span style="width:${gShare}%;background:${c}"></span><span style="flex:1;background:${c};opacity:.4"></span>` : ""}
        </span>
        <span class="split-legend"><span>Group ${fmtUSD(s.groupCost)}</span><span>Private ${fmtUSD(s.directCost)}</span></span>
      </button>`;
    })
    .join("");
}

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
        <td><span class="dot" style="background:${botColor(r.bot)}"></span> ${esc(botName(r.bot))}</td>
        <td>${isDm(r.room) ? "Private" : "Group"}</td>
        <td>${esc(accountName(r.account))}</td>
        <td>${esc(r.model ?? "")}</td>
        <td class="num">${fmtNum(tokensIn(r))}</td>
        <td class="num">${fmtNum(r.output ?? 0)}</td>
        <td class="num">${fmtUSD(r.cost ?? 0)}</td>
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
  $("#dash-scope").textContent = `· ${state.botFilter ? botName(state.botFilter) : "all bots"} · ${rangeLabel()}`;
  document.querySelectorAll("[data-legend=bots]").forEach((el) => {
    el.innerHTML = shownBots()
      .map((b) => `<span><span class="dot" style="background:${botColor(b.id)}"></span>${esc(b.name)}</span>`)
      .join("");
  });
  renderFilter();
  renderKpis(u);
  renderBotCards(u);
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
    renderStatus(u);
    renderSidebar();
    if (state.view === "dash") renderDashboard(u);
    else renderChatStats();
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
    const { running, done } = JSON.parse(e.data);
    state.running = new Set(running);
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
  wireChat();
  wireDashboard();
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
