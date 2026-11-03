import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const mode = process.env.CODEX_CONFIG_TEST_MODE;
if (process.env.CODEX_CONFIG_TEST_PID) writeFileSync(process.env.CODEX_CONFIG_TEST_PID, String(process.pid));
const out = value => process.stdout.write(JSON.stringify(value) + "\n");
if (mode === "unresponsive") {
  setInterval(() => {}, 1000);
} else {
  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line);
    if (message.method === "initialize") out({ id: message.id, result: {} });
    else if (message.method === "initialized") continue;
    else if (message.method === "config/read") {
      if (mode === "excess") process.stderr.write("x".repeat(1024 * 1024 + 1));
      else if (mode === "error") out({ id: message.id, error: { code: -32602, message: "Fixture configuration is invalid." } });
      else out({ id: message.id, result: { config: { shell_environment_policy: { set: { PATH: "/native/bin" } } }, probe: { args: process.argv.slice(2), cwd: process.cwd(), params: message.params, pid: process.pid } } });
    } else throw new Error("Configuration inspection must not start an Agent session.");
  }
  if (mode === "ignore-eof") setInterval(() => {}, 1000);
}
