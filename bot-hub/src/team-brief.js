// Team Brief: shared team notes sent with every real-agent webhook as `team_brief`.
// Plain text at DATA_DIR/team-brief.txt (mode 0600). Line 1 is always the hub rule.
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./config.js";

export const TEAM_BRIEF_RULE =
  "BOT HUB RULE: Use minimal usage here. Answer in 1-3 short sentences at the lowest effort. No tools, research, or long reasoning unless Garrett explicitly asks. Real work goes to your main chat, not the hub.";
const PLACEHOLDER = "Team notes (roles, priorities, standing rules) go here.";
const MAX = 20000;

const file = () => path.join(dataDir(), "team-brief.txt");
const startsWithRule = (t) => t.split(/\r?\n/, 1)[0].trim() === TEAM_BRIEF_RULE;

/** Make sure the rule is line 1 (prepending, never duplicating). Pure. */
export function withRule(text) {
  const t = String(text ?? "").replace(/^﻿/, "");
  if (startsWithRule(t)) return t;
  return t.trim() ? `${TEAM_BRIEF_RULE}\n${t}` : `${TEAM_BRIEF_RULE}\n\n${PLACEHOLDER}\n`;
}

function write(text) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), text, { mode: 0o600 });
  fs.chmodSync(file(), 0o600);
}

/** Seed a missing file, or prepend the rule to an existing one. Returns the stored text. */
export function ensureTeamBrief() {
  let disk = null;
  try { disk = fs.readFileSync(file(), "utf8"); } catch {}
  const next = disk === null ? `${TEAM_BRIEF_RULE}\n\n${PLACEHOLDER}\n` : withRule(disk);
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
