import { randomUUID } from "node:crypto";
import path from "node:path";
import { expect, test } from "vitest";
import { executePlatformCommand, platformErrorDetails } from "./herdr-platform-command.fixtures.js";

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
