import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ spawn: vi.fn(), open: vi.fn(), read: vi.fn(), parse: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), spawn: f.spawn }));
vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>(), open: f.open }));
vi.mock("../../../src/commands/controller/lifecycle-store.js", () => ({ readWindowsJobSource: f.read }));
vi.mock("../../../src/commands/controller/windows-job-evidence.js", () => ({ parseWindowsJobSource: f.parse }));
import { startWindowsJobGuardian } from "../../../src/commands/controller/windows-job-launch.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const proof = { pid: 123, parentPid: 10, processGroupId: null, startedAt: "original", commandHash: "a".repeat(64) };
const source = { phase: "assigned", guardian: { pid: 456 }, controller: proof };
const ticket = { launchId: "00000000-0000-4000-8000-000000000001" };
class Child extends EventEmitter {
  pid = 456;
  connected = true;
  unref = vi.fn();
  disconnect = vi.fn(() => { this.connected = false; });
  send = vi.fn((_message: unknown, _callback: (error: Error | null) => void) => {});
}
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  vi.clearAllMocks(); f.parse.mockReturnValue(source); f.read.mockReturnValue(source);
});
afterEach(() => { vi.useRealTimers(); Object.defineProperty(process, "platform", platform); });

it("attaches failure listeners before sending and joins the local log close", async () => {
  const child = new Child(), failure = new Error("spawn failed"), close = vi.fn(async () => {});
  f.open.mockResolvedValue({ fd: 1, close }); f.spawn.mockReturnValue(child);
  child.send.mockImplementationOnce(() => { child.emit("error", failure); });
  await expect(startWindowsJobGuardian({ ticket: ticket as never, journalPath: "/state/journal.sqlite", controller: proof })).rejects.toBe(failure);
  expect(child.disconnect).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  expect(() => child.emit("error", new Error("late IPC error"))).not.toThrow();
});

it("leaves a lost startup outcome unconfirmed without killing the guardian", async () => {
  vi.useFakeTimers();
  const child = new Child(), close = vi.fn(async () => {});
  f.open.mockResolvedValue({ fd: 1, close }); f.spawn.mockReturnValue(child);
  const result = startWindowsJobGuardian({ ticket: ticket as never, journalPath: "/state/journal.sqlite", controller: proof }).catch(error => error);
  await vi.advanceTimersByTimeAsync(45_000);
  expect(await result).toMatchObject({ message: "Original Windows guardian startup is unconfirmed." });
  expect(child.disconnect).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  expect(child.listenerCount("exit")).toBe(0);
});

it("retains startup failure when local log close also fails", async () => {
  const child = new Child(), failure = new Error("spawn failed"), closeError = new Error("log close failed");
  f.open.mockResolvedValue({ fd: 1, close: vi.fn().mockRejectedValue(closeError) }); f.spawn.mockReturnValue(child);
  child.send.mockImplementationOnce(() => { child.emit("error", failure); });
  const error = await startWindowsJobGuardian({ ticket: ticket as never, journalPath: "/state/journal.sqlite", controller: proof }).catch(value => value);
  expect(error).toBeInstanceOf(AggregateError); expect(error.errors).toEqual([failure, closeError]);
});
