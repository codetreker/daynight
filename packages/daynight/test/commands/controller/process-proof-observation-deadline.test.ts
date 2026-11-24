import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { captureProcessProof, confirmControllerProcessesStopped, isControllerProcessObservationDeadline } from "../../../src/commands/controller/process-proof.js";

it.skipIf(process.platform !== "linux")("retains and verifies the exact slow ps observation and aggregate evidence", async () => {
  const proof = await captureProcessProof(process.pid);
  const directory = await mkdtemp(path.join(os.tmpdir(), "daynight-observation-"));
  const originalPath = process.env.PATH;
  try {
    await writeFile(path.join(directory, "ps"), "#!/bin/sh\nexec /bin/sleep 5\n");
    await chmod(path.join(directory, "ps"), 0o755);
    process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ""}`;
    const error = await confirmControllerProcessesStopped(proof, [], Date.now() + 150).catch(cause => cause);
    expect(error).toBeInstanceOf(AggregateError);
    expect(isControllerProcessObservationDeadline(error)).toBe(true);
    expect(error.cause.cause).toMatchObject({ killed: true, signal: "SIGTERM", code: null });
    error.errors.push(new Error("independent failure"));
    expect(isControllerProcessObservationDeadline(error)).toBe(false);
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    await rm(directory, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "linux")("bounds observation when a ps descendant retains its output pipes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "daynight-observation-"));
  const originalPath = process.env.PATH, originalPidPath = process.env.DAYNIGHT_TEST_PS_PID;
  const pidPath = path.join(directory, "pid");
  try {
    await writeFile(path.join(directory, "ps"), "#!/bin/sh\n/bin/sleep 10 &\nprintf '%s' \"$!\" > \"$DAYNIGHT_TEST_PS_PID\"\nwait\n");
    await chmod(path.join(directory, "ps"), 0o755);
    process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ""}`;
    process.env.DAYNIGHT_TEST_PS_PID = pidPath;
    const start = performance.now();
    const error = await captureProcessProof(process.pid, 200).catch(cause => cause);
    expect(isControllerProcessObservationDeadline(error)).toBe(true);
    expect(performance.now() - start).toBeLessThan(1500);
  } finally {
    const descendant = await readFile(pidPath, "utf8").catch(() => "");
    if (/^[1-9][0-9]*$/.test(descendant)) { try { process.kill(Number(descendant), "SIGKILL"); } catch { /* Already exited. */ } }
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (originalPidPath === undefined) delete process.env.DAYNIGHT_TEST_PS_PID; else process.env.DAYNIGHT_TEST_PS_PID = originalPidPath;
    await rm(directory, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "linux")("does not settle a ps nonzero exit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "daynight-observation-"));
  const originalPath = process.env.PATH;
  try {
    await writeFile(path.join(directory, "ps"), "#!/bin/sh\nexit 42\n");
    await chmod(path.join(directory, "ps"), 0o755);
    process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ""}`;
    const error = await captureProcessProof(process.pid, 1000).catch(cause => cause);
    expect(error).toMatchObject({ code: 42 });
    expect(isControllerProcessObservationDeadline(error)).toBe(false);
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    await rm(directory, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "linux")("retains a partial identity conflict alongside a timed-out ps", async () => {
  const proof = await captureProcessProof(process.pid);
  const directory = await mkdtemp(path.join(os.tmpdir(), "daynight-observation-"));
  const originalPath = process.env.PATH;
  try {
    await writeFile(path.join(directory, "ps"), "#!/bin/sh\nexec /bin/sleep 5\n");
    await chmod(path.join(directory, "ps"), 0o755);
    process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ""}`;
    const error = await confirmControllerProcessesStopped({ ...proof, processGroupId: proof.processGroupId! + 1 }, [], Date.now() + 150).catch(cause => cause);
    expect(isControllerProcessObservationDeadline(error)).toBe(false);
    expect(error.cause).toBeInstanceOf(AggregateError);
    expect(error.cause.errors[1].message).toMatch(/conflicts/);
    expect(isControllerProcessObservationDeadline(error.cause.errors[0])).toBe(true);
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    await rm(directory, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "linux")("does not settle a ps signal or output limit failure", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "daynight-observation-"));
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ""}`;
    const executable = path.join(directory, "ps");
    await writeFile(executable, "#!/bin/sh\nkill -TERM $$\n");
    await chmod(executable, 0o755);
    const signal = await captureProcessProof(process.pid, 2000).catch(cause => cause);
    expect(signal).toMatchObject({ signal: "SIGTERM" });
    expect(isControllerProcessObservationDeadline(signal)).toBe(false);
    await writeFile(executable, "#!/usr/bin/env node\nprocess.stdout.write(Buffer.alloc(9 * 1024 * 1024));\n");
    const overflow = await captureProcessProof(process.pid, 2000).catch(cause => cause);
    expect(overflow).toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
    expect(isControllerProcessObservationDeadline(overflow)).toBe(false);
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    await rm(directory, { recursive: true, force: true });
  }
});
