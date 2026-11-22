import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { CliContext } from "../../../src/cli/context.js";
import { runWorkerCommand } from "../../../src/commands/worker/index.js";
import { openLifecycleStore, readLifecycleSnapshot } from "../../../src/commands/worker/lifecycle-store.js";
import { LifecycleIpcUnknownError } from "../../../src/commands/worker/lifecycle-ipc.js";
import { runWorkerLifecycleCommand, type WorkerLifecycleCommandDependencies } from "../../../src/commands/worker/lifecycle-command.js";

const identity = { serverOrigin: "http://localhost:8787", userId: "11111111-1111-4111-8111-111111111111", workerId: "22222222-2222-4222-8222-222222222222" };
const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture = () => {
  const directory = path.resolve(import.meta.dirname, "../../../../../.tmp/lifecycle-command-tests"); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(path.join(directory, "case-")); roots.push(root);
  const stateDirectory = path.join(root, "config"), workerDirectory = path.join(stateDirectory, "worker"), file = path.join(workerDirectory, "lifecycle.sqlite");
  mkdirSync(workerDirectory, { recursive: true, mode: 0o700 }); writeFileSync(path.join(stateDirectory, "config.yml"), `serverUrl: ${identity.serverOrigin}\n`, { mode: 0o600 });
  vi.stubEnv("DN_CONFIG_DIR", stateDirectory);
  const store = openLifecycleStore({ file, identity, allowCreate: true }); store.close();
  const output: string[] = [], errors: string[] = [];
  const context: CliContext = { version: "1", packageDirectory: root, homeDirectory: () => root, workingDirectory: () => { throw new Error("No repository discovery is allowed."); }, stdout: text => { output.push(text); }, stderr: text => { errors.push(text); }, stdoutBytes: async () => {} };
  const stop = () => { const store = openLifecycleStore({ file, identity }); try { const state = store.readState(); store.markStopped({ localEpoch: state.localEpoch, inventoryRevision: state.inventoryRevision }); } finally { store.close(); } };
  return { root, file, context, output, stop, read: () => readLifecycleSnapshot({ file, identity }) };
};

describe("local lifecycle command boundaries", () => {
  it.each([
    ["disable", "--worker-id", identity.workerId, "--confirm", "--json"],
    ["disable", "--worker-id", identity.workerId, "--local", "--json"],
    ["resume", "--worker-id", identity.workerId, "--local", "--confirm", "--json"],
    ["lifecycle", "show", "--worker-id", identity.workerId, "--json"],
    ["disable", "--worker-id", identity.workerId, "--local", "--confirm", "--json", "--project", identity.userId],
  ])("rejects missing local/confirmation or remote selector flags: %j", async (...args) => {
    const context = { stdout: () => {}, homeDirectory: () => { throw new Error("Should reject arguments before reading state."); } } as unknown as CliContext;
    await expect(runWorkerCommand(args, context)).rejects.toMatchObject({ name: "UsageError" });
  });
  it("shows the existing private state without network, manager, or repository access", async () => {
    const f = fixture(), fetch = vi.fn().mockRejectedValue(new Error("Network forbidden")); vi.stubGlobal("fetch", fetch);
    try {
      await runWorkerCommand(["lifecycle", "show", "--worker-id", identity.workerId, "--local", "--json"], f.context);
      expect(JSON.parse(f.output[0]!)).toMatchObject({ protocolVersion: 1, workerId: identity.workerId, localEpoch: "1", phase: "disabling", resources: [] });
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it("persists the local veto before waking the manager and requires actual stop evidence", async () => {
    const f = fixture(), manage = vi.fn();
    const request = vi.fn(async () => { expect(f.read().state).toMatchObject({ localVeto: true, admission: "closed", localEpoch: "2", phase: "disabling" }); f.stop(); });
    await runWorkerLifecycleCommand({ kind: "disable", workerId: identity.workerId }, f.context, { request, manage });
    expect(request).toHaveBeenCalledOnce(); expect(manage).not.toHaveBeenCalled();
    expect(JSON.parse(f.output[0]!)).toMatchObject({ outcome: "confirmed", phase: "disabled", stop: "confirmed", save: "durable" });
  });
  it("uses management-only recovery only after a definite unsent IPC failure", async () => {
    const f = fixture(), request = vi.fn(async () => { throw Object.assign(new Error("No manager descriptor"), { code: "ENOENT" }); });
    const manage = vi.fn<WorkerLifecycleCommandDependencies["manage"]>(async () => { f.stop(); });
    await runWorkerLifecycleCommand({ kind: "disable", workerId: identity.workerId }, f.context, { request, manage });
    expect(manage).toHaveBeenCalledOnce();
    expect(manage.mock.calls[0]![0]).toMatchObject({ kind: "disable", workerId: identity.workerId });
  });
  it("never retries a possibly delivered resume and returns pending at the command bound", async () => {
    const f = fixture(); f.stop();
    vi.useFakeTimers(); let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
    let started!: () => void; const dispatched = new Promise<void>(resolve => { started = resolve; });
    const request = vi.fn(async () => { started(); throw new LifecycleIpcUnknownError("Response lost"); }), manage = vi.fn();
    const result = runWorkerLifecycleCommand({ kind: "resume", workerId: identity.workerId }, f.context, { request, manage });
    const rejection = expect(result).rejects.toMatchObject({ exitCode: 3 });
    await dispatched; await Promise.resolve(); now = 90_001; await vi.advanceTimersByTimeAsync(1000); await rejection;
    expect(request).toHaveBeenCalledOnce(); expect(manage).not.toHaveBeenCalled();
    expect(JSON.parse(f.output[0]!)).toMatchObject({ outcome: "pending", phase: "disabled" });
  });
  it("confirms the exact activation receipt after a management-only process closes its transient admission", async () => {
    const f = fixture();
    const request: WorkerLifecycleCommandDependencies["request"] = async options => {
      const store = openLifecycleStore({ file: f.file, identity });
      try {
        store.bindInstance({ instanceId: identity.userId, instanceEpoch: "1", intentVersion: "2", desired: "enabled" });
        const state = store.readState(); store.markStopped({ localEpoch: state.localEpoch, inventoryRevision: state.inventoryRevision });
        const activation = { binding: { ...identity, instanceId: identity.userId, instanceEpoch: "1", intentVersion: "2", localEpoch: state.localEpoch, scopeGeneration: "2" }, operationId: options.operationId!, action: "resume" as const };
        store.prepareActivation(activation);
        store.commitActivation({ ...activation, receipt: { protocolVersion: 1, workerId: identity.workerId, operationId: activation.operationId,
          action: "resume", instanceEpoch: "1", intentVersion: "2", localEpoch: state.localEpoch, scopeGeneration: "2", admission: "open" } });
        store.closeForRestart();
      } finally { store.close(); }
    };
    await runWorkerLifecycleCommand({ kind: "resume", workerId: identity.workerId }, f.context, { request, manage: vi.fn() });
    expect(f.read().state.admission).toBe("closed");
    expect(JSON.parse(f.output[0]!)).toMatchObject({ outcome: "confirmed", phase: "accepting" });
  });
  it("refuses another Worker without creating a replacement identity", async () => {
    const f = fixture(), request = vi.fn(), manage = vi.fn();
    await expect(runWorkerLifecycleCommand({ kind: "disable", workerId: identity.userId }, f.context, { request, manage })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled(); expect(manage).not.toHaveBeenCalled(); expect(f.read().state.localEpoch).toBe("1");
  });
});
