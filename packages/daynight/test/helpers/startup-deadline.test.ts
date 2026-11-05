import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { captureStartupDeadline } from "./startup-deadline.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const requestLog = async (): Promise<string> => {
  const base = path.resolve(import.meta.dirname, "../../../../.tmp/startup-deadline");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-")); roots.push(root);
  return path.join(root, "requests.log");
};

test("startup expiry waits for native receipt, preserves callback arguments and leaves other timers alone", async () => {
  const log = await requestLog(), events: string[] = [];
  const schedule = globalThis.setTimeout, cancel = globalThis.clearTimeout;
  const deadline = captureStartupDeadline();
  const unrelated = setTimeout(() => events.push("unrelated"), 60_000);
  try {
    setTimeout((value: string) => events.push(value), 30_000, "expired");
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    const expiring = deadline.expireAfterRequest(log, requests => requests.includes("initialize"));
    expect(events).toEqual([]);
    await writeFile(log, "initialize\n");
    await expiring;
    expect(events).toEqual(["expired"]);
  } finally { clearTimeout(unrelated); deadline.restore(); }
  expect(globalThis.setTimeout).toBe(schedule);
  expect(globalThis.clearTimeout).toBe(cancel);
});

test("cleared startup timers cannot supply a deadline and an expired callback runs only once", async () => {
  const log = await requestLog(); await writeFile(log, "initialize\n");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const deadline = captureStartupDeadline(), callback = vi.fn();
  try {
    const cleared = setTimeout(callback, 30_000); clearTimeout(cleared);
    await expect(deadline.expireAfterRequest(log, requests => requests.includes("initialize"))).rejects.toThrow("Expected one pending 30000 ms");
    setTimeout(callback, 30_000);
    await deadline.expireAfterRequest(log, requests => requests.includes("initialize"));
    expect(callback).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(callback).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally { deadline.restore(); }
});

test("ambiguous startup deadlines fail without invoking either callback", async () => {
  const log = await requestLog(); await writeFile(log, "initialize\n");
  const deadline = captureStartupDeadline(), callback = vi.fn();
  const first = setTimeout(callback, 30_000), second = setTimeout(callback, 30_000);
  try {
    await expect(deadline.expireAfterRequest(log, requests => requests.includes("initialize"))).rejects.toThrow("Expected one pending 30000 ms");
    expect(callback).not.toHaveBeenCalled();
  } finally { clearTimeout(first); clearTimeout(second); deadline.restore(); }
});
