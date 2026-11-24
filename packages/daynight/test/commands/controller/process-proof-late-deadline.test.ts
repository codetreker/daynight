import { afterEach, beforeEach, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ exec: vi.fn(), read: vi.fn() }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), execFile: io.exec }));
vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>(), readFile: io.read }));
import { captureProcessProof, inspectProcessProof, isControllerProcessObservationDeadline } from "../../../src/commands/controller/process-proof.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const pid = 4101, parent = 4000, boot = "876b21c9-30d7-48c0-a2ab-287291e903a7";
const stat = (ticks = "26140755", ppid = parent, group = pid) => `${pid} (node) ${["S", ppid, group, 0, 0, 0, 0, ...Array(12).fill(0), ticks, 0, 0].join(" ")}\n`;
const ps = (ppid = parent, group = pid, command = "node worker.js") => `${pid} ${ppid} ${group} S Thu Nov 19 19:43:08 2026 ${command}\n`;
const paths = ["boot", "stat", "ps", "ps", "stat", "boot"];

beforeEach(() => {
  Object.defineProperty(process, "platform", { ...originalPlatform, value: "linux" });
  io.read.mockReset().mockImplementation(async (file: string) => file.endsWith("boot_id") ? `${boot}\n` : stat());
  io.exec.mockReset().mockImplementation((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, output: string) => void) => callback(null, ps()));
  vi.spyOn(process, "kill").mockReturnValue(true);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); Object.defineProperty(process, "platform", originalPlatform); });

function delayAt(index: number, replacement?: string): string[] {
  const calls: string[] = [];
  const sample = (kind: string, value: string): string => {
    const position = calls.length;
    calls.push(kind);
    if (position === index) { vi.advanceTimersByTime(100); return replacement ?? value; }
    return value;
  };
  io.read.mockImplementation(async (file: string) => file.endsWith("boot_id") ? sample("boot", `${boot}\n`) : sample("stat", stat()));
  io.exec.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, output: string) => void) => callback(null, sample("ps", ps())));
  return calls;
}

it.each([0, 1, 2, 3, 4, 5])("authenticates unchanged strict observation deadline evidence at sample %i", async index => {
  const proof = await captureProcessProof(pid);
  vi.useFakeTimers();
  const calls = delayAt(index);
  const error = await inspectProcessProof(proof, 100, { strictObservation: true }).catch(cause => cause);
  expect(calls).toEqual(paths.slice(0, index + 1));
  expect(isControllerProcessObservationDeadline(error)).toBe(true);
  error.cause = new Error("independent later failure");
  expect(isControllerProcessObservationDeadline(error)).toBe(false);
});

it.each([
  { index: 0, name: "boot", value: "187b21c9-30d7-48c0-a2ab-287291e903a7\n" },
  { index: 1, name: "birth", value: stat("26140756") },
  { index: 1, name: "parent", value: stat("26140755", parent + 1) },
  { index: 1, name: "group", value: stat("26140755", parent, pid + 1) },
  { index: 2, name: "first parent", value: ps(parent + 1) },
  { index: 2, name: "first group", value: ps(parent, pid + 1) },
  { index: 2, name: "first command", value: ps(parent, pid, "other command") },
  { index: 3, name: "second parent", value: ps(parent + 1) },
  { index: 3, name: "second group", value: ps(parent, pid + 1) },
  { index: 3, name: "second command", value: ps(parent, pid, "other command") },
  { index: 4, name: "final stat birth", value: stat("26140756") },
  { index: 4, name: "final stat parent", value: stat("26140755", parent + 1) },
  { index: 4, name: "final stat group", value: stat("26140755", parent, pid + 1) },
  { index: 5, name: "final boot", value: "187b21c9-30d7-48c0-a2ab-287291e903a7\n" },
])("preserves late $name conflict alongside the deadline", async ({ index, value }) => {
  const proof = await captureProcessProof(pid);
  vi.useFakeTimers();
  const calls = delayAt(index, value);
  const error = await inspectProcessProof(proof, 100, { strictObservation: true }).catch(cause => cause);
  expect(calls).toEqual(paths.slice(0, index + 1));
  expect(error).toBeInstanceOf(Error);
  expect(isControllerProcessObservationDeadline(error)).toBe(false);
  expect(error.message).toMatch(/identity|conflict/i);
  if (index < 5) {
    expect(error).toBeInstanceOf(AggregateError);
    expect(isControllerProcessObservationDeadline(error.errors[0])).toBe(true);
    expect(error.errors[1].message).toMatch(/conflict/i);
  }
});
