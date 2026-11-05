import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { captureProcessProof, inspectProcessProof, type ProcessProof } from "../../../src/commands/controller/process-proof.js";

// CIM is a format oracle only. A single isolated query gets its own allowance;
// neither production acquisition nor identity reinspection invokes this shell.
const cimOracle = (pid: number): Promise<{ ProcessId: number; ParentProcessId: number; Birth: string; CommandLine: string }> => new Promise((resolve, reject) => {
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object ProcessId,ParentProcessId,@{Name='Birth';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}},CommandLine | ConvertTo-Json -Compress`], { encoding: "utf8", windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error !== null) { reject(error); return; }
    try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
  });
});

test.skipIf(process.platform !== "win32")("captures one native child identity across self, parent, inspection and the persisted CIM format", async () => {
  const module = pathToFileURL(path.resolve(import.meta.dirname, "../../../dist/commands/controller/process-proof.js")).href;
  const script = `const { captureProcessProof } = await import(${JSON.stringify(module)}); const proof = await captureProcessProof(process.pid); process.send(proof); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, "quoted \"value\"", "two  spaces", "📖"], { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
  const closed = once(child, "close");
  let stderr = ""; child.stderr!.setEncoding("utf8"); child.stderr!.on("data", chunk => { stderr += chunk; });
  try {
    const [self] = await once(child, "message", { signal: AbortSignal.timeout(20_000) }) as [ProcessProof];
    expect(child.pid).toBeDefined();
    const parent = await captureProcessProof(child.pid!);
    expect(parent).toEqual(self);
    expect(parent.parentPid).toBe(process.pid);
    expect(await inspectProcessProof(parent)).toBe("running");
    const oracle = await cimOracle(child.pid!);
    expect(parent).toEqual({ pid: oracle.ProcessId, parentPid: oracle.ParentProcessId, processGroupId: null, startedAt: oracle.Birth, commandHash: createHash("sha256").update(oracle.CommandLine).digest("hex") });
    expect(oracle.CommandLine).toContain("📖"); expect(oracle.CommandLine).toContain("two  spaces");
    expect(stderr).toBe("");
  } finally {
    child.kill(); await closed;
  }
}, 90_000);
