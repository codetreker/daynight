import { randomUUID } from "node:crypto";
import path from "node:path";
import { expect, test } from "vitest";
import { executePlatformCommand, platformErrorDetails } from "./herdr-platform-command.fixtures.js";
import { WindowsProcessProofError } from "../../../src/commands/controller/windows-process-proof.js";
import { MappingProcessProofAcquisitionError } from "../../../src/commands/worker/herdr/tool-launch-process-proof.js";

const failure = async (file: string, args: string[], timeout: number) => {
  const startedAt = performance.now();
  try { await executePlatformCommand(file, args, { timeout }); }
  catch (error) { return platformErrorDetails(error, performance.now() - startedAt); }
  throw new Error("The controlled command must fail.");
};

test("retains nonzero exit diagnostics and output", async () => {
  const args = ["-e", "process.stdout.write('out');process.stderr.write('err');process.exitCode=23"];
  const error = await failure(process.execPath, args, 5000);
  expect(error).toMatchObject({ code: 23, killed: false, signal: null, file: process.execPath, args, timeoutMs: 5000, stdout: "out", stderr: "err" });
  expect(error.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(error.totalElapsedMs).toBeGreaterThanOrEqual(error.elapsedMs);
});

test("distinguishes an unavailable executable from a killed command", async () => {
  const error = await failure(path.resolve(`missing-platform-command-${randomUUID()}`), [], 5000);
  expect(error).toMatchObject({ code: "ENOENT", killed: null, signal: null, timeoutMs: 5000 });
  expect(error.elapsedMs).toBeGreaterThanOrEqual(0);
});

test("retains the timeout termination and elapsed time after the child closes", async () => {
  const error = await failure(process.execPath, ["-e", "setInterval(()=>{},1000)"], 100);
  expect(error.killed).toBe(true);
  expect(error.signal).toBe("SIGTERM");
  expect(error.code).not.toBe(23);
  expect(error.elapsedMs).toBeGreaterThanOrEqual(100);
  expect(error.totalElapsedMs).toBeGreaterThanOrEqual(error.elapsedMs);
});

test("records bounded process proof context through causes and aggregates without nested private data", () => {
  const missing = new WindowsProcessProofError("open-process", 87, "Win32");
  const acquisition = new MappingProcessProofAcquisitionError(302, "native descendant", "capture", missing);
  const termination = new WindowsProcessProofError("command-line", 0xc000010a | 0, "NTSTATUS");
  const secret = "private native Session and full process inventory";
  const unrelated = Object.assign(new Error(secret), { session: secret, inventory: secret });
  const nested = new AggregateError([acquisition, termination, unrelated], "confirmation failed", { cause: acquisition });
  const top = new Error("input submitted", { cause: nested });
  const details = platformErrorDetails(top, 12);
  expect(details).toMatchObject({ name: "Error", message: "input submitted", totalElapsedMs: 12, processProofErrors: [
    { pid: 302, role: "native descendant", phase: "capture", windows: { stage: "open-process", domain: "Win32", code: 87 } },
    { stage: "command-line", domain: "NTSTATUS", code: 0xc000010a | 0 },
  ] });
  expect(JSON.stringify(details)).not.toContain(secret);
});

test("does not serialize unrecognized proof fields or follow cyclic errors indefinitely", () => {
  const invalid = new MappingProcessProofAcquisitionError(302, "private Session", "capture", new WindowsProcessProofError("private inventory", 87, "Win32"));
  const cycle = new AggregateError([invalid], "bounded");
  Object.defineProperty(cycle, "cause", { value: cycle });
  expect(JSON.stringify(platformErrorDetails(cycle, 5))).not.toMatch(/private Session|private inventory|processProofErrors/);
});
