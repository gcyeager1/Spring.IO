// Usage: npm run hash-password            (prompts, input hidden)
//        echo 'pw' | npm run --silent hash-password
import readline from "node:readline";
import { hashPassword } from "../src/auth.js";

async function readPassword() {
  if (!process.stdin.isTTY) {
    let s = "";
    for await (const c of process.stdin) s += c;
    return s.replace(/\r?\n$/, "");
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  rl._writeToOutput = (s) => { if (s.includes("Password")) process.stderr.write(s); };
  return new Promise((res) => rl.question("Password: ", (a) => { rl.close(); process.stderr.write("\n"); res(a); }));
}

const pw = await readPassword();
if (pw.length < 12) {
  console.error("Use at least 12 characters.");
  process.exit(1);
}
console.log(hashPassword(pw));
