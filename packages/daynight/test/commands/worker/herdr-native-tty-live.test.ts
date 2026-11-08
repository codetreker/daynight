import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { readMacProcessTty, readMacTtySize } from "../../../src/commands/worker/herdr/native-tty.js";

describe.skipIf(process.platform !== "darwin")("macOS native PTY geometry", () => {
  it("agrees with independent OS commands on an owned PTY without changing its size", async () => {
    const { spawn } = await import("node-pty");
    const terminal = spawn("/bin/bash", ["--noprofile", "--norc", "-p", "-i"], { cols: 91, rows: 27, cwd: process.cwd(), env: { ...process.env, PS1: "READY> " } });
    const exited = new Promise<void>(resolve => terminal.onExit(() => resolve()));
    try {
      await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("The owned PTY did not initialize.")), 5_000); let output = ""; const subscription = terminal.onData(data => { output += data; if (!output.includes("READY> ")) return; clearTimeout(timer); subscription.dispose(); resolve(); }); });
      const signal = AbortSignal.timeout(5_000), tty = await readMacProcessTty(terminal.pid, signal);
      const run = promisify(execFile), ps = await run("/bin/ps", ["-p", String(terminal.pid), "-o", "tty="], { timeout: 2_000, encoding: "utf8" });
      expect(tty).toBe(`/dev/${ps.stdout.trim()}`);
      const before = await run("/bin/stty", ["-f", tty, "size"], { timeout: 2_000, encoding: "utf8" });
      expect(before.stdout.trim()).toBe("27 91");
      for (let index = 0; index < 8; index++) expect(await readMacTtySize(tty, signal)).toEqual({ width: 91, height: 27 });
      const after = await run("/bin/stty", ["-f", tty, "size"], { timeout: 2_000, encoding: "utf8" });
      expect(after.stdout).toBe(before.stdout);
    } finally { terminal.kill("SIGKILL"); await exited; }
  }, 10_000);
});
