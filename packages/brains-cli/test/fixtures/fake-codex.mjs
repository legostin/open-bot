// Fake `codex` CLI for tests: `--version`, `login status`, and `login --device-auth`, which prints the sign-in page and
// a one-time code the way Codex 0.164 does (colours included), then "signs in" (writes HOME/.codex/auth.json) and
// exits 0. The mode comes from FAKE_CODEX_LOGIN or the file HOME/.fake-codex-login: "ok" (default), "fail" or "hang".
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const home = process.env.HOME || homedir();
const auth = join(home, ".codex", "auth.json");

if (args[0] === "--version") {
  console.log("codex-cli 9.9.9");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  console.log(existsSync(auth) ? "Logged in using ChatGPT" : "Not logged in");
  process.exit(existsSync(auth) ? 0 : 1);
}
if (args[0] === "login" && args.includes("--device-auth")) {
  const modeFile = join(home, ".fake-codex-login");
  const mode = process.env.FAKE_CODEX_LOGIN || (existsSync(modeFile) ? readFileSync(modeFile, "utf8").trim() : "ok");
  const blue = (s) => `\x1b[94m${s}\x1b[0m`;
  const grey = (s) => `\x1b[90m${s}\x1b[0m`;
  process.stdout.write(
    `\nWelcome to Codex [v${grey("9.9.9")}]\n${grey("OpenAI's command-line coding agent")}\n\n` +
      "Follow these steps to sign in with ChatGPT using device code authorization:\n\n" +
      `1. Open this link in your browser and sign in to your account\n   ${blue("https://auth.openai.com/codex/device")}\n\n` +
      `2. Enter this one-time code ${grey("(expires in 15 minutes)")}\n   ${blue("ABCD-EFGHI")}\n\n` +
      `${grey("Continue only if you started this login in Codex. If a website or another person gave you this code, cancel.")}\n\n`,
  );
  if (mode === "hang") setInterval(() => {}, 1000);
  else
    setTimeout(() => {
      if (mode === "fail") {
        console.error("Error logging in: the device code was declined");
        process.exit(1);
      }
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(auth, "{}");
      console.log("Successfully logged in");
      process.exit(0);
    }, Number(process.env.FAKE_CODEX_DELAY_MS ?? 400));
} else {
  console.error(`fake codex: unsupported arguments ${args.join(" ")}`);
  process.exit(2);
}
