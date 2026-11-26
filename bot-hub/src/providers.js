import Anthropic from "@anthropic-ai/sdk";
import { isMock } from "./config.js";

/**
 * Every provider gets the same input: the bot, its account, and the shared
 * transcript ([{speaker, botId|null, text}]). Each bot sees its own past
 * lines as "assistant" turns and everyone else's as "user" turns, prefixed
 * with the speaker's name so it can follow a multi-party chat.
 *
 * Every provider returns:
 *   { text, usage: { input, output, cachedInput, cacheWrite }, model, note? }
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

// ---------- Mock (no keys needed) ----------
const MOCK_LINES = [
  "Interesting point - I'd push on that a bit more.",
  "I agree in part, but the numbers don't quite add up for me.",
  "Let me summarize where we are so far.",
  "Here's another angle worth considering.",
  "Good question. Short answer: it depends on the constraints.",
];
async function callMock(bot, account, transcript) {
  await new Promise((r) => setTimeout(r, 300 + Math.random() * 500));
  const chars = transcript.reduce((n, m) => n + m.text.length, 0);
  return {
    text: `${MOCK_LINES[Math.floor(Math.random() * MOCK_LINES.length)]} (mock reply from ${bot.name})`,
    model: `${bot.model} (mock)`,
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
  if (isMock()) return callMock(bot, account, transcript);
  switch (account.provider) {
    case "xai":
      return callXai(bot, account, transcript, ctx);
    case "anthropic":
      return callAnthropic(bot, account, transcript, ctx);
    default:
      throw new Error(`Unknown provider "${account.provider}" on account "${account.id}"`);
  }
}

export function costOf(usage, pricing = {}) {
  const per = (n, p) => ((n ?? 0) * (p ?? 0)) / 1e6;
  return (
    per(usage.input, pricing.inputPerM) +
    per(usage.output, pricing.outputPerM) +
    per(usage.cachedInput, pricing.cachedInputPerM ?? pricing.inputPerM) +
    per(usage.cacheWrite, pricing.cacheWritePerM ?? pricing.inputPerM)
  );
}
