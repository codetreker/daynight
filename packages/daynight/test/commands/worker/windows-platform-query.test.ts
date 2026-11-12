import { afterEach, expect, test, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import * as command from "../../../dist/commands/worker/herdr/command.js";
import { decodeWindowsExternalScript, decodeWindowsPlatformJson, runWindowsPlatformQuery, type WindowsQueryObservation } from "./windows-platform-query.fixtures.js";

afterEach(() => vi.restoreAllMocks());

test("keeps Unicode and quote characters in the independent ExternalScript proof", () => {
  const source = "D:\\task's 空间 📖\\codex.ps1";
  expect(decodeWindowsExternalScript(Buffer.from(`5.1.19041.5000\nExternalScript\n${source}`, "utf8").toString("base64") + "\r\n")).toEqual({ version: "5.1.19041.5000", type: "ExternalScript", source });
});

test.each(["", "not base64", Buffer.from([0xff]).toString("base64"), Buffer.from("5.1\nExternalScript").toString("base64"), Buffer.from("5.1\nExternalScript\n\nextra").toString("base64")])("rejects an incomplete independent proof (%s)", value => {
  expect(() => decodeWindowsExternalScript(value)).toThrow();
});

test("keeps independent JSON evidence intact without using it as a production process proof", () => {
  expect(decodeWindowsPlatformJson("processes", '{"processes":[{"ProcessId":4101,"ParentProcessId":4000}]}', [])).toEqual({ processes: [{ ProcessId: 4101, ParentProcessId: 4000 }] });
});

test("rejects incomplete JSON without leaking any raw output through the parse error", () => {
  const observations: WindowsQueryObservation[] = [{ stage: "console", elapsedMs: 1, code: 0, killed: false, signal: null, stdoutBytes: 27, stderrBytes: 0, closed: true, cleanupConfirmed: true, errorType: null }];
  let failure: unknown;
  try { decodeWindowsPlatformJson("console", '{"private-query-marker":', observations); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error); expect((failure as Error).message).toContain("console"); expect((failure as Error).message).not.toContain("private-query-marker");
  expect(observations[0]!.errorType).toBe("InvalidJson");
  expect((failure as Error).cause).toBeUndefined();
});

test("records a malformed ExternalScript transport without revoking its confirmed cleanup", () => {
  const observations: WindowsQueryObservation[] = [{ stage: "external-script", elapsedMs: 1, code: 0, killed: false, signal: null, stdoutBytes: 10, stderrBytes: 0, closed: true, cleanupConfirmed: true, errorType: null }];
  expect(() => decodeWindowsExternalScript("not-base64", observations)).toThrow();
  expect(observations[0]).toMatchObject({ errorType: "InvalidExternalScript", closed: true, cleanupConfirmed: true });
});

test("records a real query's output byte counts only after its original child closes", async () => {
  const active = createOperation({ limits: { totalMs: 2000, requestMs: 1000 } }), observations: WindowsQueryObservation[] = [];
  try {
    const output = await runWindowsPlatformQuery("external-script", { file: process.execPath, args: ["-e", "process.stdout.write('independent-output')"], environment: {} }, active, observations);
    expect(output).toBe("independent-output");
    expect(observations).toMatchObject([{ stage: "external-script", code: 0, stdoutBytes: 18, stderrBytes: 0, closed: true, cleanupConfirmed: true, errorType: null }]);
  } finally { active.dispose(); }
});

test("preserves a failed query's exit diagnostics without exposing its command, environment or output", async () => {
  const secret = "private-query-marker", active = createOperation({ limits: { totalMs: 2000, requestMs: 1000 } }), observations: WindowsQueryObservation[] = [];
  try {
    const error = await runWindowsPlatformQuery("processes", { file: process.execPath, args: ["-e", `process.stderr.write('${secret}');process.exit(7)`], environment: { PRIVATE_MARKER: secret } }, active, observations).catch(error => error);
    expect(error).toBeInstanceOf(Error); expect(error.message).toContain("processes"); expect(error.message).not.toContain(secret); expect(error.cause).toBeUndefined();
    expect(observations).toMatchObject([{ stage: "processes", code: 7, stdoutBytes: 0, stderrBytes: 20, closed: true, cleanupConfirmed: true, errorType: "HerdrCommandError" }]);
    expect(JSON.stringify(observations)).not.toContain(secret);
  } finally { active.dispose(); }
});

test("joins a timed out real query before rejecting and records its original deadline", async () => {
  const active = createOperation({ limits: { totalMs: 5000, requestMs: 150 } }), observations: WindowsQueryObservation[] = [];
  try {
    await expect(runWindowsPlatformQuery("console", { file: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], environment: {} }, active, observations)).rejects.toThrow("console");
    expect(observations).toMatchObject([{ stage: "console", closed: true, cleanupConfirmed: true, errorType: "HerdrCommandDeadlineError" }]);
    expect(observations[0]!.elapsedMs).toBeLessThan(4000);
  } finally { active.dispose(); }
});

test("keeps cleanup unknown without serializing an unsafe raw error cause", async () => {
  const secret = "private-encoded-command", active = createOperation(), observations: WindowsQueryObservation[] = [];
  vi.spyOn(command, "runHerdrCommand").mockRejectedValue(new command.HerdrCommandCleanupError([new Error(secret)], new Error(secret)));
  try {
    const error = await runWindowsPlatformQuery("console", { file: process.execPath, args: [], environment: {} }, active, observations).catch(error => error);
    expect(error.message).not.toContain(secret); expect(error.cause).toBeUndefined();
    expect(observations).toMatchObject([{ closed: false, cleanupConfirmed: false, errorType: "HerdrCommandCleanupError" }]);
  } finally { active.dispose(); }
});
