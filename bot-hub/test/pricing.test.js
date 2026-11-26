import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { costOf, listPrice } from "../src/providers.js";
import { hashPassword, verifyPassword } from "../src/auth.js";

const example = JSON.parse(fs.readFileSync(new URL("../config.example.json", import.meta.url), "utf8"));
const grokAcct = example.accounts.find((a) => a.id === "grok-1");
const grok = grokAcct.pricing;
const claudeAcct = example.accounts.find((a) => a.id === "claude");
const claude = claudeAcct.pricing;
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !== ${b}`);

test("example config uses grok-4.7 and the new prices", () => {
  for (const b of example.bots.filter((b) => b.account.startsWith("grok"))) assert.equal(b.model, "grok-4.7");
  assert.deepEqual({ ...grok, longContext: undefined }, { inputPerM: 2, cachedInputPerM: 0.5, outputPerM: 6, longContext: undefined });
  assert.deepEqual(grok.longContext, { thresholdTokens: 200000, inputPerM: 4, cachedInputPerM: 1, outputPerM: 12 });
  assert.equal(claudeAcct.provider, "claude-code");
  assert.equal(claudeAcct.apiKeyEnv, undefined);
  assert.equal(example.bots.find((b) => b.id === "claude").model, "default");
  assert.deepEqual(claude, { inputPerM: 4, outputPerM: 20, cachedInputPerM: 0.2, cacheWritePerM: 5 });
});

test("short-context pricing", () => {
  close(listPrice({ input: 100_000, cachedInput: 50_000, output: 1e6 }, grok), 0.2 + 0.025 + 6);
});

test("prompt just under the threshold stays on short rates", () => {
  close(listPrice({ input: 100_000, cachedInput: 99_999, output: 1e6 }, grok), 0.2 + 0.0499995 + 6);
});

test("prompt at the threshold bills ALL tokens at long rates", () => {
  // prompt = 150k input + 50k cached = 200k -> long rates for everything, output included
  close(listPrice({ input: 150_000, cachedInput: 50_000, output: 100_000 }, grok), 0.6 + 0.05 + 1.2);
});

test("output tokens alone never trigger long context", () => {
  close(listPrice({ input: 10, cachedInput: 0, output: 500_000 }, grok), (10 * 2) / 1e6 + 3);
});

test("pricing without longContext (Claude) is unchanged at any size", () => {
  close(listPrice({ input: 300_000, cachedInput: 100_000, cacheWrite: 100_000, output: 10_000 }, claude), 1.2 + 0.02 + 0.5 + 0.2);
});

test("costOf: plan-covered (claude-code) calls cost 0, but still have a list price", () => {
  const usage = { input: 300_000, cachedInput: 100_000, cacheWrite: 100_000, output: 10_000 };
  assert.equal(costOf(usage, claudeAcct), 0);
  close(listPrice(usage, claudeAcct.pricing), 1.2 + 0.02 + 0.5 + 0.2);
});

test("costOf: API accounts pay list price, long context included", () => {
  const usage = { input: 150_000, cachedInput: 50_000, output: 100_000 };
  close(costOf(usage, grokAcct), 0.6 + 0.05 + 1.2);
  close(costOf(usage, { ...claudeAcct, provider: "anthropic" }), listPrice(usage, claude));
});

test("scrypt hashes verify and are salted", () => {
  const h = hashPassword("correct horse battery");
  assert.ok(h.startsWith("scrypt$"));
  assert.ok(verifyPassword("correct horse battery", h));
  assert.ok(!verifyPassword("wrong", h));
  assert.notEqual(h, hashPassword("correct horse battery"));
  assert.ok(!verifyPassword("x", "garbage"));
});

test("accountProblem: mock mode is always ready; claude-code without CLI reports it", async () => {
  const { accountProblem } = await import("../src/config.js");
  const prev = process.env.BOT_HUB_MOCK;
  process.env.BOT_HUB_MOCK = "1";
  assert.equal(accountProblem(claudeAcct), null);
  process.env.BOT_HUB_MOCK = "0";
  assert.match(accountProblem({ ...claudeAcct, command: "definitely-not-a-real-cli" }), /not found/);
  if (prev === undefined) delete process.env.BOT_HUB_MOCK; else process.env.BOT_HUB_MOCK = prev;
});
