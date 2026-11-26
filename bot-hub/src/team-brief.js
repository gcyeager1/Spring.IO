// Team Brief: shared team notes sent with every real-agent webhook as `team_brief`.
// Plain text at DATA_DIR/team-brief.txt (mode 0600). Line 1 is always the hub rule, line 2 the handoff rule.
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./config.js";

export const TEAM_BRIEF_RULE =
  "BOT HUB RULE: Use minimal usage here. Answer in 1-3 short sentences at the lowest effort. No tools, research, or long reasoning unless Garrett explicitly asks. Real work goes to your main chat, not the hub.";
export const TEAM_BRIEF_HANDOFF =
  "Only Asschub, Dummy and Claude can hand off by @mentioning a bot (max 3 handoffs per chain, then wait for Garrett).";
const PLACEHOLDER = "Team notes (roles, priorities, standing rules) go here.";
const MAX = 20000;

const file = () => path.join(dataDir(), "team-brief.txt");
const SEED = `${TEAM_BRIEF_RULE}\n${TEAM_BRIEF_HANDOFF}\n\n${PLACEHOLDER}\n`;

/** Make the rule line 1 and the handoff line line 2 (never duplicating either). Pure. */
export function withRule(text) {
  const t = String(text ?? "").replace(/^\uFEFF/, "");
  if (!t.trim()) return SEED;
  const lines = t.split("\n");
  const rest = lines.filter((l) => l.trim() !== TEAM_BRIEF_RULE && l.trim() !== TEAM_BRIEF_HANDOFF);
  // Any other copy of either line is dropped, so each appears exactly once, in place.
  return [TEAM_BRIEF_RULE, TEAM_BRIEF_HANDOFF, ...rest].join("\n");
}

function write(text) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), text, { mode: 0o600 });
  fs.chmodSync(file(), 0o600);
}

/** Seed a missing file, or put the rule + handoff lines first in an existing one. Returns the stored text. */
export function ensureTeamBrief() {
  let disk = null;
  try { disk = fs.readFileSync(file(), "utf8"); } catch {}
  const next = disk === null ? SEED : withRule(disk);
  if (next !== disk) write(next);
  return next;
}

/** Always read fresh from disk (ensures the rule first). */
export const readTeamBrief = () => ensureTeamBrief();

export function saveTeamBrief(text) {
  if (typeof text !== "string") return { error: "text must be a string" };
  if (text.length > MAX) return { error: `Team brief is too long (max ${MAX} characters)` };
  const stored = withRule(text);
  write(stored);
  return { text: stored };
}
