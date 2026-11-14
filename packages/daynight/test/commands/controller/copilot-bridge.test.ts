import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";

test.each(["admission-revoked", "admission-close", "normal", "read-authority", "graceful-shutdown", "no-media", "capture-failure", "open-race", "kill-helper", "kill-native", "malformed"])("compiled Copilot bridge owns its single SDK connection and both processes: %s", async mode => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/copilot-bridge-check"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  const child = spawn(process.execPath, ["--unhandled-rejections=strict", path.resolve(import.meta.dirname, "fixtures/copilot-bridge-check.mjs"), root, mode], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); }); child.stderr.on("data", chunk => { stderr += String(chunk); });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 20_000);
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
    });
    expect(result, stderr).toEqual({ code: 0, signal: null }); expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({ mode, processesJoined: 2 });
  } finally { clearTimeout(timeout); await rm(root, { recursive: true, force: true }); }
}, 25_000);
