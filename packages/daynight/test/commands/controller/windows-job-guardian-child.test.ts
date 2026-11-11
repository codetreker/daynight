import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("reports a bootstrap failure over IPC without exposing input and exits", async () => {
  const entry = fileURLToPath(new URL("../../../dist/commands/controller/windows-job-guardian-child.js", import.meta.url));
  const child = spawn(process.execPath, [entry], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const exited = once(child, "exit");
  const join = () => Promise.race([exited, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Guardian did not exit.")), 10_000).unref())]);
  const message = once(child, "message", { signal: AbortSignal.timeout(10_000) });
  try {
    child.send("secret bootstrap input");
    const [result] = await message;
    expect(result).toEqual({ kind: "failed", message: "Guardian bootstrap failed (Error); see the private guardian log." });
    expect(JSON.stringify(result)).not.toContain("secret bootstrap input");
    expect(await join()).toEqual([1, null]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await join(); }
  }
}, 25_000);
