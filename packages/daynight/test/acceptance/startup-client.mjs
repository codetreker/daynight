import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const base = path.resolve(packageRoot, "../../.tmp/startup-http");
await mkdir(base, { recursive: true });
const directory = await mkdtemp(path.join(base, "case-"));
try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  input.serverUrl ??= input.serverOrigin;
  input.serverToken ??= input.token;
  const filename = path.join(directory, "input.json");
  await writeFile(filename, JSON.stringify(input), { mode: 0o600 });
  const run = spawnSync(process.execPath, [path.join(packageRoot, "node_modules/vitest/vitest.mjs"), "run",
    "test/commands/worker/startup-chain.test.ts", "-t", "startup HTTP acceptance"], {
    cwd: packageRoot, env: { ...process.env, DAYNIGHT_STARTUP_HTTP_INPUT: filename },
    encoding: "utf8", timeout: 90_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (run.error || run.status !== 0) {
    process.stderr.write((run.stdout ?? "") + (run.stderr ?? ""));
    throw new Error("Startup HTTP acceptance fixture failed.");
  }
  const result = JSON.parse(await readFile(path.join(directory, "result.json"), "utf8"));
  process.stdout.write(JSON.stringify(result.startupReport ? result : { startupReport: result }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
