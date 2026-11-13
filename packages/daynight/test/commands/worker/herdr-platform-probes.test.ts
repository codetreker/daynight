import { expect, it } from "vitest";
import { executeRawPreparationProbe, preparationProbeMarker, runPreparationProbeSequence } from "./herdr-platform-probes.fixtures.js";

const marker = { file: "fixed-powershell.exe", args: ["fixed-marker"], environment: { PRIVATE_VALUE: "must-not-be-recorded" } };
const inventory = { ...marker, args: ["fixed-inventory"] };

it("compares both runners in independent budgets and records only bounded output statistics", async () => {
  const calls: string[] = [];
  const result = await runPreparationProbeSequence({ marker, inventory }, async (mode, command, operation) => {
    expect(operation.signal.aborted).toBe(false);
    expect(operation.limits).toMatchObject({ totalMs: 4000, requestMs: 2000 });
    calls.push(`${mode}:${command.args[0]}`);
    return { stdout: command === marker ? preparationProbeMarker : JSON.stringify([{ ProcessId: process.pid, ParentProcessId: process.ppid, SECRET: "must-not-be-recorded" }]), stderr: "must-not-be-recorded", closed: true };
  });
  expect(calls).toEqual(["metadata:fixed-marker", "metadata:fixed-inventory", "execFile:fixed-marker", "execFile:fixed-inventory"]);
  expect(result.filter(row => row.probe === "marker").every(row => row.markerMatches)).toBe(true);
  expect(result.filter(row => row.probe === "inventory").every(row => row.jsonRows === 1 && row.current?.parentPid === process.ppid)).toBe(true);
  expect(JSON.stringify(result)).not.toContain("must-not-be-recorded");
  expect(JSON.stringify(result)).not.toContain("fixed-powershell.exe");
});

it("stops further probes when the original runner cannot confirm cleanup", async () => {
  let calls = 0;
  const result = await runPreparationProbeSequence({ marker, inventory }, async () => { calls++; return { stdout: "", stderr: "", closed: false, errorType: "HerdrCommandCleanupError" }; });
  expect(calls).toBe(1);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ closed: false, errorType: "HerdrCommandCleanupError" });
});

it("keeps unavailable output unknown and starts no further probes after cancellation", async () => {
  let cancelled = false;
  const result = await runPreparationProbeSequence({ marker, inventory }, async () => { cancelled = true; return { stdout: "", stderr: "", closed: true, outputCaptured: false, errorType: "HerdrCommandDeadlineError" }; }, () => cancelled);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ stdoutBytes: null, stderrBytes: null, closed: true });
  expect(result[0]?.markerMatches).toBeUndefined();
});

it("joins a real raw child's output streams before confirming probe cleanup", async () => {
  const result = await executeRawPreparationProbe({ file: process.execPath, args: ["-e", `process.stdout.write(${JSON.stringify(preparationProbeMarker)})`], environment: {} });
  expect(result).toEqual({ stdout: preparationProbeMarker, stderr: "", closed: true, errorType: undefined });
});

it("terminates and joins a stalled raw probe without exposing its output", async () => {
  const result = await executeRawPreparationProbe({ file: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], environment: {} });
  expect(result).toMatchObject({ stdout: "", stderr: "", closed: true, errorType: "Error" });
});
