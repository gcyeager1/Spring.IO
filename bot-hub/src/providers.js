import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { isMock, isPlan } from "./config.js";
import { CC_CWD, extractFromStreamJson, recordClaudeUsage } from "./claude-usage.js";

/**
 * Every provider gets the same input: the bot, its account, and the shared
 * transcript ([{speaker, botId|null, text}]). Each bot sees its own past
 * lines as "assistant" turns and everyone else's as "user" turns, prefixed
 * with the speaker's name so it can follow a multi-party chat.
 *
 * Every provider returns:
 *   { text, usage: { input, output, cachedInput, cacheWrite }, model, note?, apiValue? }
 * (apiValue: what a subscription-covered call would have cost at API list price)
 */

function toTurns(bot, transcript, direct = false) {
  const turns = [];
  for (const m of transcript) {
    if (m.hidden) continue;
    const role = m.botId === bot.id ? "assistant" : "user";
    const content = role === "assistant" || direct ? m.text : `[${m.speaker}]: ${m.text}`;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content += `\n\n${content}`;
    else turns.push({ role, content });
  }
  // Both APIs want the conversation to start with a user turn and end with one.
  if (!turns.length || turns[0].role !== "user") {
    turns.unshift({ role: "user", content: direct ? "Hi." : "[system]: The group chat is starting." });
  }
  if (turns[turns.length - 1].role !== "user") {
    turns.push({ role: "user", content: direct ? "Please continue." : "[system]: Your turn - continue the conversation." });
  }
  return turns;
}

function systemPrompt(bot, participants, direct) {
  if (direct) {
    return `${bot.systemPrompt}\n\nYou are "${bot.name}" in a private one-on-one chat with the user.`;
  }
  const others = participants.filter((p) => p !== bot.name);
  return (
    `${bot.systemPrompt}\n\nYou are "${bot.name}" in a group chat. Other participants: ` +
    `${others.join(", ") || "the human user"}. Messages from others are prefixed with ` +
    `"[Name]:". Reply only as yourself, without a name prefix.`
  );
}

// ---------- Grok (xAI) ----------
// xAI's REST API is OpenAI-compatible; called directly with fetch so the
// project needs no extra SDK.
async function callXai(bot, account, transcript, ctx) {
  const key = process.env[account.apiKeyEnv];
  if (!key) throw new Error(`No API key: set ${account.apiKeyEnv} for account "${account.name}"`);
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: bot.model,
      messages: [{ role: "system", content: ctx.system }, ...toTurns(bot, transcript, ctx.direct)],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`xAI ${res.status}: ${body?.error?.message ?? body?.error ?? res.statusText}`);
  }
  const u = body.usage ?? {};
  return {
    text: body.choices?.[0]?.message?.content ?? "",
    model: body.model ?? bot.model,
    usage: {
      input: (u.prompt_tokens ?? 0) - (u.prompt_tokens_details?.cached_tokens ?? 0),
      cachedInput: u.prompt_tokens_details?.cached_tokens ?? 0,
      output: u.completion_tokens ?? 0,
      cacheWrite: 0,
    },
  };
}

// ---------- Claude (Anthropic) ----------
const anthropicClients = new Map();
function anthropicFor(account) {
  if (!anthropicClients.has(account.id)) {
    // apiKeyEnv lets you point separate Claude accounts at separate keys.
    const apiKey = process.env[account.apiKeyEnv];
    anthropicClients.set(account.id, apiKey ? new Anthropic({ apiKey }) : new Anthropic());
  }
  return anthropicClients.get(account.id);
}

async function callAnthropic(bot, account, transcript, ctx) {
  const client = anthropicFor(account);
  let response;
  try {
    response = await client.beta.messages.create({
      model: bot.model,
      max_tokens: 16000,
      system: ctx.system,
      messages: toTurns(bot, transcript, ctx.direct),
      output_config: { effort: bot.effort ?? "low" },
      // Caches the growing transcript so each turn only pays full price for new lines.
      cache_control: { type: "ephemeral" },
      // If a safety classifier declines, the API retries on a suitable fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new Error(`Claude: invalid or missing API key (${account.apiKeyEnv})`);
    } else if (err instanceof Anthropic.RateLimitError) {
      throw new Error("Claude: rate limited - try again shortly");
    } else if (err instanceof Anthropic.APIError) {
      throw new Error(`Claude API ${err.status ?? ""}: ${err.message}`);
    }
    throw err;
  }

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  const u = response.usage;
  let note;
  if (response.stop_reason === "refusal") {
    note = `declined (${response.stop_details?.category ?? "policy"})`;
  } else if (response.stop_reason === "max_tokens") {
    note = "reply cut off at max_tokens";
  }
  return {
    text: text || (note ? `(${note})` : ""),
    model: response.model,
    note,
    usage: {
      input: u.input_tokens ?? 0,
      cachedInput: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      output: u.output_tokens ?? 0,
    },
  };
}

// ---------- Claude via Claude Code, on your Claude subscription ----------
// Runs the Claude Code CLI ("claude -p") on this machine for each reply, so
// Claude's turns use the plan you're signed in to instead of an API key.
// Personal use only: Anthropic doesn't allow subscription logins to serve
// other people - use the "anthropic" provider with an API key for that.

function transcriptText(bot, transcript, direct) {
  const lines = transcript
    .filter((m) => !m.hidden)
    .map((m) => `${m.botId === bot.id ? `${bot.name} (you)` : m.speaker}: ${m.text}`);
  return lines.length ? lines.join("\n\n") : direct ? "You: Hi." : "(The group chat is just starting.)";
}

async function callClaudeCode(bot, account, transcript, ctx) {
  const command = account.command ?? "claude";
  const args = [
    "-p",
    `The conversation so far is above. Write ${bot.name}'s next message only - no name prefix.`,
    "--output-format", "stream-json", "--verbose",
    "--system-prompt", ctx.system,
    "--tools", "", // chat only: no file, shell or web tools
    "--max-turns", "1",
    "--no-session-persistence",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
  ];
  if (bot.model && bot.model !== "default") args.push("--model", bot.model);

  // An API key in the environment would take priority over the subscription login.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  const out = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: CC_CWD, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Claude Code took longer than 3 minutes - stopped"));
    }, 180_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        err.code === "ENOENT"
          ? new Error(`Claude Code isn't installed or "${command}" isn't on PATH`)
          : err,
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(transcriptText(bot, transcript, ctx.direct));
  });

  const { result: data, windows } = extractFromStreamJson(out.stdout);
  if (windows) recordClaudeUsage(windows, "hub");
  if (!data) {
    const detail = (out.stderr || out.stdout).trim().split("\n").slice(-1)[0] || `exit code ${out.code}`;
    throw new Error(`Claude Code: ${detail}`);
  }
  if (data.is_error || data.subtype !== "success") {
    const msg = String(data.result ?? data.subtype ?? "unknown error");
    const hint = /log ?in|auth|credential|401/i.test(msg) ? " (run `claude` and use /login to sign in)" : "";
    throw new Error(`Claude Code: ${msg}${hint}`);
  }
  const u = data.usage ?? {};
  return {
    text: String(data.result ?? "").trim(),
    model: Object.keys(data.modelUsage ?? {})[0] ?? bot.model,
    apiValue: data.total_cost_usd ?? 0,
    note: data.stop_reason === "max_tokens" ? "reply cut off" : undefined,
    usage: {
      input: u.input_tokens ?? 0,
      cachedInput: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      output: u.output_tokens ?? 0,
    },
  };
}

// ---------- Canned replies (no keys, no network, no cost) ----------
// Used for the per-account "local" provider (always on, even in production)
// and for global BOT_HUB_MOCK=1 (tests / `npm run mock`).
const MOCK_LINES = [
  "Interesting point - I'd push on that a bit more.",
  "I agree in part, but the numbers don't quite add up for me.",
  "Let me summarize where we are so far.",
  "Here's another angle worth considering.",
  "Good question. Short answer: it depends on the constraints.",
];
async function callLocal(bot, account, transcript, { mocked = false } = {}) {
  await new Promise((r) => setTimeout(r, 300 + Math.random() * 500));
  const chars = transcript.reduce((n, m) => n + m.text.length, 0);
  return {
    text: `${MOCK_LINES[Math.floor(Math.random() * MOCK_LINES.length)]}`,
    model: mocked ? `${bot.model} (mock)` : bot.model,
    usage: {
      input: Math.round(chars / 4) + 120,
      cachedInput: Math.round(chars / 8),
      cacheWrite: 0,
      output: 40 + Math.floor(Math.random() * 160),
    },
  };
}

export async function callBot(bot, account, transcript, participants, { direct = false } = {}) {
  const ctx = { direct, system: systemPrompt(bot, participants, direct) };
  if (isMock()) return callLocal(bot, account, transcript, { mocked: true });
  switch (account.provider) {
    case "local":
      return callLocal(bot, account, transcript);
    case "xai":
      return callXai(bot, account, transcript, ctx);
    case "anthropic":
      return callAnthropic(bot, account, transcript, ctx);
    case "claude-code":
      return callClaudeCode(bot, account, transcript, ctx);
    default:
      throw new Error(`Unknown provider "${account.provider}" on account "${account.id}"`);
  }
}

/**
 * Estimated API list-price USD of one request. If pricing.longContext is set and
 * the request's prompt (input + cached input) reaches its thresholdTokens, every
 * token in the request is billed at the long-context rates (xAI behaviour).
 */
export function listPrice(usage, pricing = {}, account) {
  if (account?.provider === "local") return 0; // canned replies have no list price
  const lc = pricing.longContext;
  const prompt = (usage.input ?? 0) + (usage.cachedInput ?? 0);
  const p = lc && prompt >= (lc.thresholdTokens ?? 200_000) ? { ...pricing, ...lc } : pricing;
  const per = (n, rate) => ((n ?? 0) * (rate ?? 0)) / 1e6;
  return (
    per(usage.input, p.inputPerM) +
    per(usage.output, p.outputPerM) +
    per(usage.cachedInput, p.cachedInputPerM ?? p.inputPerM) +
    per(usage.cacheWrite, p.cacheWritePerM ?? p.inputPerM)
  );
}

/** What a call actually costs you: nothing extra for calls covered by your plan. */
export function costOf(usage, account) {
  return isPlan(account) ? 0 : listPrice(usage, account.pricing, account);
}
