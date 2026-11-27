// CRM embed support: frame-ancestors allowlist + one-time SSO tickets (in memory, single instance).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const DEFAULT_ANCESTORS = [
  "'self'",
  "https://crm.ezliftgaragedoorservice.com",
  "https://ez-lift-crm-production.up.railway.app",
  "http://127.0.0.1:4721",
  "http://localhost:4721",
];

/** Normalise one extra origin; null if it is not an allowed shape. */
function cleanOrigin(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.pathname !== "/" || u.search || u.hash || u.username || u.password) return null;
  if (u.protocol === "https:") return u.origin;
  if (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) return u.origin;
  return null;
}

export function frameAncestors(extraEnv = process.env.BOTHUB_FRAME_ANCESTORS) {
  const extra = String(extraEnv ?? "").split(",").map(cleanOrigin).filter(Boolean);
  return [...new Set([...DEFAULT_ANCESTORS, ...extra])];
}

export const cspHeader = (extraEnv) => `frame-ancestors ${frameAncestors(extraEnv).join(" ")}`;

const sha = (v) => createHash("sha256").update(String(v)).digest();

/** True only when a secret is configured and the Authorization header is `Bearer <secret>`. */
export function ssoSecretOk(req, secret = process.env.BOTHUB_CRM_SSO_SECRET) {
  const m = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""));
  const ok = timingSafeEqual(sha(m?.[1] ?? ""), sha(secret ?? ""));
  return Boolean(secret) && Boolean(m) && ok;
}

export const SSO_TTL_MS = 60_000;
const tickets = new Map(); // ticket -> { exp, email?, name?, source? }

const str = (v) => (typeof v === "string" ? v.slice(0, 200) : undefined);

export function createTicket(meta = {}) {
  const now = Date.now();
  for (const [k, t] of tickets) if (t.exp < now) tickets.delete(k);
  const ticket = randomBytes(32).toString("base64url");
  tickets.set(ticket, { exp: now + SSO_TTL_MS, email: str(meta.email), name: str(meta.name), source: str(meta.source) });
  return ticket;
}

/** Single use: returns the record and deletes it, or null. */
export function consumeTicket(ticket) {
  if (typeof ticket !== "string" || !ticket) return null;
  const t = tickets.get(ticket);
  if (!t) return null;
  tickets.delete(ticket);
  return t.exp >= Date.now() ? t : null;
}
