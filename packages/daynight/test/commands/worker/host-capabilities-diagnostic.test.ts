import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { HerdrCommandCleanupError, HerdrCommandDeadlineError, type HerdrSpawn } from "../../../src/commands/worker/herdr/command.js";
import { createHostProbeDiagnostic, hostProbeError } from "./host-capabilities-diagnostic.js";

const child = () => Object.assign(new EventEmitter(), { pid: 4321 }) as unknown as ChildProcess;

describe("native host cleanup failure diagnostics", () => {
  it("forwards the unchanged spawn and records command identity and event order without private data", () => {
    const process = child(), spawn = vi.fn<HerdrSpawn>(() => process);
    let now = 100;
    const diagnostic = createHostProbeDiagnostic(spawn, () => now);
    const args = ["--no-auto-update", "--version"];
    const options: SpawnOptions = { cwd: "/private/canary-directory", env: { SECRET: "canary-secret" }, detached: true, stdio: ["ignore", "pipe", "pipe"] };
    expect(diagnostic.start("C:\\private\\copilot.exe", args, options)).toBe(process);
    expect(spawn).toHaveBeenCalledWith("C:\\private\\copilot.exe", args, options);
    now = 101; process.emit("spawn");
    now = 102; process.emit("exit", 1, null);
    now = 104; process.emit("close", 1, null);
    const result = diagnostic.snapshot([]);
    expect(result.probes).toEqual([{ executable: "copilot.exe", args, events: [
      { kind: "created", elapsedMs: 0, pid: 4321 }, { kind: "spawn", elapsedMs: 1, pid: 4321 },
      { kind: "exit", elapsedMs: 2, pid: 4321, code: 1, signal: null }, { kind: "close", elapsedMs: 4, pid: 4321, code: 1, signal: null },
    ] }]);
    expect(JSON.stringify(result)).not.toContain("canary");
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("preserves synchronous launch failure and records only structured error fields", () => {
    const error = Object.assign(new Error("canary stderr"), { code: "ENOENT", stdout: "canary output", environment: "canary environment" });
    const diagnostic = createHostProbeDiagnostic(() => { throw error; }, () => 10);
    expect(() => diagnostic.start("copilot.exe", ["--version", "canary-argument"], {})).toThrow(error);
    const result = diagnostic.snapshot([]);
    expect(result.probes[0]!.args).toEqual(["--version", "unrecorded"]);
    expect(result.probes[0]!.events).toEqual([{ kind: "spawn-error", pid: null, elapsedMs: 0, error: { name: "Error", code: "ENOENT" } }]);
    expect(JSON.stringify(result)).not.toContain("canary");
  });

  it.each([false, true])("attempts one removal and preserves its original EBUSY even when output fails=%s", async outputFails => {
    const diagnostic = createHostProbeDiagnostic(() => child(), () => 100);
    const error = Object.assign(new Error("canary path"), { code: "EBUSY" });
    const remove = vi.fn(async () => { throw error; });
    const issue = new HerdrCommandCleanupError([new Error("canary child content")], new HerdrCommandDeadlineError());
    let written = "";
    const emit = vi.fn((text: string) => { written = text; if (outputFails) throw new Error("output unavailable"); });
    await expect(diagnostic.cleanup(remove, [{ provider: "copilot", reason: "unavailable", error: issue }], emit)).rejects.toBe(error);
    expect(remove).toHaveBeenCalledOnce(); expect(emit).toHaveBeenCalledOnce();
    expect(JSON.parse(written)).toMatchObject({ kind: "assistant_host_cleanup_failure", cleanupError: { name: "Error", code: "EBUSY" },
      issues: [{ provider: "copilot", reason: "unavailable", cleanupFailure: true, cleanupUnconfirmed: true,
        error: { name: "HerdrCommandCleanupError", cause: { name: "HerdrCommandDeadlineError" }, errors: [{ name: "Error" }] } }] });
    expect(written).not.toContain("canary");
  });

  it("does not emit diagnostics or repeat a successful removal", async () => {
    const diagnostic = createHostProbeDiagnostic(() => child());
    const remove = vi.fn(async () => {}), emit = vi.fn();
    await diagnostic.cleanup(remove, [], emit);
    expect(remove).toHaveBeenCalledOnce(); expect(emit).not.toHaveBeenCalled();
  });

  it("bounds error structure and probe retention while forwarding every launch", () => {
    const root = new Error("canary"); root.cause = root;
    expect(hostProbeError(root)).toEqual({ name: "Error", cause: { circular: true } });
    let deep: Error = root;
    for (let index = 0; index < 30; index++) deep = new AggregateError(Array.from({ length: 20 }, () => deep), "canary");
    const summary = JSON.stringify(hostProbeError(deep));
    expect(summary).toContain("truncated"); expect(summary.length).toBeLessThan(4000); expect(summary).not.toContain("canary");
    const spawn = vi.fn<HerdrSpawn>(() => child()), diagnostic = createHostProbeDiagnostic(spawn);
    for (let index = 0; index < 8; index++) diagnostic.start("copilot.exe", Array.from({ length: 20 }, () => "--version"), {});
    expect(spawn).toHaveBeenCalledTimes(8);
    expect(diagnostic.snapshot([]).probes).toHaveLength(6);
    expect(diagnostic.snapshot([]).truncated).toBe(true);
    expect(diagnostic.snapshot([]).probes.every(probe => probe.args.length === 16)).toBe(true);
    expect(diagnostic.snapshot([{ provider: "copilot", reason: "timeout", error: deep }]).issues[0]).toMatchObject({
      cleanupFailure: null, cleanupUnconfirmed: null, cleanupClassificationIncomplete: true,
    });
  });
});
