// Bot Hub front end: group chat + usage dashboard. No build step, no dependencies.

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const state = { config: null, days: "7", running: false };

// Account colors follow the account (config order), never rank, so they stay stable.
const accountColor = (id) => {
  const i = state.config.accounts.findIndex((a) => a.id === id);
  return i >= 0 && i < 8 ? `var(--series-${i + 1})` : "var(--series-other)";
};
const accountName = (id) => state.config.accounts.find((a) => a.id === id)?.name ?? id;

const fmtUSD = (n) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);
const fmtNum = (n) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(0)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

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

function setStatus(text) {
  $("#status").textContent = text;
}

// ======================= Chat =======================

function renderBots() {
  const saved = (() => {
    try {
      return JSON.parse(localStorage.getItem("bothub.participants") ?? "null");
    } catch {
      return null;
    }
  })();
  $("#bot-list").innerHTML = state.config.bots
    .map((b) => {
      const acct = state.config.accounts.find((a) => a.id === b.account);
      const checked = saved ? saved.includes(b.id) : true;
      const keyNote = acct.hasKey || state.config.mock ? "" : " · no key";
      return `<label class="bot-chip" title="${esc(b.model)} on ${esc(acct.name)}">
        <input type="checkbox" value="${esc(b.id)}" ${checked ? "checked" : ""} />
        <span class="dot" style="background:${accountColor(b.account)}"></span>
        ${esc(b.name)} <span class="sub">${esc(acct.name)}${keyNote}</span>
      </label>`;
    })
    .join("");
  $("#bot-list").addEventListener("change", () => {
    try {
      localStorage.setItem("bothub.participants", JSON.stringify(selectedBots()));
    } catch {}
  });
}

const selectedBots = () => [...document.querySelectorAll("#bot-list input:checked")].map((i) => i.value);

function messageHtml(m) {
  const you = m.speaker === "You";
  const color = m.account ? accountColor(m.account) : "var(--text-2)";
  const note = m.note ? ` <span class="note">· ${esc(m.note)}</span>` : "";
  return `<li class="msg ${you ? "you" : ""} ${m.error ? "err" : ""}">
    <div class="who">${you ? "" : `<span class="dot" style="background:${color}"></span>`}${esc(m.speaker)}
      <time datetime="${new Date(m.ts).toISOString()}">${fmtTime(m.ts)}</time>${note}</div><div class="body">${esc(m.text)}</div></li>`;
}

function renderMessages(list) {
  const box = $("#messages");
  box.innerHTML = list.length
    ? list.map(messageHtml).join("")
    : `<li class="empty">Pick some bots, say something, and they'll take turns replying.</li>`;
  box.scrollTop = box.scrollHeight;
}

function appendMessage(m) {
  const box = $("#messages");
  box.querySelector(".empty")?.remove();
  box.insertAdjacentHTML("beforeend", messageHtml(m));
  box.scrollTop = box.scrollHeight;
}

function setRunning(running) {
  state.running = running;
  $("#stop-btn").hidden = !running;
  $("#send-btn").disabled = running;
  $("#continue-btn").disabled = running;
  $("#clear-btn").disabled = running;
  if (!running) $("#typing").hidden = true;
  setStatus(running ? "Bots are talking…" : "");
}

async function send(text) {
  const participants = selectedBots();
  if (!participants.length) return setStatus("Pick at least one bot first.");
  try {
    await api("/api/messages", { method: "POST", body: { text, participants, rounds: Number($("#rounds").value) || 1 } });
    $("#input").value = "";
  } catch (e) {
    setStatus(e.message);
  }
}

function wireChat() {
  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("#input").value.trim();
    if (text) send(text);
  });
  $("#input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("#composer").requestSubmit();
    }
  });
  $("#continue-btn").addEventListener("click", () => send(""));
  $("#stop-btn").addEventListener("click", () => {
    api("/api/stop", { method: "POST" });
    setStatus("Stopping after the current reply…");
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

// ======================= Dashboard =======================

function renderTotals(u) {
  const t = u.total;
  $("#total").innerHTML = `<span class="big">${fmtUSD(t.cost)}</span>
    <span class="meta">${fmtNum(t.input + t.cachedInput + t.cacheWrite)} tokens in · ${fmtNum(t.output)} out ·
    ${t.requests} calls${t.errors ? ` · ${t.errors} failed` : ""}</span>`;

  $("#account-tiles").innerHTML = state.config.accounts
    .map((a) => {
      const s = u.byAccount[a.id];
      const share = t.cost > 0 ? Math.round((s.cost / t.cost) * 100) : 0;
      return `<div class="tile">
        <div class="name"><span class="dot" style="background:${accountColor(a.id)}"></span>${esc(a.name)}</div>
        <div class="val">${fmtUSD(s.cost)}</div>
        <div class="row"><span>Tokens in</span><span>${fmtNum(s.input + s.cachedInput + s.cacheWrite)}</span></div>
        <div class="row"><span>Tokens out</span><span>${fmtNum(s.output)}</span></div>
        <div class="row"><span>Calls</span><span>${s.requests}</span></div>
        <div class="row"><span>Share of cost</span><span>${share}%</span></div>
        ${s.errors ? `<div class="warn">${s.errors} failed call${s.errors > 1 ? "s" : ""}</div>` : ""}
        ${!a.hasKey && !state.config.mock ? `<div class="warn">No API key set</div>` : ""}
      </div>`;
    })
    .join("");
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

// Rect with only the top corners rounded (data end), anchored flat on the baseline side.
function topRounded(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 4, 8, 10].map((m) => m * p).find((m) => m >= v);
}

function renderChart(u) {
  const accounts = state.config.accounts;
  const days = dayList(u);
  const W = 640, H = 230, L = 52, R = 8, T = 10, B = 26;
  const plotW = W - L - R, plotH = H - T - B;
  const totals = days.map((d) => accounts.reduce((s, a) => s + (u.byDay[d]?.[a.id]?.cost ?? 0), 0));
  const max = niceMax(Math.max(...totals, 0));
  const y = (v) => T + plotH - (v / max) * plotH;
  const step = plotW / days.length;
  const barW = Math.max(2, Math.min(36, step * 0.6));

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily cost by account">`;
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    svg += `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" />`;
    svg += `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${fmtUSD(v)}</text>`;
  }
  const labelEvery = Math.ceil(days.length / 8);
  days.forEach((d, i) => {
    const cx = L + step * i + step / 2;
    svg += `<g class="col" data-i="${i}"><rect class="hit" x="${L + step * i}" y="${T}" width="${step}" height="${plotH}" />`;
    let base = 0;
    const segs = accounts
      .map((a) => ({ a, v: u.byDay[d]?.[a.id]?.cost ?? 0 }))
      .filter((s) => s.v > 0);
    segs.forEach((s, j) => {
      const y0 = y(base), y1 = y(base + s.v);
      const gap = j > 0 ? 2 : 0; // 2px surface gap between stacked segments
      const h = Math.max(0, y0 - y1 - gap);
      if (h > 0) {
        svg += j === segs.length - 1
          ? `<path d="${topRounded(cx - barW / 2, y1, barW, h, 4)}" fill="${accountColor(s.a.id)}" />`
          : `<rect x="${cx - barW / 2}" y="${y1}" width="${barW}" height="${h}" fill="${accountColor(s.a.id)}" />`;
      }
      base += s.v;
    });
    svg += `</g>`;
    if (i % labelEvery === 0) {
      const lab = new Date(`${d}T00:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
      svg += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${lab}</text>`;
    }
  });
  svg += `</svg>`;
  $("#chart").innerHTML = svg;

  $("#legend").innerHTML = accounts
    .map((a) => `<span><span class="dot" style="background:${accountColor(a.id)}"></span>${esc(a.name)}</span>`)
    .join("");

  // Hover tooltip per day column.
  const tip = $("#tooltip");
  const card = $(".chart-card");
  $("#chart").querySelectorAll(".col").forEach((g) => {
    g.addEventListener("mousemove", (e) => {
      const d = days[Number(g.dataset.i)];
      const rows = accounts
        .map((a) => {
          const s = u.byDay[d]?.[a.id];
          return `<div class="t-row"><span><span class="dot" style="background:${accountColor(a.id)}"></span>${esc(a.name)}</span>
            <span>${fmtUSD(s?.cost ?? 0)} · ${s?.requests ?? 0} calls</span></div>`;
        })
        .join("");
      tip.innerHTML = `<div class="t-head">${d} — ${fmtUSD(totals[Number(g.dataset.i)])}</div>${rows}`;
      tip.hidden = false;
      const box = card.getBoundingClientRect();
      let left = e.clientX - box.left + 12;
      if (left + tip.offsetWidth > box.width) left = e.clientX - box.left - tip.offsetWidth - 12;
      tip.style.left = `${Math.max(4, left)}px`;
      tip.style.top = `${e.clientY - box.top + 12}px`;
    });
    g.addEventListener("mouseleave", () => (tip.hidden = true));
  });
}

function renderTables(u) {
  const botRows = state.config.bots
    .map((b) => ({ b, s: u.byBot[b.id] }))
    .sort((x, y) => y.s.cost - x.s.cost)
    .map(
      ({ b, s }) => `<tr>
        <td><span class="dot" style="background:${accountColor(b.account)}"></span> ${esc(b.name)}</td>
        <td>${esc(accountName(b.account))}</td>
        <td>${esc(b.model)}</td>
        <td class="num">${s.requests}</td>
        <td class="num">${fmtNum(s.input + s.cachedInput + s.cacheWrite)}</td>
        <td class="num">${fmtNum(s.output)}</td>
        <td class="num">${fmtUSD(s.cost)}</td>
      </tr>`,
    )
    .join("");
  $("#bot-table").innerHTML = `<thead><tr><th>Bot</th><th>Account</th><th>Model</th>
    <th class="num">Calls</th><th class="num">In</th><th class="num">Out</th><th class="num">Cost</th></tr></thead>
    <tbody>${botRows}</tbody>`;

  const botName = (id) => state.config.bots.find((b) => b.id === id)?.name ?? id;
  const recent = u.recent
    .map(
      (r) => `<tr>
        <td>${fmtTime(r.ts)}</td>
        <td>${esc(botName(r.bot))}</td>
        <td>${esc(accountName(r.account))}</td>
        <td class="num">${fmtNum((r.input ?? 0) + (r.cachedInput ?? 0) + (r.cacheWrite ?? 0))}</td>
        <td class="num">${fmtNum(r.output ?? 0)}</td>
        <td class="num">${fmtUSD(r.cost ?? 0)}</td>
        <td class="num">${((r.latencyMs ?? 0) / 1000).toFixed(1)}s</td>
        <td class="${r.ok ? "" : "err"}">${r.ok ? "ok" : esc(r.error ?? "error")}</td>
      </tr>`,
    )
    .join("");
  $("#recent-table").innerHTML = `<thead><tr><th>Time</th><th>Bot</th><th>Account</th><th class="num">In</th>
    <th class="num">Out</th><th class="num">Cost</th><th class="num">Time</th><th>Status</th></tr></thead>
    <tbody>${recent || `<tr><td colspan="8">No calls yet in this range.</td></tr>`}</tbody>`;
}

let usageTimer = null;
async function refreshUsage() {
  clearTimeout(usageTimer);
  try {
    const u = await api(`/api/usage?days=${state.days}`);
    renderTotals(u);
    renderChart(u);
    renderTables(u);
  } catch (e) {
    setStatus(`Couldn't load usage: ${e.message}`);
  }
}
// Coalesce bursts of usage events into one refresh.
const scheduleUsage = () => {
  clearTimeout(usageTimer);
  usageTimer = setTimeout(refreshUsage, 250);
};

function wireDashboard() {
  try {
    const saved = localStorage.getItem("bothub.days");
    if (saved) state.days = saved;
  } catch {}
  document.querySelectorAll(".seg button").forEach((btn) => {
    const sync = () => {
      const on = btn.dataset.days === state.days;
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-checked", String(on));
    };
    sync();
    btn.addEventListener("click", () => {
      state.days = btn.dataset.days;
      try {
        localStorage.setItem("bothub.days", state.days);
      } catch {}
      document.querySelectorAll(".seg button").forEach((b) => {
        const on = b === btn;
        b.classList.toggle("on", on);
        b.setAttribute("aria-checked", String(on));
      });
      refreshUsage();
    });
  });
}

// ======================= Live events =======================

function connectEvents() {
  const es = new EventSource("/api/events");
  es.addEventListener("message", (e) => appendMessage(JSON.parse(e.data)));
  es.addEventListener("typing", (e) => {
    const { name } = JSON.parse(e.data);
    $("#typing").textContent = `${name} is typing…`;
    $("#typing").hidden = false;
  });
  es.addEventListener("status", (e) => setRunning(JSON.parse(e.data).running));
  es.addEventListener("usage", scheduleUsage);
  es.addEventListener("cleared", () => renderMessages([]));
  es.onerror = () => setStatus("Reconnecting to server…");
  es.onopen = () => !state.running && setStatus("");
}

// ======================= Boot =======================

(async function boot() {
  state.config = await api("/api/config");
  $("#mode-badge").hidden = !state.config.mock;
  renderBots();
  wireChat();
  wireDashboard();
  renderMessages(await api("/api/messages"));
  refreshUsage();
  connectEvents();
})().catch((e) => setStatus(`Failed to start: ${e.message}`));
