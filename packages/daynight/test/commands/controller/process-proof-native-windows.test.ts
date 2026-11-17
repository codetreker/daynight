import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { stopControllerBootstrap } from "../../../src/commands/controller/launch-observation.js";
import { captureProcessProof, inspectProcessProof, type ProcessProof } from "../../../src/commands/controller/process-proof.js";

type CimProcess = { ProcessId: number; ParentProcessId: number; Birth: string; CommandLine: string };
const decodeCimOracle = (stdout: string): CimProcess => {
  const envelope = stdout.trim(), bytes = Buffer.from(envelope, "base64");
  if (envelope.length === 0 || bytes.toString("base64") !== envelope) throw new Error("CIM oracle returned an invalid Base64 envelope.");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
};

// WMI is a format oracle only. A single isolated query gets its own allowance;
// neither production acquisition nor identity reinspection invokes this shell.
// Windows PowerShell's console code page can replace surrogate pairs with '?'.
// Transport explicit UTF-8 JSON in an ASCII Base64 envelope so the oracle keeps
// the complete command line independently of its console encoding.
const cimOracle = (pid: number): Promise<CimProcess> => new Promise((resolve, reject) => {
  const started = performance.now();
  const script = `$ErrorActionPreference='Stop';
[Console]::Error.WriteLine('DAYNIGHT_ORACLE:entry'); [Console]::Error.Flush();
$null=[System.Reflection.Assembly]::Load('System.Management, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a');
[Console]::Error.WriteLine('DAYNIGHT_ORACLE:assembly-complete'); [Console]::Error.Flush();
$searcher=[System.Management.ManagementObjectSearcher]::new('root\\cimv2','SELECT ProcessId,ParentProcessId,CreationDate,CommandLine FROM Win32_Process WHERE ProcessId=${pid}');
try {
  $collection=$searcher.Get();
  try {
[Console]::Error.WriteLine('DAYNIGHT_ORACLE:wmi-get-returned'); [Console]::Error.Flush();
    $iterator=$collection.GetEnumerator(); $count=0; $json=$null;
    try {
      while ($iterator.MoveNext()) {
        $row=$iterator.Current;
        try {
          $count++;
          $birth=[string]$row['CreationDate'];
          if ($birth -cnotmatch '^[0-9]{14}\\.[0-9]{6}[+-][0-9]{3}$') { throw 'The WMI birth is incomplete.' }
          $value=@{ ProcessId=[uint32]$row['ProcessId']; ParentProcessId=[uint32]$row['ParentProcessId']; Birth=[System.Management.ManagementDateTimeConverter]::ToDateTime($birth).ToUniversalTime().ToString('o'); CommandLine=[string]$row['CommandLine'] };
          $json=ConvertTo-Json -InputObject $value -Compress;
        } finally { ([System.IDisposable]$row).Dispose() }
      }
      if ($count -ne 1) { throw 'Expected exactly one process from WMI.' }
    } finally { ([System.IDisposable]$iterator).Dispose() }
  } finally { $collection.Dispose() }
} finally { $searcher.Dispose() }
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))`;
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: false, timeout: 60_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    if (error !== null) {
      try {
        console.error(JSON.stringify({ fixture: "windows-process-proof", stage: "cim-oracle-command", pid,
          elapsedMs: Math.round(performance.now() - started), code: error.code ?? null, signal: error.signal ?? null, killed: error.killed ?? null,
          stdout: stdout.slice(0, 2048), stdoutBytes: Buffer.byteLength(stdout), stdoutTruncated: stdout.length > 2048,
          stderr: stderr.slice(0, 2048), stderrBytes: Buffer.byteLength(stderr), stderrTruncated: stderr.length > 2048 }));
      } catch { /* Reporting must not replace the oracle command failure. */ }
      reject(error); return;
    }
    try { resolve(decodeCimOracle(stdout)); } catch (error) { reject(error); }
  });
});

test("keeps the oracle's complete Unicode command line through an ASCII console", () => {
  const command = 'node "quoted value" "two  spaces" 📖', json = JSON.stringify({ CommandLine: command });
  const console = (value: string) => value.replace(/[^\x00-\x7f]/g, "?");
  const envelope = Buffer.from(json, "utf8").toString("base64");
  const decoded = decodeCimOracle(console(envelope) + "\r\n").CommandLine;
  expect(decoded.length).toBe(command.length);
  expect(createHash("sha256").update(decoded).digest("hex")).toBe(createHash("sha256").update(command).digest("hex"));
  expect(decoded.codePointAt(decoded.length - 2)).toBe(0x1f4d6);
  expect(JSON.parse(console(json)).CommandLine.endsWith("??")).toBe(true);
});

test.each(["", "not base64", Buffer.from([0xff]).toString("base64")])("rejects a malformed oracle transport without replacing invalid bytes (%s)", value => {
  expect(() => decodeCimOracle(value)).toThrow();
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
    const commandHash = createHash("sha256").update(oracle.CommandLine).digest("hex");
    try {
      expect(parent).toEqual({ pid: oracle.ProcessId, parentPid: oracle.ParentProcessId, processGroupId: null, startedAt: oracle.Birth, commandHash });
      expect(oracle.CommandLine.includes("📖")).toBe(true); expect(oracle.CommandLine.includes("two  spaces")).toBe(true);
    } catch (error) {
      console.error(JSON.stringify({ fixture: "windows-process-proof", stage: "oracle-comparison", pid: parent.pid,
        nativeCommandHash: parent.commandHash, oracleCommandHash: commandHash, birthMatches: parent.startedAt === oracle.Birth,
        oracleUtf16Units: oracle.CommandLine.length, oracleUtf8Bytes: Buffer.byteLength(oracle.CommandLine, "utf8"),
        fixtureUnicodeRetained: oracle.CommandLine.includes("📖"), fixtureSpacingRetained: oracle.CommandLine.includes("two  spaces"), oracleEncoding: "base64(utf8)" }));
      throw error;
    }
    expect(stderr).toBe("");
  } finally {
    child.kill(); await closed;
  }
}, 90_000);


test.skipIf(process.platform !== "win32")("terminates and waits for the real bootstrap process without a Job proof", async () => {
  const child = spawn(process.execPath, ["-e", 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  const closed = once(child, "close");
  try {
    await once(child.stdout!, "data", { signal: AbortSignal.timeout(20_000) });
    const proof = await captureProcessProof(child.pid!);
    expect(proof.jobObjectName).toBeUndefined();
    const koffi = await import("koffi");
    const kernel = koffi.load("kernel32.dll");
    const current = kernel.func("void * __stdcall GetCurrentProcess()");
    const count = kernel.func("int __stdcall GetProcessHandleCount(void *process, void *count)");
    const handleCount = () => { const result = Buffer.alloc(4); if (count(current(), result) === 0) throw new Error("GetProcessHandleCount failed."); return result.readUInt32LE(); };
    await expect(stopControllerBootstrap(proof, Date.now() - 1)).rejects.toThrow(/deadline/);
    expect(await inspectProcessProof(proof)).toBe("running");
    const before = handleCount();
    for (let attempt = 0; attempt < 8; attempt++) await expect(stopControllerBootstrap({ ...proof, commandHash: "replacement" }, Date.now() + 15_000)).rejects.toThrow();
    expect(handleCount()).toBe(before);
    await expect(stopControllerBootstrap({ ...proof, commandHash: "replacement" }, Date.now() + 15_000)).rejects.toThrow();
    expect(await inspectProcessProof(proof)).toBe("running");
    const beforeStop = handleCount();
    await stopControllerBootstrap(proof, Date.now() + 15_000);
    expect(handleCount()).toBe(beforeStop);
    await closed;
    expect(await inspectProcessProof(proof)).toBe("stopped");
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; }
}, 60_000);
