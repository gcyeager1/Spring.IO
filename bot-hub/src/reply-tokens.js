// Reply tokens for POST /api/agent-reply. Lifteasy bots use env BOTHUB_REPLY_TOKEN (never stored
// here). The garrett-account token is generated on boot, kept in DATA_DIR (mode 0600), never logged.
import fs from "node:fs";
import path from "node:path";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { dataDir } from "./config.js";

const FILE = path.join(dataDir(), "reply-token-garrett.json");
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
export function regenerateGarrettReplyToken() {
  key = { token: randomBytes(32).toString("base64url"), createdAt: new Date().toISOString() };
  persist();
  return key.token;
}
if (!key) regenerateGarrettReplyToken();

export const replyTokenMeta = () => ({
  lifteasy: { exists: Boolean(process.env.BOTHUB_REPLY_TOKEN) },
  garrett: { exists: Boolean(key), createdAt: key?.createdAt ?? null },
});
export const revealGarrettReplyToken = () => key.token;
export const revealLifteasyReplyToken = () => process.env.BOTHUB_REPLY_TOKEN || null;

/** "lifteasy" | "garrett" | null. Both digests are always compared (no early exit). */
export function replyRole(presented, hasBearer) {
  const env = process.env.BOTHUB_REPLY_TOKEN;
  const isLif = timingSafeEqual(sha(presented), sha(env ?? "")) && Boolean(env) && hasBearer;
  const isGar = timingSafeEqual(sha(presented), sha(key?.token ?? "")) && Boolean(key) && hasBearer;
  return isLif ? "lifteasy" : isGar ? "garrett" : null;
}
