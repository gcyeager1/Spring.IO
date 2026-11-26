// Saved real-agent webhooks (URL + key), kept on the data volume so Settings can change them
// without a redeploy. Read fresh from disk on every lookup: no cache to go stale. Keys are never
// logged and never leave this module except to the outbound webhook call.
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./config.js";

const FILE = () => path.join(dataDir(), "bridge-webhooks.json");

// The only bots whose webhooks can be managed (ids and labels shown in Settings -> Bridge).
export const BRIDGE_BOTS = [
  { id: "asschub", label: "Asschub", account: "grok-1" },
  { id: "leads-lifteasy", label: "Leads", account: "grok-1" },
  { id: "addy", label: "Addy", account: "grok-1" },
  { id: "crm", label: "Crm", account: "grok-1" },
  { id: "usage-bot", label: "Usage", account: "grok-1" },
  { id: "dummy", label: "Dummy", account: "grok-2" },
  { id: "crm-builder", label: "CRM Builder", account: "grok-2" },
  { id: "leads-garrett", label: "Leads", account: "grok-2" },
  { id: "ads", label: "Ads", account: "grok-2" },
  { id: "socials", label: "Socials", account: "grok-2" },
  { id: "pawn", label: "Pawn", account: "grok-2" },
];
export const isBridgeBot = (id) => BRIDGE_BOTS.some((b) => b.id === id);

const envSuffix = (botId) => String(botId).toUpperCase().replace(/-/g, "_");
const str = (v) => (typeof v === "string" ? v.trim() : "");

function readAll() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}
function writeAll(all) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(all), { mode: 0o600 });
  fs.chmodSync(FILE(), 0o600);
}

export function volumeEntry(botId) {
  const e = readAll()[botId];
  return e && typeof e === "object" ? { url: str(e.url), key: str(e.key) } : { url: "", key: "" };
}
export function envEntry(botId) {
  const s = envSuffix(botId);
  return { url: str(process.env[`BOTHUB_WEBHOOK_URL_${s}`]), key: str(process.env[`BOTHUB_WEBHOOK_KEY_${s}`]) };
}

/** Effective webhook: complete volume entry, else complete env pair, else null. */
export function lookupWebhook(botId) {
  const v = volumeEntry(botId);
  if (v.url && v.key) return { url: v.url, key: v.key };
  const e = envEntry(botId);
  return e.url && e.key ? { url: e.url, key: e.key } : null;
}

/** Safe view for Settings: never contains a key. */
export function bridgeView() {
  return BRIDGE_BOTS.map((b) => {
    const v = volumeEntry(b.id);
    const e = envEntry(b.id);
    const source = v.url && v.key ? "volume" : e.url && e.key ? "env" : "none";
    const url = source === "volume" ? v.url : source === "env" ? e.url : v.url || e.url;
    return { id: b.id, name: b.label, account: b.account, url, keySet: source !== "none", source };
  });
}

/** null if OK, else a message. Only https Cursor automation webhooks are accepted. */
export function validateWebhookUrl(raw) {
  let u;
  try { u = new URL(String(raw ?? "").trim()); } catch { return "Not a valid URL"; }
  if (u.protocol !== "https:") return "URL must use https";
  if (u.username || u.password) return "URL must not contain credentials";
  if (u.port && u.port !== "443") return "URL must use the default port";
  const h = u.hostname.toLowerCase();
  if (h !== "cursor.sh" && !h.endsWith(".cursor.sh")) return "Host must be on cursor.sh";
  if (!u.pathname.startsWith("/automations/webhook/")) return "Path must start with /automations/webhook/";
  return null;
}

/** Save url (and key if given). Returns { error } or { ok }. */
export function saveWebhook(botId, url, key) {
  if (!isBridgeBot(botId)) return { error: "Unknown bridge bot" };
  const bad = validateWebhookUrl(url);
  if (bad) return { error: bad };
  const all = readAll();
  const prev = volumeEntry(botId);
  const newKey = str(key);
  // A key already on the volume is kept; env's key is adopted only when nothing else is given.
  const finalKey = newKey || prev.key || envEntry(botId).key;
  if (!finalKey) return { error: "Enter a webhook key" };
  all[botId] = { url: new URL(String(url).trim()).href, key: finalKey };
  writeAll(all);
  return { ok: true };
}

export function clearWebhook(botId) {
  if (!isBridgeBot(botId)) return { error: "Unknown bridge bot" };
  const all = readAll();
  delete all[botId];
  writeAll(all);
  return { ok: true };
}
