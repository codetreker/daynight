import { spawnSync } from "node:child_process";

const result = spawnSync("python3", ["-u", "test/acceptance/shell-completion.py"], {
  stdio: "inherit",
  timeout: 600_000,
});
if (result.error !== undefined) throw result.error;
if (result.signal !== null) throw new Error(`Shell completion acceptance stopped with ${result.signal}.`);
process.exitCode = result.status!;
