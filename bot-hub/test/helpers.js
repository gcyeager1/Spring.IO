import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/server.js");

/** Start the real server in mock mode on a random port with a temp DATA_DIR. */
export async function startServer(env = {}, seed) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bothub-test-"));
  if (seed) seed(dataDir);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [SERVER], {
    env: {
      PATH: process.env.PATH,
      BOT_HUB_MOCK: "1",
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      BOTHUB_SESSION_SECRET: "test-secret-test-secret-test-secret",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + "/api/health")).ok) break;
    } catch {}
    if (child.exitCode !== null) throw new Error("server exited: " + out);
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    base,
    dataDir,
    output: () => out,
    async stop() {
      child.kill();
      await new Promise((r) => child.once("exit", r));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export const postJson = (url, body, headers = {}) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), redirect: "manual" });

export const cookieOf = (res) => (res.headers.get("set-cookie") ?? "").split(";")[0];
