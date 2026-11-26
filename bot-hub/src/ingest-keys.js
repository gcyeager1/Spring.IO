// Per-account ingest key for the Garrett plan-usage feed. Generated server-side, stored in
// DATA_DIR (mode 0600), never logged. The master BOTHUB_INGEST_TOKEN lives in env, not here.
import fs from "node:fs";
import path from "node:path";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { dataDir } from "./config.js";

const FILE = path.join(dataDir(), "ingest-key-garrett.json");
const sha = (v) => createHash("sha256").update(String(v)).digest();

let key = null; // { token, createdAt }
try {
  const k = JSON.parse(fs.readFileSync(FILE, "utf8"));
  if (typeof k.token === "string" && k.token) key = { token: k.token, createdAt: k.createdAt ?? null };
} catch {}

function persist() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(key), { mode: 0o600 });
  fs.chmodSync(FILE, 0o600);
}

export function regenerateGarrettKey() {
  key = { token: randomBytes(32).toString("base64url"), createdAt: new Date().toISOString() };
  persist();
  return key.token;
}

// Generate on first use so a fresh deploy needs no manual env step.
export function ensureGarrettKey() {
  if (!key) regenerateGarrettKey();
  return key;
}
ensureGarrettKey();

export const garrettKeyMeta = () => ({ exists: Boolean(key), createdAt: key?.createdAt ?? null });
export const revealGarrettKey = () => ensureGarrettKey().token;

/** Constant-time check of a presented bearer against the garrett key. */
export const matchesGarrettKey = (presented) => timingSafeEqual(sha(presented ?? ""), sha(key?.token ?? "")) && Boolean(key);
