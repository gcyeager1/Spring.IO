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
