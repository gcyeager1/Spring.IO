// Bot Hub front end: sidebar of bots, group chat, status strip and usage dashboard.
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
  view: store.get("view", "chat"),
  running: false,
  typingBot: null,
  included: null, // Set of bot ids taking part
  lastByBot: {}, // botId -> last message
  usage: null,
};

// ---------- formatting ----------
const fmtUSD = (n) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : n === 0 ? "$0" : `$${n.toFixed(4)}`);
const fmtAxisUSD = (n) => (n === 0 ? "$0" : n >= 1 ? `$${+n.toFixed(2)}` : `$${+n.toPrecision(2)}`);
const fmtNum = (n) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(0)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n));
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmtAgo = (ts) => {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

// ---------- identity colors: follow the account (config order), never rank ----------
const accountIndex = (id) => state.config.accounts.findIndex((a) => a.id === id);
const accountColor = (id) => {
  const i = accountIndex(id);
  return i >= 0 && i < 8 ? `var(--series-${i + 1})` : "var(--series-other)";
};
const account = (id) => state.config.accounts.find((a) => a.id === id);
const accountName = (id) => account(id)?.name ?? id;
const bot = (id) => state.config.bots.find((b) => b.id === id);
const botName = (id) => bot(id)?.name ?? id;

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

function avatarHtml(b, stateClass = "") {
  const initial = esc((b?.name ?? "?").trim()[0]?.toUpperCase() ?? "?");
  return `<span class="avatar" style="background:${accountColor(b.account)}">${initial}${
    stateClass !== null ? `<span class="state ${stateClass}"></span>` : ""
  }</span>`;
}

function botState(b) {
  if (state.typingBot === b.id) return "busy";
  const acct = account(b.account);
  if (!state.config.mock && !acct.hasKey) return "bad";
  const last = state.lastByBot[b.id];
  if (last?.error) return "bad";
  return state.included.has(b.id) ? "on" : "";
}

function renderSidebar() {
  $("#bot-list").innerHTML = state.config.bots
    .map((b) => {
      const last = state.lastByBot[b.id];
      const preview = last ? last.text : "No messages yet";
      const on = state.included.has(b.id);
      return `<li class="bot ${on ? "" : "off"}" data-id="${esc(b.id)}" role="checkbox" aria-checked="${on}" tabindex="0"
        title="${esc(b.model)} on ${esc(accountName(b.account))}${on ? "" : " (not in this chat)"}">
        ${avatarHtml(b, botState(b))}
        <span class="bot-text">
          <span class="bot-name">${esc(b.name)}<small>${last ? fmtTime(last.ts) : ""}</small></span>
          <span class="bot-role">${esc(accountName(b.account))} · ${esc(b.model)}</span>
          <span class="bot-preview">${esc(preview)}</span>
        </span>
      </li>`;
    })
    .join("");
  const names = state.config.bots.filter((b) => state.included.has(b.id)).map((b) => b.name);
  $("#who").textContent = names.length ? `· ${names.join(", ")}` : "· nobody selected";
}

function wireSidebar() {
  const toggle = (li) => {
    const id = li.dataset.id;
    state.included.has(id) ? state.included.delete(id) : state.included.add(id);
    store.set("participants", [...state.included]);
    renderSidebar();
  };
  $("#bot-list").addEventListener("click", (e) => {
    const li = e.target.closest(".bot");
    if (li) toggle(li);
  });
  $("#bot-list").addEventListener("keydown", (e) => {
    const li = e.target.closest(".bot");
    if (li && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      toggle(li);
    }
  });

  document.querySelectorAll(".nav-item").forEach((btn) =>
    btn.addEventListener("click", () => setView(btn.dataset.view)),
  );

  $("#theme-btn").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    store.set("theme", next);
  });
}

function setView(view) {
  state.view = view;
  store.set("view", view);
  $("#view-chat").hidden = view !== "chat";
  $("#view-dash").hidden = view !== "dash";
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  if (view === "dash" && state.usage) renderDashboard(state.usage);
  if (view === "chat") scrollChat();
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

  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  let cost = 0;
  let calls = 0;
  for (const p of u.points) {
    if (p[0] >= midnight.getTime()) {
      cost += p[3];
      calls += 1;
    }
  }
  $("#today").innerHTML = `Today <strong>${fmtUSD(cost)}</strong> · ${calls} calls`;
}

// ======================= Chat =======================

function messageHtml(m) {
  const you = m.speaker === "You";
  const b = m.botId ? bot(m.botId) : state.config.bots.find((x) => x.name === m.speaker);
  const note = m.note ? ` <span class="note">· ${esc(m.note)}</span>` : "";
  const av = you ? "" : b ? avatarHtml(b, null) : `<span class="avatar" style="background:var(--series-other)">!</span>`;
  return `<li class="msg ${you ? "you" : ""} ${m.error ? "err" : ""}">${av}<div class="bubble">
    <div class="who">${esc(m.speaker)}<time datetime="${new Date(m.ts).toISOString()}">${fmtTime(m.ts)}</time>${note}</div><div class="body">${esc(m.text)}</div></div></li>`;
}

function scrollChat() {
  const v = $("#view-chat");
  v.scrollTop = v.scrollHeight;
}

function rememberMessage(m) {
  const b = m.botId ? bot(m.botId) : state.config.bots.find((x) => x.name === m.speaker);
  if (b) state.lastByBot[b.id] = m;
}

function renderMessages(list) {
  state.lastByBot = {};
  list.forEach(rememberMessage);
  $("#messages").innerHTML = list.length
    ? list.map(messageHtml).join("")
    : `<li class="empty">Pick bots in the sidebar, then say something. They'll take turns replying.</li>`;
  renderSidebar();
  scrollChat();
}

function appendMessage(m) {
  $("#messages .empty")?.remove();
  $("#messages").insertAdjacentHTML("beforeend", messageHtml(m));
  rememberMessage(m);
  if (state.typingBot && bot(state.typingBot)?.name === m.speaker) state.typingBot = null;
  renderSidebar();
  scrollChat();
}

function setRunning(running) {
  state.running = running;
  $("#stop-btn").disabled = !running;
  $("#send-btn").disabled = running;
  $("#continue-btn").disabled = running;
  $("#clear-btn").disabled = running;
  if (!running) {
    $("#typing").hidden = true;
    state.typingBot = null;
    renderSidebar();
  }
  setStatus(running ? "Bots are talking…" : "Idle");
}

async function send(text) {
  const participants = state.config.bots.filter((b) => state.included.has(b.id)).map((b) => b.id);
  if (!participants.length) return setStatus("Pick at least one bot in the sidebar.");
  try {
    await api("/api/messages", { method: "POST", body: { text, participants, rounds: Number($("#rounds").value) || 1 } });
    $("#input").value = "";
    autosize();
    if (state.view !== "chat" && text) setView("chat");
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
    api("/api/stop", { method: "POST" });
    setStatus("Pausing after the current reply…");
  });
  $("#clear-btn").addEventListener("click", async () => {
    if (!confirm("Clear the whole chat history? Usage stats are kept.")) return;
    try {
      await api("/api/messages", { method: "DELETE" });
    } catch (e) {
      setStatus(e.message);
    }
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
function roundedRight(x, y, w, h, r) {
  r = Math.min(r, h / 2, w);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}
const svgPoint = (svg, e, W, H) => {
  const r = svg.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
};
const widthOf = (el) => Math.max(280, Math.round(el.clientWidth || 380));
const noData = (W, H, msg = "No calls in this range yet") =>
  `<svg viewBox="0 0 ${W} ${H}"><text class="nodata" x="${W / 2}" y="${H / 2}" text-anchor="middle">${msg}</text></svg>`;

function rangeStart(u) {
  if (state.days !== "all") return u.since;
  return u.points.length ? Math.min(u.points[0][0], u.now - 86_400_000) : u.now - 86_400_000;
}

// --- Cumulative cost line chart, crosshair tooltip, direct end labels ---
function renderLine(u) {
  const el = $("#chart-line");
  const W = widthOf(el), H = 240, L = 52, R = 130, T = 12, B = 24;
  const accounts = state.config.accounts;
  if (!u.points.length) return (el.innerHTML = noData(W, H));
  const t0 = rangeStart(u), t1 = u.now;
  const series = accounts.map((a) => {
    let cum = 0;
    const pts = [[t0, 0]];
    for (const p of u.points) if (p[1] === a.id) pts.push([p[0], (cum += p[3])]);
    return { a, pts, total: cum };
  });
  const max = niceMax(Math.max(...series.map((s) => s.total)));
  const x = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v) => T + (H - T - B) - (v / max) * (H - T - B);

  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative cost by account">`;
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    s += `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${fmtAxisUSD(v)}</text>`;
  }
  const span = t1 - t0;
  for (let i = 0; i <= 4; i++) {
    const t = t0 + (span / 4) * i;
    const lab = span <= 2 * 86_400_000
      ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
    s += `<text x="${x(t)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === 4 ? "end" : "middle"}">${lab}</text>`;
  }
  // Step lines: cost jumps at each call.
  for (const sr of series) {
    let d = `M${x(sr.pts[0][0])},${y(0)}`;
    for (let i = 1; i < sr.pts.length; i++) d += `H${x(sr.pts[i][0])}V${y(sr.pts[i][1])}`;
    d += `H${x(t1)}`;
    s += `<path d="${d}" fill="none" stroke="${accountColor(sr.a.id)}" stroke-width="2" stroke-linejoin="round"/>`;
  }
  // Direct labels at the line ends, nudged apart so they don't collide.
  const labels = series.map((sr) => ({ sr, y: y(sr.total) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 13);
  for (const l of labels) {
    s += `<text x="${W - R + 6}" y="${l.y + 4}" class="val">${esc(l.sr.a.name)} <tspan fill="var(--text-2)">${fmtUSD(l.sr.total)}</tspan></text>`;
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
        return tipRow(accountColor(sr.a.id), sr.a.name, fmtUSD(v));
      })
      .join("");
    showTip(e, `<div class="t-head">${new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>${rows}`);
  });
  area.addEventListener("mouseleave", () => {
    cross.setAttribute("visibility", "hidden");
    hideTip();
  });
}

// --- Horizontal bars: cost per bot, colored by the bot's account ---
function renderBotBars(u) {
  const el = $("#chart-bots");
  const rows = state.config.bots.map((b) => ({ b, s: u.byBot[b.id] })).sort((a, b) => b.s.cost - a.s.cost);
  const W = widthOf(el), L = 70, R = 64, rowH = 28, T = 4;
  const H = T + rows.length * rowH + 4;
  if (!u.total.requests) return (el.innerHTML = noData(W, Math.max(H, 120)));
  const max = Math.max(...rows.map((r) => r.s.cost), 1e-9);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cost by bot">`;
  rows.forEach(({ b, s: st }, i) => {
    const y0 = T + i * rowH;
    const w = (st.cost / max) * (W - L - R);
    s += `<g class="row" data-i="${i}"><rect class="hit" x="0" y="${y0}" width="${W}" height="${rowH}" rx="4"/>`;
    s += `<text x="${L - 8}" y="${y0 + rowH / 2 + 4}" text-anchor="end">${esc(b.name)}</text>`;
    if (w > 0.5) s += `<path d="${roundedRight(L, y0 + 8, Math.max(w, 2), rowH - 16, 4)}" fill="${accountColor(b.account)}"/>`;
    s += `<text class="val" x="${L + Math.max(w, 0) + 6}" y="${y0 + rowH / 2 + 4}">${fmtUSD(st.cost)}</text></g>`;
  });
  el.innerHTML = s + "</svg>";
  el.querySelectorAll(".row").forEach((g) => {
    const { b, s: st } = rows[Number(g.dataset.i)];
    g.addEventListener("mousemove", (e) =>
      showTip(e, `<div class="t-head">${esc(b.name)}</div>${tipRow(accountColor(b.account), accountName(b.account), esc(b.model))}
        ${tipRow("", "Cost", fmtUSD(st.cost))}${tipRow("", "Calls", st.requests)}
        ${tipRow("", "Tokens in / out", `${fmtNum(st.input + st.cachedInput + st.cacheWrite)} / ${fmtNum(st.output)}`)}`),
    );
    g.addEventListener("mouseleave", hideTip);
  });
}

// --- Grouped bars: tokens in vs out per account ---
const TOKEN_COLORS = { in: "var(--series-7)", out: "var(--series-5)" };
function renderTokenBars(u) {
  const el = $("#chart-tokens");
  $("#legend-tokens").innerHTML = `<span><span class="dot" style="background:${TOKEN_COLORS.in}"></span>In</span><span><span class="dot" style="background:${TOKEN_COLORS.out}"></span>Out</span>`;
  const W = widthOf(el), H = 200, L = 44, R = 6, T = 10, B = 24;
  if (!u.total.requests) return (el.innerHTML = noData(W, H));
  const groups = state.config.accounts.map((a) => {
    const s = u.byAccount[a.id];
    return { a, tin: s.input + s.cachedInput + s.cacheWrite, tout: s.output };
  });
  const max = niceMax(Math.max(...groups.map((g) => Math.max(g.tin, g.tout))));
  const y = (v) => T + (H - T - B) - (v / max) * (H - T - B);
  const step = (W - L - R) / groups.length;
  const bw = Math.min(26, step * 0.3);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Tokens in and out by account">`;
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    s += `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${fmtNum(v)}</text>`;
  }
  groups.forEach((g, i) => {
    const cx = L + step * i + step / 2;
    s += `<g class="col" data-i="${i}"><rect class="hit" x="${L + step * i}" y="${T}" width="${step}" height="${H - T - B}"/>`;
    const hin = y(0) - y(g.tin), hout = y(0) - y(g.tout);
    if (hin > 0) s += `<path d="${roundedTop(cx - bw - 1, y(g.tin), bw, hin, 4)}" fill="${TOKEN_COLORS.in}"/>`;
    if (hout > 0) s += `<path d="${roundedTop(cx + 1, y(g.tout), bw, hout, 4)}" fill="${TOKEN_COLORS.out}"/>`;
    s += `</g><text x="${cx}" y="${H - 6}" text-anchor="middle">${esc(g.a.name.length > 16 ? g.a.name.slice(0, 15) + "…" : g.a.name)}</text>`;
  });
  el.innerHTML = s + "</svg>";
  el.querySelectorAll(".col").forEach((gEl) => {
    const g = groups[Number(gEl.dataset.i)];
    gEl.addEventListener("mousemove", (e) =>
      showTip(e, `<div class="t-head">${esc(g.a.name)}</div>${tipRow(TOKEN_COLORS.in, "Tokens in", fmtNum(g.tin))}${tipRow(TOKEN_COLORS.out, "Tokens out", fmtNum(g.tout))}`),
    );
    gEl.addEventListener("mouseleave", hideTip);
  });
}

// --- Stacked daily cost by account ---
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

function renderDaily(u) {
  const el = $("#chart-daily");
  const accounts = state.config.accounts;
  const days = dayList(u);
  const W = widthOf(el), H = 200, L = 48, R = 6, T = 10, B = 24;
  if (!u.total.requests) return (el.innerHTML = noData(W, H));
  const totals = days.map((d) => accounts.reduce((s, a) => s + (u.byDay[d]?.[a.id]?.cost ?? 0), 0));
  const max = niceMax(Math.max(...totals));
  const y = (v) => T + (H - T - B) - (v / max) * (H - T - B);
  const step = (W - L - R) / days.length;
  const bw = Math.max(3, Math.min(28, step * 0.6));
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily cost by account">`;
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    s += `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${fmtAxisUSD(v)}</text>`;
  }
  const every = Math.ceil(days.length / 6);
  days.forEach((d, i) => {
    const cx = L + step * i + step / 2;
    s += `<g class="col" data-i="${i}"><rect class="hit" x="${L + step * i}" y="${T}" width="${step}" height="${H - T - B}"/>`;
    const segs = accounts.map((a) => ({ a, v: u.byDay[d]?.[a.id]?.cost ?? 0 })).filter((x) => x.v > 0);
    let base = 0;
    segs.forEach((sg, j) => {
      const y0 = y(base), y1 = y(base + sg.v);
      const h = Math.max(0, y0 - y1 - (j > 0 ? 2 : 0)); // 2px gap between stacked segments
      if (h > 0)
        s += j === segs.length - 1
          ? `<path d="${roundedTop(cx - bw / 2, y1, bw, h, 4)}" fill="${accountColor(sg.a.id)}"/>`
          : `<rect x="${cx - bw / 2}" y="${y1}" width="${bw}" height="${h}" fill="${accountColor(sg.a.id)}"/>`;
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
      showTip(e, `<div class="t-head">${days[i]} · ${fmtUSD(totals[i])}</div>${accounts
        .map((a) => {
          const st = u.byDay[days[i]]?.[a.id];
          return tipRow(accountColor(a.id), a.name, `${fmtUSD(st?.cost ?? 0)} · ${st?.requests ?? 0} calls`);
        })
        .join("")}`),
    );
    g.addEventListener("mouseleave", hideTip);
  });
}

// --- Heatmap: calls by weekday x hour, in the viewer's time zone ---
function renderHeat(u) {
  const el = $("#chart-heat");
  const W = widthOf(el), L = 34, T = 4, B = 18, rowH = 20;
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

// ======================= Dashboard =======================

function renderKpis(u) {
  const t = u.total;
  const kpi = (label, value, cls = "") => `<div class="kpi"><div class="label">${label}</div><div class="value ${cls}">${value}</div></div>`;
  $("#kpis").innerHTML =
    kpi("Total cost", fmtUSD(t.cost)) +
    kpi("Calls", t.requests) +
    kpi("Tokens in", fmtNum(t.input + t.cachedInput + t.cacheWrite)) +
    kpi("Tokens out", fmtNum(t.output)) +
    kpi("Failed calls", t.errors, t.errors ? "bad" : "") +
    kpi("Avg reply time", t.avgLatencyMs ? `${(t.avgLatencyMs / 1000).toFixed(1)}s` : "–");
}

function renderRecent(u) {
  const rows = u.recent
    .map(
      (r) => `<tr>
        <td>${fmtTime(r.ts)}</td>
        <td><span class="dot" style="background:${accountColor(r.account)}"></span> ${esc(botName(r.bot))}</td>
        <td>${esc(accountName(r.account))}</td>
        <td>${esc(r.model ?? "")}</td>
        <td class="num">${fmtNum((r.input ?? 0) + (r.cachedInput ?? 0) + (r.cacheWrite ?? 0))}</td>
        <td class="num">${fmtNum(r.output ?? 0)}</td>
        <td class="num">${fmtUSD(r.cost ?? 0)}</td>
        <td class="num">${((r.latencyMs ?? 0) / 1000).toFixed(1)}s</td>
        <td class="${r.ok ? "" : "err"}">${r.ok ? "ok" : esc(r.error ?? "error")}</td>
      </tr>`,
    )
    .join("");
  $("#recent-table").innerHTML = `<thead><tr><th>Time</th><th>Bot</th><th>Account</th><th>Model</th><th class="num">In</th>
    <th class="num">Out</th><th class="num">Cost</th><th class="num">Took</th><th>Status</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="9">No calls in this range yet.</td></tr>`}</tbody>`;
}

function renderDashboard(u) {
  document.querySelectorAll("[data-legend=accounts]").forEach((el) => {
    el.innerHTML = state.config.accounts
      .map((a) => `<span><span class="dot" style="background:${accountColor(a.id)}"></span>${esc(a.name)}</span>`)
      .join("");
  });
  renderKpis(u);
  renderLine(u);
  renderBotBars(u);
  renderTokenBars(u);
  renderDaily(u);
  renderHeat(u);
  renderRecent(u);
}

let usageTimer = null;
async function refreshUsage() {
  clearTimeout(usageTimer);
  try {
    const u = await api(`/api/usage?days=${state.days}`);
    state.usage = u;
    renderStatus(u);
    if (state.view === "dash") renderDashboard(u);
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
}

// ======================= Live events =======================

function connectEvents() {
  const es = new EventSource("/api/events");
  es.addEventListener("message", (e) => appendMessage(JSON.parse(e.data)));
  es.addEventListener("typing", (e) => {
    const { botId, name } = JSON.parse(e.data);
    state.typingBot = botId;
    $("#typing").textContent = `${name} is typing…`;
    $("#typing").hidden = false;
    renderSidebar();
    scrollChat();
  });
  es.addEventListener("status", (e) => setRunning(JSON.parse(e.data).running));
  es.addEventListener("usage", scheduleUsage);
  es.addEventListener("cleared", () => renderMessages([]));
  es.onerror = () => setStatus("Reconnecting to server…");
}

// ======================= Boot =======================

(async function boot() {
  const theme = store.get("theme", null);
  if (theme) document.documentElement.dataset.theme = theme;
  state.config = await api("/api/config");
  const saved = store.get("participants", null);
  state.included = new Set(saved ?? state.config.bots.map((b) => b.id));
  $("#mode-badge").hidden = !state.config.mock;
  wireSidebar();
  wireChat();
  wireDashboard();
  renderMessages(await api("/api/messages"));
  setView(state.view);
  await refreshUsage();
  connectEvents();
  let rz;
  addEventListener("resize", () => {
    clearTimeout(rz);
    rz = setTimeout(() => state.view === "dash" && state.usage && renderDashboard(state.usage), 150);
  });
  setInterval(refreshUsage, 60_000); // keeps "x min ago" fresh
})().catch((e) => setStatus(`Failed to start: ${e.message}`));
