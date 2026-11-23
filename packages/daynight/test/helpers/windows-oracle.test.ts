import { EventEmitter, once } from "node:events";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { powershellOracleScript, runOracleCommand, type OracleEvent } from "./windows-oracle.js";

afterEach(() => vi.useRealTimers());

const fixture = (script: string, report: (event: OracleEvent) => void, redactStdout = false) => runOracleCommand({
  stage: "fixture-oracle", executable: process.execPath, args: ["-e", script],
  timeoutMs: 30_000, killSignal: "SIGKILL", targetPid: process.pid, report, redactStdout,
});

test("joins successful output and closure after explicitly ending unused stdin", async () => {
  const events: OracleEvent[] = [];
  const result = await fixture(`process.stdin.resume(); process.stdin.on('end', () => { process.stderr.write('DAYNIGHT_ORACLE_PHASE:stdin-ended\\n'); process.stdout.write('complete'); });`, event => events.push(event));
  expect(result.stdout).toBe("complete");
  expect(events.map(event => event.event)).toEqual(["started", "spawn", "phase", "exit", "close"]);
  expect(events.find(event => event.event === "phase")).toMatchObject({ phase: "stdin-ended", pid: expect.any(Number) });
  expect(events.at(-1)).toMatchObject({ code: 0, signal: null });
  expect(events.every(event => Number.isFinite(Date.parse(event.at)))).toBe(true);
});

test("kills a stalled command at its existing deadline and retains its last phase through closure", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const events: OracleEvent[] = [], entered = new EventEmitter();
  const ready = once(entered, "phase", { signal: AbortSignal.timeout(10_000) });
  const pending = fixture(`process.stderr.write('DAYNIGHT_ORACLE_PHASE:body-start\\n'); setInterval(() => {}, 1000);`, event => {
    events.push(event); if (event.event === "phase") entered.emit("phase");
  }).catch((error: unknown) => error);
  try {
    await ready;
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await pending;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('"lastPhase":"body-start","timedOut":true');
    expect((error as Error).cause).toMatchObject({ signal: "SIGKILL", killed: true });
    expect((error as Error).message).toContain('"commandError":{"code":null,"signal":"SIGKILL","killed":true}');
    expect((error as Error).message).toContain(`"targetPid":${process.pid}`);
    expect(events.map(event => event.event)).toEqual(["started", "spawn", "phase", "deadline", "exit", "close"]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
  }
}, 20_000);

test("preserves a nonzero command error and partial diagnostics after close", async () => {
  const events: OracleEvent[] = [];
  const error = await fixture(`process.stderr.write('DAYNIGHT_ORACLE_PHASE:before-failure\\n'); process.stdout.write('partial'); process.exitCode = 7;`, event => events.push(event)).catch((error: unknown) => error);
  expect((error as Error).cause).toMatchObject({ code: 7 });
  expect((error as Error).message).toContain('"commandError":{"code":7,"signal":null,"killed":false}');
  expect((error as Error).message).toContain('"lastPhase":"before-failure"');
  expect((error as Error).message).toContain('"text":"partial"');
  expect(events.at(-1)).toMatchObject({ event: "close", code: 7 });
});

test("retains the original spawn error without waiting for an exit event", async () => {
  const events: OracleEvent[] = [];
  const error = await runOracleCommand({ stage: "missing-oracle", executable: path.resolve(import.meta.dirname, "missing-oracle-executable"), args: [], timeoutMs: 30_000, killSignal: "SIGKILL", report: event => events.push(event) }).catch((error: unknown) => error);
  expect((error as Error).cause).toMatchObject({ code: "ENOENT" });
  expect((error as Error).message).toContain('"commandError":{"code":"ENOENT"');
  expect(events.map(event => event.event)).toEqual(["started", "close"]);
});

test("joins process closure and preserves command and reporting errors together", async () => {
  const reportingFailure = new Error("Diagnostic sink failed");
  const error = await fixture("process.exitCode = 9", () => { throw reportingFailure; }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as Error).cause).toMatchObject({ code: 9 });
  expect((error as AggregateError).errors).toEqual([(error as Error).cause, reportingFailure]);
  expect((error as Error).message).toContain('"event":"close"');
});

test("fails on output overflow and redacts oracle stdout from the bounded diagnostic", async () => {
  const events: OracleEvent[] = [];
  const error = await fixture(`process.stdout.write('sensitive-command-line'.repeat(60_000)); setInterval(() => {}, 1000);`, event => events.push(event), true).catch((error: unknown) => error);
  expect((error as Error).cause).toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
  expect((error as Error).message).not.toContain("sensitive-command-line");
  expect((error as Error).message.length).toBeLessThan(8192);
  expect(events.at(-1)?.event).toBe("close");
});

test("marks script entry before module or body initialization and preserves terminating failures", () => {
  const script = powershellOracleScript("Write-OraclePhase 'body-start'\nthrow 'original failure'");
  expect(script.indexOf("DAYNIGHT_ORACLE_PHASE:script-start")).toBeLessThan(script.indexOf("$ErrorActionPreference"));
  expect(script).toContain("$ErrorActionPreference = 'Stop'");
  expect(script).toContain("[Console]::Error.Flush()");
  expect(script).toContain("throw 'original failure'");
});
