import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRealAgent, DEFAULT_HANDOFF_TRIGGERS } from "./realagent.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Persistent data (chat/usage JSONL, setup-created admin). Mount a volume here when hosted. */
export const dataDir = () => path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));

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
  return { ...cfg, file, accountsById: accounts, handoffTriggers: handoffTriggers(cfg), agentPosters: agentPosters(cfg) };
}

const list = (v) => (Array.isArray(v) ? v : String(v ?? "").split(","))
  .map((x) => String(x).trim()).filter(Boolean);

/** Bot ids allowed to post directly via POST /api/agent-post: env (comma-separated) > config.json > ["asschub"]. */
export function agentPosters(cfg) {
  const env = list(process.env.BOTHUB_AGENT_POSTERS);
  if (env.length) return env;
  const fromCfg = list(cfg.agentPosters);
  return fromCfg.length ? fromCfg : ["asschub"];
}

/** Bot ids allowed to hand off by @mention: env (comma-separated) > config.json > default. */
export function handoffTriggers(cfg) {
  const env = list(process.env.BOTHUB_HANDOFF_TRIGGERS);
  if (env.length) return env;
  const fromCfg = list(cfg.handoffTriggers);
  if (fromCfg.length) return fromCfg;
  // The hub's own Claude bot is whichever bot runs on the Claude Code account.
  const claude = cfg.bots.find((b) => usesPlanAccount(cfg, b))?.id ?? "claude";
  return DEFAULT_HANDOFF_TRIGGERS.map((id) => (id === "claude" ? claude : id));
}
const usesPlanAccount = (cfg, bot) => cfg.accounts.some((a) => a.id === bot.account && isPlan(a));

/** Accounts paid for by a subscription (Claude Code on your plan) cost nothing per call. */
export const isPlan = (account) => account.provider === "claude-code";

// Whether the Claude Code CLI can be run, checked once per command.
const cliChecks = new Map();
export function claudeCodeVersion(command = "claude") {
  if (!cliChecks.has(command)) {
    const r = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 15_000 });
    cliChecks.set(command, r.status === 0 ? r.stdout.trim() : null);
  }
  return cliChecks.get(command);
}

const hasLocalLogin = () => fs.existsSync(path.join(os.homedir(), ".claude", ".credentials.json"));

/** Why an account can't make calls right now, or null if it looks ready. */
export function accountProblem(account) {
  if (isMock() || account.provider === "local") return null; // local: canned replies, always ready
  if (account.provider === "claude-code") {
    if (!claudeCodeVersion(account.command)) return "Claude Code not found - install it and log in";
    // Hosted/headless: there's no browser to /login, so the setup-token env var is required.
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.stdin.isTTY && !hasLocalLogin()) {
      return "CLAUDE_CODE_OAUTH_TOKEN not set (run `claude setup-token`)";
    }
    return null;
  }
  return process.env[account.apiKeyEnv] ? null : "no API key";
}

/** Config safe to send to the browser: no key env var names or values. */
export function publicConfig(cfg) {
  return {
    mock: isMock(),
    accounts: cfg.accounts.map((a) => ({
      id: a.id,
      name: a.name,
      provider: a.provider,
      plan: isPlan(a),
      problem: accountProblem(a),
    })),
    // realAgent is only a boolean: the webhook URL/key themselves never leave the server.
    bots: cfg.bots.map((b) => ({ id: b.id, name: b.name, account: b.account, model: b.model, realAgent: isRealAgent(b) })),
  };
}

export const isMock = () => process.env.BOT_HUB_MOCK === "1";
