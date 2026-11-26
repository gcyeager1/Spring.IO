import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./config.js";

const DATA = dataDir();
fs.mkdirSync(DATA, { recursive: true });
const LATEST = path.join(DATA, "plan-usage-latest.json");
const HISTORY = path.join(DATA, "plan-usage.jsonl");

let latest = { lifteasy: null, garrett: null };
try {
  latest = { ...latest, ...JSON.parse(fs.readFileSync(LATEST, "utf8")) };
} catch {}

export function savePlanUsage(report) {
  latest[report.account] = report;
  fs.writeFileSync(LATEST, JSON.stringify(latest));
  fs.appendFileSync(HISTORY, JSON.stringify(report) + "\n");
}

export const getPlanUsage = () => ({ lifteasy: latest.lifteasy ?? null, garrett: latest.garrett ?? null });
