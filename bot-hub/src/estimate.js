import { costOf } from "./providers.js";
import { isPlan } from "./config.js";
import { getChat, getUsage, isDirect } from "./store.js";

// Rough token count: ~4 characters per token for English text. Real tokenizers
// differ by model, so treat every number here as an estimate.
const tokens = (chars) => Math.ceil(chars / 4);
const DEFAULT_OUTPUT_TOKENS = 250; // used until a bot has some reply history
const PROMPT_OVERHEAD_CHARS = 300; // group-chat instructions, role markers, etc.

/** Average output tokens of a bot's recent successful replies. */
function typicalOutput(botId) {
  const recent = [];
  const all = getUsage();
  for (let i = all.length - 1; i >= 0 && recent.length < 30; i--) {
    const u = all[i];
    if (u.bot === botId && u.ok && u.output > 0) recent.push(u.output);
  }
  return recent.length ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length) : DEFAULT_OUTPUT_TOKENS;
}

/**
 * Estimate what sending `text` to `room` will cost: every call each bot will
 * make (rounds x bots), with the transcript growing as each bot replies.
 */
export function estimateSend(cfg, { room, text, participants, rounds }) {
  const direct = isDirect(room);
  const bots = (direct ? [room.slice(3)] : participants)
    .map((id) => cfg.bots.find((b) => b.id === id))
    .filter(Boolean);
  const nRounds = direct ? 1 : Math.min(Math.max(Number(rounds) || 1, 1), 10);

  let contextChars = getChat(room)
    .filter((m) => !m.hidden)
    .reduce((n, m) => n + m.text.length + m.speaker.length + 6, 0);
  if (text) contextChars += text.length + 8;

  const perBot = Object.fromEntries(
    bots.map((b) => [b.id, { bot: b.id, plan: isPlan(cfg.accountsById.get(b.account)), calls: 0, input: 0, output: 0, cost: 0 }]),
  );
  const total = { calls: 0, planCalls: 0, input: 0, output: 0, cost: 0 };
  for (let r = 0; r < nRounds; r++) {
    for (const b of bots) {
      const account = cfg.accountsById.get(b.account);
      const input = tokens(b.systemPrompt.length + PROMPT_OVERHEAD_CHARS + contextChars);
      const output = typicalOutput(b.id);
      const cost = costOf({ input, output, cachedInput: 0, cacheWrite: 0 }, account);
      if (isPlan(account)) total.planCalls += 1;
      for (const acc of [perBot[b.id], total]) {
        acc.calls += 1;
        acc.input += input;
        acc.output += output;
        acc.cost += cost;
      }
      contextChars += output * 4 + b.name.length + 6; // the reply joins the transcript
    }
  }

  const spent = getUsage().reduce((n, u) => n + (u.cost ?? 0), 0);
  const budget = Number(cfg.budgetUSD) > 0 ? Number(cfg.budgetUSD) : null;
  return {
    message: { ...total, rounds: nRounds, perBot: Object.values(perBot) },
    project: {
      spent,
      calls: getUsage().length,
      after: spent + total.cost,
      budget,
    },
  };
}
