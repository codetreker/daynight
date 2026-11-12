import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), execFile: f.exec }));
import { inspectBootstrapProcessProof, inspectProcessProof, confirmControllerProcessesStopped } from "../../../src/commands/controller/process-proof.js";
import { stopControllerBootstrap } from "../../../src/commands/controller/launch-observation.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const proof = { pid: 4101, parentPid: 4000, processGroupId: 4101, startedAt: "Thu Nov 12 15:53:09 2026", commandHash: createHash("sha256").update("node main.js").digest("hex") };
const exiting = "4101 4000 4101 ?Es Thu Nov 12 15:53:09 2026 (node)\n";
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); Object.defineProperty(process, "platform", platform); });

it("waits through Darwin's exiting state without signaling incomplete identity or claiming a full tree stopped", async () => {
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  vi.useFakeTimers();
  let probes = 0;
  const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (signal !== 0) throw new Error("An exiting process cannot be signaled.");
    if (++probes >= 5) throw Object.assign(new Error("Gone"), { code: "ESRCH" });
    return true;
  });
  f.exec.mockImplementation((_file, _args, _options, callback) => callback(null, exiting));
  expect(await inspectBootstrapProcessProof(proof)).toBe("exiting");
  await expect(inspectProcessProof(proof)).rejects.toThrow(/exiting/);
  expect(await confirmControllerProcessesStopped(proof, [])).toBe(false);
  const stopped = stopControllerBootstrap(proof, Date.now() + 5000);
  await vi.runAllTimersAsync(); await stopped;
  expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});

it.each([
  ["group", "4101 4000 9999 S Thu Nov 12 15:53:09 2026 replacement\n", '"sameParent":true,"sameGroup":false'],
  ["parent", "4101 1 4101 S Thu Nov 12 15:53:09 2026 replacement\n", '"sameParent":false,"sameGroup":true'],
])("rejects a conflicting %s without signaling", async (_field, row, detail) => {
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  f.exec.mockImplementation((_file, _args, _options, callback) => callback(null, row));
  await expect(stopControllerBootstrap(proof, Date.now() + 5000)).rejects.toThrow(detail);
  expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});


it("classifies a reparented original zombie without claiming its live group has stopped", async () => {
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  f.exec.mockImplementation((_file, args, _options, callback) => callback(null, args.includes("-A")
    ? "4102 4101 S\n" : "4101 1 4101 Z Thu Nov 12 15:53:09 2026 (node)\n"));
  expect(await inspectBootstrapProcessProof(proof)).toBe("stopped");
  await stopControllerBootstrap(proof, Date.now() + 5000);
  expect(await confirmControllerProcessesStopped(proof, [])).toBe(false);
  expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});

it.each([
  ["birth", "4101 1 4101 Z Thu Nov 12 15:53:10 2026 (node)\n"],
  ["group", "4101 1 9999 Z Thu Nov 12 15:53:09 2026 (node)\n"],
])("does not infer zombie exit when the original %s differs", async (_field, row) => {
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  vi.spyOn(process, "kill").mockReturnValue(true);
  f.exec.mockImplementation((_file, _args, _options, callback) => callback(null, row));
  expect(await inspectBootstrapProcessProof(proof)).toBe("replaced");
});


it("waits for a same-birth command conflict to exit without sending a signal", async () => {
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" }); vi.useFakeTimers();
  let probes = 0;
  const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (signal !== 0) throw new Error("Cannot signal uncertain identity.");
    if (++probes === 4) throw Object.assign(new Error("Gone"), { code: "ESRCH" });
    return true;
  });
  f.exec.mockImplementation((_file, _args, _options, callback) => callback(null, "4101 4000 4101 R<s Thu Nov 12 15:53:09 2026 changed\n"));
  const result = stopControllerBootstrap(proof, Date.now() + 500);
  await vi.runAllTimersAsync(); await result;
  expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});

it("exposes deadline and retained identity conflict when uncertainty persists", async () => {
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" }); vi.useFakeTimers();
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  f.exec.mockImplementation((_file, _args, _options, callback) => callback(null, "4101 4000 4101 R<s Thu Nov 12 15:53:09 2026 changed\n"));
  const result = stopControllerBootstrap(proof, Date.now() + 100).catch(error => error);
  await vi.runAllTimersAsync();
  const error = await result; expect(error.message).toMatch(/deadline/); expect(error.cause.message).toMatch(/identity conflicts/);
  expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});

it("sends TERM only after the full original identity is restored", async () => {
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" }); vi.useFakeTimers();
  let rows = 0, signaled = false;
  const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (signal === "SIGTERM") { signaled = true; return true; }
    if (signaled) throw Object.assign(new Error("Gone"), { code: "ESRCH" });
    return true;
  });
  f.exec.mockImplementation((_file, _args, _options, callback) => callback(null, `4101 4000 4101 R<s Thu Nov 12 15:53:09 2026 ${++rows === 1 ? "changed" : "node main.js"}\n`));
  const result = stopControllerBootstrap(proof, Date.now() + 500);
  await vi.runAllTimersAsync(); await result;
  expect(kill.mock.calls.map(([, signal]) => signal)).toEqual([0, 0, "SIGTERM", 0]);
});

it("propagates process observation failures while waiting on uncertain identity", async () => {
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" }); vi.useFakeTimers();
  const failure = Object.assign(new Error("ps access denied"), { code: "EACCES" });
  const kill = vi.spyOn(process, "kill").mockReturnValue(true); let rows = 0;
  f.exec.mockImplementation((_file, _args, _options, callback) => ++rows === 1 ? callback(null, "4101 4000 4101 R<s Thu Nov 12 15:53:09 2026 changed\n") : callback(failure, ""));
  const result = stopControllerBootstrap(proof, Date.now() + 500).catch(error => error);
  await vi.runAllTimersAsync(); const error = await result;
  expect(error).toBeInstanceOf(AggregateError); expect(error.errors[0].message).toMatch(/identity conflicts/);
  expect(error.errors[1]).toBe(failure); expect(error.cause).toBe(failure);
  expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});

it("retains both the original identity conflict and a process timeout at the deadline", async () => {
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" }); vi.useFakeTimers();
  const deadline = Date.now() + 100, failure = new Error("ps timed out"); let rows = 0;
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  f.exec.mockImplementation((_file, _args, _options, callback) => {
    if (++rows === 1) callback(null, "4101 4000 4101 R<s Thu Nov 12 15:53:09 2026 changed\n");
    else { vi.setSystemTime(deadline); callback(failure, ""); }
  });
  const result = stopControllerBootstrap(proof, deadline).catch(error => error);
  await vi.runAllTimersAsync(); const error = await result;
  expect(error).toBeInstanceOf(AggregateError); expect(error.message).toMatch(/deadline/);
  expect(error.errors[0].message).toMatch(/identity conflicts/); expect(error.errors[1]).toBe(failure); expect(error.cause).toBe(failure);
  expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});

it("preserves a process observation error before any identity conflict", async () => {
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  const failure = new Error("ps access denied"); vi.spyOn(process, "kill").mockReturnValue(true);
  f.exec.mockImplementation((_file, _args, _options, callback) => callback(failure, ""));
  await expect(stopControllerBootstrap(proof, Date.now() + 5000)).rejects.toBe(failure);
});


it("retains the first successful identity conflict observed after the deadline", async () => {
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" }); vi.useFakeTimers();
  const deadline = Date.now() + 100, kill = vi.spyOn(process, "kill").mockReturnValue(true);
  f.exec.mockImplementation((_file, _args, _options, callback) => {
    vi.setSystemTime(deadline); callback(null, "4101 4000 4101 R<s Thu Nov 12 15:53:09 2026 changed\n");
  });
  const error = await stopControllerBootstrap(proof, deadline).catch(error => error);
  expect(error.message).toMatch(/deadline/); expect(error.cause.message).toMatch(/identity conflicts/);
  expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});
