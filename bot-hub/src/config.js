import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig() {
  const own = path.join(ROOT, "config.json");
  const file = fs.existsSync(own) ? own : path.join(ROOT, "config.example.json");
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  const accounts = new Map(cfg.accounts.map((a) => [a.id, a]));
  for (const bot of cfg.bots) {
    if (!accounts.has(bot.account)) {
      throw new Error(`Bot "${bot.id}" refers to unknown account "${bot.account}" in ${path.basename(file)}`);
    }
  }
  return { ...cfg, file, accountsById: accounts };
}

/** Config safe to send to the browser: no key env var names or values. */
export function publicConfig(cfg) {
  return {
    mock: isMock(),
    accounts: cfg.accounts.map((a) => ({
      id: a.id,
      name: a.name,
      provider: a.provider,
      hasKey: Boolean(process.env[a.apiKeyEnv]),
    })),
    bots: cfg.bots.map((b) => ({ id: b.id, name: b.name, account: b.account, model: b.model })),
  };
}

export const isMock = () => process.env.BOT_HUB_MOCK === "1";
