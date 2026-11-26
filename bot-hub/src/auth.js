// Single-admin authentication: scrypt password hash, signed session cookies, login rate limiting.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataDir } from "./config.js";

const SESSION_MS = 7 * 86_400_000;
const MIN_PASSWORD = 12;

// ---------- password hashing (scrypt) ----------
// Format: scrypt$N$r$p$saltB64$hashB64
export function hashPassword(password) {
  const N = 16384, r = 8, p = 1;
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password, stored) {
  try {
    const [alg, N, r, p, salt, hash] = String(stored).split("$");
    if (alg !== "scrypt") return false;
    const want = Buffer.from(hash, "base64");
    const got = crypto.scryptSync(password, Buffer.from(salt, "base64"), want.length, { N: +N, r: +r, p: +p });
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

const DUMMY_HASH = hashPassword("dummy-password-for-timing");
const sameText = (a, b) => {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

// ---------- admin account ----------
const adminFile = () => path.join(dataDir(), "admin.json");

/** { email, hash, source } or null when no admin exists yet (setup is open). */
export function getAdmin() {
  const envHash = process.env.BOTHUB_ADMIN_PASSWORD_HASH;
  if (envHash) {
    return { email: (process.env.BOTHUB_ADMIN_EMAIL ?? "").trim().toLowerCase(), hash: envHash, source: "env" };
  }
  try {
    const a = JSON.parse(fs.readFileSync(adminFile(), "utf8"));
    if (a.email && a.hash) return { ...a, source: "file" };
  } catch {}
  return null;
}

export const setupOpen = () => !getAdmin();

export function createAdmin(email, password, token) {
  if (!setupOpen()) return { error: "Setup is already complete", status: 403 };
  const need = process.env.BOTHUB_SETUP_TOKEN;
  if (need && !sameText(token ?? "", need)) return { error: "Wrong setup token", status: 403 };
  const envEmail = (process.env.BOTHUB_ADMIN_EMAIL ?? "").trim().toLowerCase();
  const mail = (envEmail || String(email ?? "").trim().toLowerCase());
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) return { error: "Enter a valid email", status: 400 };
  if (String(password ?? "").length < MIN_PASSWORD) return { error: `Password must be at least ${MIN_PASSWORD} characters`, status: 400 };
  fs.mkdirSync(dataDir(), { recursive: true });
  try {
    // "wx": fails if another request created the admin first.
    fs.writeFileSync(adminFile(), JSON.stringify({ email: mail, hash: hashPassword(password), createdAt: Date.now() }), { flag: "wx", mode: 0o600 });
  } catch {
    return { error: "Setup is already complete", status: 403 };
  }
  return { ok: true };
}

/** True only for the right email + password. Does the same work either way. */
export function checkCredentials(email, password) {
  const admin = getAdmin();
  const mail = String(email ?? "").trim().toLowerCase();
  const pw = String(password ?? "");
  const hashOk = verifyPassword(pw, admin?.hash ?? DUMMY_HASH);
  const emailOk = admin ? sameText(mail, admin.email) : false;
  return Boolean(admin) && hashOk && emailOk;
}

// ---------- sessions: HMAC-signed token + server-side revocation ----------
let secretCache;
function secret() {
  if (process.env.BOTHUB_SESSION_SECRET) return process.env.BOTHUB_SESSION_SECRET;
  if (secretCache) return secretCache;
  // No env secret: generate one once and keep it in the data dir so sessions survive restarts.
  const f = path.join(dataDir(), "session-secret");
  try {
    secretCache = fs.readFileSync(f, "utf8").trim();
  } catch {
    secretCache = crypto.randomBytes(48).toString("base64url");
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(f, secretCache, { mode: 0o600 });
  }
  return secretCache;
}
const sign = (body) => crypto.createHmac("sha256", secret()).update(body).digest("base64url");
const revoked = new Map(); // sid -> exp

// A fingerprint of the current credentials, so changing the password logs everyone out.
const credFingerprint = () => sign("cred:" + (getAdmin()?.hash ?? "")).slice(0, 16);

export function createSession() {
  const sid = crypto.randomBytes(24).toString("base64url");
  const body = `${sid}.${Date.now() + SESSION_MS}.${credFingerprint()}`;
  return { token: `${body}.${sign(body)}`, maxAgeS: SESSION_MS / 1000 };
}

export function verifySession(token) {
  if (!token) return null;
  const i = token.lastIndexOf(".");
  if (i < 0) return null;
  const body = token.slice(0, i);
  if (!sameText(sign(body), token.slice(i + 1))) return null;
  const [sid, exp, fp] = body.split(".");
  if (Number(exp) < Date.now() || revoked.has(sid) || fp !== credFingerprint()) return null;
  return { sid, exp: Number(exp) };
}

export function revokeSession(token) {
  const s = verifySession(token);
  if (!s) return;
  revoked.set(s.sid, s.exp);
  for (const [k, e] of revoked) if (e < Date.now()) revoked.delete(k);
}

export const COOKIE = "bothub_session";

export function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token, maxAgeS, secure) {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${secure ? "; Secure" : ""}`;
}

// ---------- login rate limiting ----------
const WINDOW_MS = 15 * 60_000;
const MAX_PER_PAIR = 5; // failures per ip+email
const MAX_PER_IP = 20; // failures per ip
const fails = new Map(); // key -> [timestamps]

function recent(key) {
  const now = Date.now();
  const list = (fails.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length) fails.set(key, list);
  else fails.delete(key);
  return list;
}

/** Seconds until the caller may retry, or 0 if allowed. */
export function loginBlocked(ip, email) {
  const e = String(email ?? "").trim().toLowerCase();
  for (const [key, max] of [[`pair:${ip}|${e}`, MAX_PER_PAIR], [`ip:${ip}`, MAX_PER_IP]]) {
    const list = recent(key);
    if (list.length >= max) return Math.max(1, Math.ceil((list[0] + WINDOW_MS - Date.now()) / 1000));
  }
  return 0;
}

export function recordLoginFailure(ip, email) {
  const e = String(email ?? "").trim().toLowerCase();
  for (const key of [`pair:${ip}|${e}`, `ip:${ip}`]) fails.set(key, [...recent(key), Date.now()]);
  if (fails.size > 5000) fails.clear();
}

export function clearLoginFailures(ip, email) {
  fails.delete(`pair:${ip}|${String(email ?? "").trim().toLowerCase()}`);
}
