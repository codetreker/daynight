import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { observeValidation, runProbe } from "../../scripts/observe-native-validation.mjs";

const roots = [];
const directory = () => {
  const base = path.resolve(import.meta.dirname, "../../../../.tmp/native-validation-tests");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, "run-")); roots.push(root); return root;
};
const events = output => readFileSync(path.join(output, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
const successfulProbe = async () => ({ pid: null, code: 0, signal: null, stdout: "sample", stderr: "", error: null });

it.each([0, 7])("preserves child exit %s without recording arguments or environment", async code => {
  const output = directory();
  const result = await observeValidation({ output, command: [process.execPath, "-e", `process.exit(${code})`, "private-argument-marker"], probe: successfulProbe, platform: "darwin" });
  expect(result).toMatchObject({ code, signal: null, exitCode: code });
  expect(JSON.parse(readFileSync(path.join(output, "result.json"), "utf8"))).toMatchObject({ code, signal: null, exitCode: code });
  expect(readFileSync(path.join(output, "events.jsonl"), "utf8")).not.toContain("private-argument-marker");
  expect(events(output).map(event => event.kind)).toContain("observer-stopped");
});

it.skipIf(process.platform === "win32")("records a child's actual signal and returns its conventional failure code", async () => {
  const output = directory();
  const result = await observeValidation({ output, command: [process.execPath, "-e", "process.kill(process.pid, 'SIGKILL')"], probe: successfulProbe, platform: "darwin" });
  expect(result).toMatchObject({ code: null, signal: "SIGKILL", exitCode: 137 });
  expect(events(output).find(event => event.kind === "child-exit")).toMatchObject({ code: null, signal: "SIGKILL" });
});

it("retains the command result when observers fail and bounds probes independently", async () => {
  const output = directory(), calls = [];
  const result = await observeValidation({ output, command: [process.execPath, "-e", "process.exit(9)"], platform: "darwin",
    probe: async (file, args, options) => { calls.push({ file, args, timeoutMs: options.timeoutMs }); throw Object.assign(new Error("observer unavailable"), { code: "EACCES" }); } });
  expect(result.exitCode).toBe(9);
  expect(events(output).filter(event => event.kind === "observer-error").every(event => event.error.code === "EACCES")).toBe(true);
  expect(calls.find(call => call.file === "/bin/ps")).toMatchObject({ args: ["-axo", "pid=,ppid=,pgid=,rss=,etime="], timeoutMs: 2000 });
  expect(calls.find(call => call.file === "/usr/bin/log")?.timeoutMs).toBe(10000);
  expect(calls.some(call => call.file.includes("lsof"))).toBe(false);
});

it("cancels its in-flight sampler after child exit without overlapping or leaving a timer", async () => {
  const output = directory(); let active = 0, peak = 0, cancelled = 0, samples = 0;
  const probe = async (file, _args, { signal }) => {
    if (file === "/usr/bin/log") return successfulProbe();
    active++; samples++; peak = Math.max(peak, active);
    try { await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", resolve, { once: true }); }); cancelled++; return successfulProbe(); }
    finally { active--; }
  };
  const result = await observeValidation({ output, command: [process.execPath, "-e", "setTimeout(() => process.exit(0), 30)"], probe, platform: "darwin", processIntervalMs: 5 });
  expect(result.exitCode).toBe(0); expect(active).toBe(0); expect(peak).toBe(1); expect(cancelled).toBe(1);
  const completedSamples = samples; await new Promise(resolve => setTimeout(resolve, 25)); expect(samples).toBe(completedSamples);
  expect(events(output).map(event => event.kind)).toContain("observer-stopped");
});

it("preserves child success when the evidence directory cannot be opened", async () => {
  const output = path.join(directory(), "parent");
  const { writeFileSync } = await import("node:fs"); writeFileSync(output, "not a directory");
  const result = await observeValidation({ output: path.join(output, "evidence"), command: [process.execPath, "-e", "process.exit(0)"], platform: "other" });
  expect(result.exitCode).toBe(0); expect(result.observerErrors).toBeGreaterThan(0);
});

it("terminates only an observer command at its short deadline", async () => {
  const result = await runProbe(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 100, signal: new AbortController().signal });
  expect(result.code).not.toBe(0); expect(result.requestedSignal).toBe("SIGKILL");
  expect(result.completionConfirmed).toBe(false);
  expect(result.error).not.toBeNull();
  await vi.waitFor(() => expect(() => process.kill(result.pid, 0)).toThrow());
});

it.skipIf(process.platform === "win32")("bounds a probe whose exited child leaves inherited output pipes open", async () => {
  const probe = runProbe("/bin/sh", ["-c", "/bin/sleep 1.2 & printf descendant-started"], { timeoutMs: 200, signal: new AbortController().signal });
  let timer;
  const bounded = await Promise.race([probe, new Promise(resolve => { timer = setTimeout(() => resolve("deadline-missed"), 600); })]);
  clearTimeout(timer);
  const result = await probe;
  // The fixture descendant exits by itself; the observer must not signal its group.
  await new Promise(resolve => setTimeout(resolve, 1250));
  expect(bounded).not.toBe("deadline-missed");
  expect(result.stdout, JSON.stringify(result)).toContain("descendant-started");
  expect(result.timedOut).toBe(true);
});


it("reports a command spawn failure without replacing it with observer success", async () => {
  const result = await observeValidation({ output: directory(), command: ["daynight-nonexistent-observer-test-command"], platform: "other" });
  expect(result).toMatchObject({ exitCode: 127, spawnError: { code: "ENOENT" } });
});
