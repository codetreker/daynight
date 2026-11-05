import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";

test.each(["reject", "disconnect", "timeout", "socket-close"])("compiled Copilot startup %s stops without teardown writes or orphan rejections", async mode => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/copilot-startup-cleanup");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  const child = spawn(process.execPath, ["--unhandled-rejections=strict", path.resolve(import.meta.dirname, "fixtures/copilot-startup-cleanup.mjs"), root, mode], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); }); child.stderr.on("data", chunk => { stderr += String(chunk); });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 40_000);
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
    });
    expect(result, stderr).toEqual({ code: 0, signal: null });
    expect(stdout).toContain("owned process exit confirmed");
    expect(stderr).toBe("");
  } finally { clearTimeout(timeout); await rm(root, { recursive: true, force: true }); }
}, 45_000);
