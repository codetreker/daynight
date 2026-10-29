import { mkdir, mkdtemp, readFile, rm, statfs } from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import type { TaskPlatform, WorkerExecutableProbe, WorkerHerdrProbe } from "../../../src/api/types.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { createWorkerTelemetryCollector } from "../../../src/commands/worker/telemetry.js";

const platform = (): TaskPlatform => {
  if (process.platform === "linux") return "linux";
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  throw new Error("Native telemetry qualification requires a supported Worker platform.");
};
const versionSummary = (probe: WorkerExecutableProbe | WorkerHerdrProbe) => probe.state === "ok"
  ? { state: probe.state, version: probe.value }
  : probe.state === "error" ? { state: probe.state, code: probe.code } : { state: probe.state };

it("qualifies resource and pure software probes on the native operating system", async () => {
  const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "n-"));
  const operation = createOperation({ limits: { totalMs: 15_000, requestMs: 10_000 } });
  try {
    const startup = path.join(root, "cwd"); const home = path.join(root, "home");
    await Promise.all([mkdir(startup), mkdir(home)]);
    const manifest = JSON.parse(await readFile(path.resolve(import.meta.dirname, "../../../package.json"), "utf8")) as { version: string };
    const paths = { ...resolveWorkerPaths(home), herdrDirectory: path.join(root, "h"), logsDirectory: path.join(root, "l") };
    const collector = createWorkerTelemetryCollector({ paths, homeDirectory: home, version: manifest.version, workingDirectory: startup, machine: { id: "native-qualification", name: "Native qualification" }, platform: platform() });
    const began = performance.now();
    const { telemetry } = await collector.collect(operation);
    const elapsed = performance.now() - began;
    process.stdout.write(`${JSON.stringify({ kind: "worker_telemetry_native", platform: telemetry.platform,
      resources: { os: telemetry.os.state, cpu: telemetry.cpu.state, memory: telemetry.memory.state, disk: telemetry.disk.state },
      versions: { daynight: telemetry.versions.daynight, herdr: versionSummary(telemetry.versions.herdr), codex: versionSummary(telemetry.versions.codex), copilot: versionSummary(telemetry.versions.copilot) } })}\n`);
    expect(elapsed).toBeGreaterThanOrEqual(180); expect(elapsed).toBeLessThan(5_500);
    expect(telemetry.workingDirectory === startup).toBe(true);
    expect(telemetry.os.state).toBe("ok"); expect(telemetry.cpu.state).toBe("ok");
    expect(telemetry.memory.state).toBe("ok"); expect(telemetry.disk.state).toBe("ok");
    expect(telemetry.versions.herdr.state).toBe("not_running");
    if (telemetry.os.state === "ok") {
      expect(telemetry.os.value).toEqual({ type: os.type(), release: os.release(), version: os.version(), arch: os.arch() });
    }
    if (telemetry.cpu.state === "ok") {
      expect(telemetry.cpu.value.model === os.cpus()[0]!.model).toBe(true);
      expect(telemetry.cpu.value.logicalProcessors).toBe(os.cpus().length);
      expect(Number.isFinite(telemetry.cpu.value.usagePercent)).toBe(true);
      expect(telemetry.cpu.value.usagePercent).toBeGreaterThanOrEqual(0); expect(telemetry.cpu.value.usagePercent).toBeLessThanOrEqual(100);
    }
    if (telemetry.memory.state === "ok") {
      expect(telemetry.memory.value.totalBytes).toBe(os.totalmem());
      expect(Number.isSafeInteger(telemetry.memory.value.usedBytes)).toBe(true);
      expect(telemetry.memory.value.usedBytes).toBeGreaterThanOrEqual(0);
      expect(telemetry.memory.value.usedBytes).toBeLessThanOrEqual(telemetry.memory.value.totalBytes);
    }
    if (telemetry.disk.state === "ok") {
      const actual = await statfs(startup, { bigint: true });
      expect(telemetry.disk.value.totalBytes).toBe(Number(actual.blocks * actual.bsize));
      expect(Number.isSafeInteger(telemetry.disk.value.availableBytes)).toBe(true);
      expect(telemetry.disk.value.availableBytes).toBeGreaterThanOrEqual(0);
      expect(telemetry.disk.value.availableBytes).toBeLessThanOrEqual(telemetry.disk.value.totalBytes);
    }
    for (const probe of [telemetry.versions.codex, telemetry.versions.copilot]) {
      expect(["ok", "not_installed", "error"]).toContain(probe.state);
      expect(Number.isFinite(Date.parse(probe.checkedAt))).toBe(true);
      if (probe.state === "ok") expect(probe.value).toMatch(/^\d+\.\d+\.\d+$/);
      if (probe.state === "error") expect(["not_found", "permission_denied", "timeout", "command_failed", "invalid_output", "invalid_sample", "out_of_range", "io_error", "unavailable"]).toContain(probe.code);
    }
  } finally { operation.dispose(); await rm(root, { recursive: true, force: true }); }
}, 10_000);
