import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { captureWindowsProcessInventory, readWindowsProcessMetadata } from "../../../src/commands/worker/herdr/windows-process-metadata.js";

test.skipIf(process.platform !== "win32")("matches a live isolated PS5 object's full executable and exact .NET birth, then observes its exit", async () => {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw new Error("The native metadata test requires Windows system PowerShell 5.");
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/herdr-tools/research-platform");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, "native-windows-metadata-"));
  const evidenceFile = path.join(base, `acceptance-windows-metadata-${randomUUID()}.json`);
  const environment: NodeJS.ProcessEnv = { SystemRoot: systemRoot, WINDIR: systemRoot, HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory, TEMP: directory, TMP: directory, PATH: "" };
  const executable = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // .NET observes its own retained Process object. No CIM, Get-Process, JSON
  // module, native module under test, or user profile supplies the oracle.
  const script = "$ErrorActionPreference='Stop'; $p=[Diagnostics.Process]::GetCurrentProcess(); $text=$p.Id.ToString()+\"`n\"+$p.MainModule.FileName+\"`n\"+$p.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture); [Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text))); [Console]::Out.Flush(); $null=[Console]::In.ReadLine()";
  const child = spawn(executable, ["-NoProfile", "-NoLogo", "-NonInteractive", "-Command", script], { env: environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let spawnFailure: unknown, streamFailure: unknown, stderrBytes = 0;
  child.once("error", error => { spawnFailure = error; });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  for (const stream of [child.stdin!, child.stdout!, child.stderr!]) stream.on("error", error => { streamFailure ??= error; });
  child.stderr!.on("data", (value: Buffer) => { stderrBytes += value.length; });
  const joinClosed = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([closed, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Native metadata test cleanup is unconfirmed; retained ${directory}.`)), 5000); })]); }
    finally { clearTimeout(timer); }
  };
  const operation = createOperation({ limits: { totalMs: 20_000, requestMs: 2000 } });
  const evidence = { schemaVersion: 1, source: "isolated-ps5-dotnet-oracle", platform: process.platform, pid: child.pid ?? null, startToken: null as string | null, directory, closed: false, runtimeDirectoryRemoved: false };
  let failure: unknown, failed = false;
  try {
    await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
    const oracle = await new Promise<string[]>((resolve, reject) => {
      let output = "", finished = false;
      const timer = setTimeout(() => reject(new Error("The isolated PS5 .NET metadata oracle did not become ready.")), 10_000);
      child.stdout!.setEncoding("ascii");
      child.stdout!.on("data", (value: string) => {
        if (finished) return;
        if (output.length + value.length > 64 * 1024) { finished = true; output = ""; clearTimeout(timer); reject(new Error("The isolated PS5 oracle exceeded its output bound.")); return; }
        output += value;
        if (!output.includes("\n")) return;
        finished = true;
        clearTimeout(timer);
        try {
          const envelope = output.trim(), bytes = Buffer.from(envelope, "base64");
          if (bytes.toString("base64") !== envelope) throw new Error("The isolated PS5 oracle returned an invalid envelope.");
          resolve(new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\n"));
        } catch (error) { reject(error); }
      });
      for (const stream of [child.stdin!, child.stdout!, child.stderr!]) stream.once("error", error => { finished = true; clearTimeout(timer); reject(error); });
      void closed.then(() => { clearTimeout(timer); reject(spawnFailure ?? new Error("The isolated PS5 oracle exited before readiness.")); });
    });
    expect(oracle).toHaveLength(3);
    expect(oracle[0]).toBe(String(child.pid)); expect(oracle[1]?.toLowerCase()).toBe(executable.toLowerCase());
    expect(oracle[2]).toMatch(/^\d+$/);
    evidence.startToken = oracle[2]!;
    await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
    expect(await readWindowsProcessMetadata(child.pid!, operation)).toEqual({ executable: oracle[1], startToken: oracle[2] });
    expect((await captureWindowsProcessInventory(operation)).find(row => row.pid === child.pid)).toEqual({ pid: child.pid, parentPid: process.pid, group: null });
    child.stdin!.end("\n");
    await joinClosed();
    if (streamFailure) throw streamFailure;
    await expect(readWindowsProcessMetadata(child.pid!, operation)).rejects.toThrow();
    expect((await captureWindowsProcessInventory(operation)).some(row => row.pid === child.pid)).toBe(false);
    expect(stderrBytes).toBe(0);
  } catch (error) { failed = true; failure = error; }
  operation.dispose();
  try {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await joinClosed();
    evidence.closed = true;
    await rm(directory, { recursive: true, force: true });
    evidence.runtimeDirectoryRemoved = true;
  } catch (error) {
    await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
    if (failed) throw new AggregateError([failure, error], "The native metadata test and cleanup failed.", { cause: failure });
    throw error;
  }
  await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  if (failed) throw failure;
}, 35_000);
