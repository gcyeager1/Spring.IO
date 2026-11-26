// Pure helpers for Grok subscription plan-usage reports. Shared by the browser UI
// (served as /planusage.js) and the Node tests / server, so keep it dependency-free.

export const PLAN_ACCOUNTS = { lifteasy: "grok-1", garrett: "grok-2" };
export const LEFTOVER_RE = /^deleted bots\b|other people'?s bots/i;

/** A bot name that is the "everything else" bucket rather than a real bot. */
export const isLeftoverBucket = (name) => LEFTOVER_RE.test(String(name ?? "").trim());

/** Share-of-used-amount formatting: anything under 1 (but above 0) shows as "<1%". */
export function fmtShare(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n) || n <= 0) return "0%";
  if (n < 1) return "<1%";
  return `${Number.isInteger(n) ? n : +n.toFixed(1)}%`;
}

export const fmtPercentUsed = (pct) => `${+Number(pct).toFixed(1)}%`;

/** Latest report for an account id like "lifteasy", or null when none has been ingested. */
export const reportFor = (planUsage, account) => planUsage?.[account] ?? null;

/** Reset time in Eastern, e.g. "Dec 3, 6:36 AM EST". */
export function fmtResetEastern(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(d);
}

export function fmtAgo(iso, now = Date.now()) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "unknown";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Validate an ingest body. Returns { report } or { error }. */
export function validateReport(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "Invalid report" };
  if (!Object.hasOwn(PLAN_ACCOUNTS, b.account)) return { error: "account must be lifteasy or garrett" };
  if (typeof b.percentUsed !== "number" || !Number.isFinite(b.percentUsed)) return { error: "percentUsed must be a number" };
  if (!Array.isArray(b.bots) || !b.bots.length) return { error: "bots must be a non-empty array" };
  const bots = [];
  for (const x of b.bots) {
    if (!x || typeof x.name !== "string" || !x.name.trim() || typeof x.sharePct !== "number" || !Number.isFinite(x.sharePct)) {
      return { error: "each bot needs a name and numeric sharePct" };
    }
    bots.push({ name: x.name.trim().slice(0, 200), sharePct: x.sharePct });
  }
  const str = (v, max = 300) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
  const date = (v) => (typeof v === "string" && !Number.isNaN(new Date(v).getTime()) ? v : undefined);
  return {
    report: {
      account: b.account,
      plan: str(b.plan, 60),
      percentUsed: b.percentUsed,
      resetsAt: date(b.resetsAt),
      onDemand: str(b.onDemand),
      period: str(b.period, 60),
      bots,
      routines: b.routines ?? undefined,
      reportedAt: date(b.reportedAt) ?? new Date().toISOString(),
      receivedAt: new Date().toISOString(),
    },
  };
}

// ---------- Pool pie (each account's weekly pool = 100%) ----------

export const EMPTY_PLAN_TEXT = "Waiting for usage data";

/** Pool-share formatting: under 1 (but above 0) is "<1%"; otherwise one decimal, trimmed ("3.9%", "91.9%", "48%"). */
export function fmtPoolShare(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n) || n <= 0) return "0%";
  if (n < 1) return "<1%";
  return `${+n.toFixed(1)}%`;
}

/**
 * Slices of the weekly pool for one report. Each bot's slice is percentUsed * sharePct / 100;
 * Remaining pads the total to 100. Slices are scaled down only if they overshoot 100.
 * Returns { slices: [{ name, pct, leftover, remaining }], total } where total is 100 (or 0 for bad input).
 */
export function poolSlices(report) {
  const used = Number(report?.percentUsed);
  if (!report || !Number.isFinite(used)) return { slices: [], total: 0 };
  const u = Math.min(Math.max(used, 0), 100);
  let slices = (report.bots ?? []).map((b) => ({
    name: String(b.name),
    pct: Math.max(0, (u * (Number(b.sharePct) || 0)) / 100),
    leftover: isLeftoverBucket(b.name),
    remaining: false,
  }));
  const sum = slices.reduce((a, s) => a + s.pct, 0);
  if (sum > 100) slices = slices.map((s) => ({ ...s, pct: (s.pct * 100) / sum }));
  const rest = Math.max(0, 100 - Math.min(sum, 100));
  slices.push({ name: "Remaining", pct: rest, leftover: false, remaining: true });
  return { slices, total: 100 };
}

const PIE_COLORS = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)", "var(--series-6)", "var(--series-7)", "var(--series-8)"];
export const sliceColor = (s, i) => (s.remaining ? "var(--surface-3)" : s.leftover ? "var(--series-other)" : PIE_COLORS[i % PIE_COLORS.length]);

/** SVG donut markup (no dependencies). Zero-size slices are skipped; pure so tests can inspect it. */
export function pieSvg(slices, size = 120) {
  const c = size / 2, r = size / 2 - 2, ri = r * 0.58;
  const pt = (rad, a) => `${(c + rad * Math.sin(a)).toFixed(3)},${(c - rad * Math.cos(a)).toFixed(3)}`;
  const total = slices.reduce((a, s) => a + s.pct, 0) || 100;
  let a0 = 0;
  const paths = [];
  slices.forEach((s, i) => {
    if (s.pct <= 0) return;
    const frac = Math.min(s.pct / total, 0.99999);
    const a1 = a0 + frac * 2 * Math.PI;
    const big = frac > 0.5 ? 1 : 0;
    paths.push(`<path d="M${pt(r, a0)}A${r},${r} 0 ${big} 1 ${pt(r, a1)}L${pt(ri, a1)}A${ri},${ri} 0 ${big} 0 ${pt(ri, a0)}Z" fill="${sliceColor(s, i)}"><title>${s.name.replace(/[<>&"]/g, "")} ${fmtPoolShare(s.pct)}</title></path>`);
    a0 = a1;
  });
  return `<svg class="pie" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Weekly pool">${paths.join("")}</svg>`;
}
