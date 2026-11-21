import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as childProcesses from "node:child_process";
import * as suspendedChildren from "../../../src/commands/worker/suspended-node-child.js";
import * as windowsJobs from "../../../src/commands/controller/windows-job.js";
import { startOwnedRepositoryGit } from "../../../src/repository/git-owned.js";
import { withinExecutionDeadline } from "../../../src/commands/worker/execution-scope.js";
import { afterEach, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import * as files from "../../../src/platform/files.js";
import { openExecutionResourceJournal } from "../../../src/commands/worker/execution-resource-journal.js";
import { hasUnconfirmedOwnedCommandCleanup, runOwnedCommand } from "../../../src/commands/worker/owned-command.js";
import { OwnedCommandAdmissionError, ownedCommandClosure, retainedOwnedCommandBoundaries, runLifecycleOwnedCommand, withOwnedCommandLifecycle } from "../../../src/commands/worker/owned-command-lifecycle.js";

vi.mock("node:child_process", { spy: true });

const roots: string[] = [];
const identity = { serverOrigin: "https://daynight.example", userId: "00000000-0000-4000-8000-000000000001", workerId: "00000000-0000-4000-8000-000000000002" };
const fixture = async (syncDirectory?: (directory: string) => Promise<void>) => {
  const parent = path.resolve(import.meta.dirname, "../../../../../.tmp/execution-resource-reconciliation");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, "case-")); roots.push(directory);
  const journalDirectory = path.join(directory, "journal");
  const journal = await openExecutionResourceJournal({ directory: journalDirectory, identity, ...(syncDirectory === undefined ? {} : { syncDirectory }) });
  return { directory, journalDirectory, journal };
};
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

it.each(["inventory-only", "stop-first", "inventory-first"])("joins original Git cleanup after %s closure without replay", async order => {
  const { directory, journalDirectory, journal } = await fixture(), marker = path.join(directory, "executed");
  const script = path.join(directory, "git-once.cjs");
  await writeFile(script, `require('node:fs').appendFileSync(${JSON.stringify(marker)},'once\\n');`);
  const quote = (value: string) => `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
  const replace = files.replaceFileAtomically;
  let rejectStop = true;
  vi.spyOn(files, "replaceFileAtomically").mockImplementation(async (file, text, ...rest) => {
    if (rejectStop && path.dirname(file) === journalDirectory && JSON.parse(String(text)).event.stage === "stopped") throw new Error("Git stop save failed");
    return replace(file, text, ...rest);
  });
  const operation = createOperation({ limits: { totalMs: 20_000, requestMs: 20_000 } });
  const handle = withOwnedCommandLifecycle(journal.sink("11"), () => startOwnedRepositoryGit(directory, ["-c", `alias.once=!${quote(process.execPath)} ${quote(script)}`, "once"], operation));
  try {
    const outcome = await handle.outcome;
    expect(outcome.kind).toBe("cleanup-pending");
    await expect(withinExecutionDeadline(handle.joined, Date.now() + 50)).rejects.toThrow();
    const original = (await journal.read())[0]!.event;
    rejectStop = false;
    if (order === "stop-first") handle.requestStop();
    await journal.reconcileRetained({ generation: "11", deadline: Date.now() + 10_000 });
    if (order === "inventory-first") handle.requestStop();
    await expect(withinExecutionDeadline(handle.joined, Date.now() + 1000)).resolves.toEqual({ kind: "local-closed", cleanupErrors: [] });
    expect((await journal.read())[0]!.event).toMatchObject({ resourceId: original.resourceId, stage: "stopped", proof: original.proof });
    expect(await handle.outcome).toBe(outcome);
    expect(await readFile(marker, "utf8")).toBe("once\n");
  } finally {
    rejectStop = false; operation.dispose();
    await journal.reconcileRetained({ generation: "11", deadline: Date.now() + 10_000 });
    handle.requestStop(); await withinExecutionDeadline(handle.joined, Date.now() + 1000);
  }
}, 30_000);

it.skipIf(process.platform === "win32")("retains positive failed-spawn closure when an asynchronous ENOENT loses its first terminal save", async () => {
  const { directory, journalDirectory, journal } = await fixture(), marker = path.join(directory, "executed");
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const children: ReturnType<typeof actual.spawn>[] = [], observations: string[] = [];
  vi.spyOn(childProcesses, "spawn").mockImplementation((...args: Parameters<typeof actual.spawn>) => {
    const child = Reflect.apply(actual.spawn, undefined, args) as ReturnType<typeof actual.spawn>;
    children.push(child);
    child.once("spawn", () => observations.push("spawn"));
    child.once("error", error => observations.push("code" in error ? String(error.code) : "error"));
    child.once("close", () => observations.push("close"));
    return child;
  });
  const replace = files.replaceFileAtomically;
  let rejectStop = true;
  vi.spyOn(files, "replaceFileAtomically").mockImplementation(async (file, text, ...rest) => {
    if (rejectStop && path.dirname(file) === journalDirectory && JSON.parse(String(text)).event.stage === "stopped") throw new Error("failed-spawn stop save failed");
    return replace(file, text, ...rest);
  });
  const operation = createOperation();
  const failure = await runLifecycleOwnedCommand({ file: process.execPath, args: ["--eval", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed')`], environment: process.env, cwd: path.join(directory, "missing") }, operation, journal.sink("12")).catch(error => error);
  try {
    expect(failure).toMatchObject({ name: "OwnedCommandCleanupError" });
    expect(observations).toEqual(["ENOENT", "close"]);
    expect(children).toHaveLength(1); expect(children[0]!.pid).toBeUndefined();
    expect(children[0]!.stdout!.closed).toBe(true); expect(children[0]!.stderr!.closed).toBe(true);
    expect((await journal.read())[0]!.event).toMatchObject({ stage: "unknown", proof: null });
    expect(hasUnconfirmedOwnedCommandCleanup(failure)).toBe(true);
    rejectStop = false;
    await journal.reconcileRetained({ generation: "12", deadline: Date.now() + 1000 });
    expect(hasUnconfirmedOwnedCommandCleanup(failure)).toBe(false);
    expect(children).toHaveLength(1);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await (await openExecutionResourceJournal({ directory: journalDirectory, identity })).assertClosed();
  } finally { rejectStop = false; operation.dispose(); await journal.reconcileRetained({ generation: "12", deadline: Date.now() + 1000 }); }
});

it.skipIf(process.platform !== "win32")("retains the original Job until a release rejected before native close is retried", async () => {
  const { journal } = await fixture(), operation = createOperation({ limits: { totalMs: 30_000, requestMs: 30_000 } });
  const release = windowsJobs.releaseControllerJobLease;
  const releasing = vi.spyOn(windowsJobs, "releaseControllerJobLease").mockImplementationOnce(() => { throw new Error("release rejected before native close"); }).mockImplementation(release);
  let closure: Promise<void> | undefined;
  const sink = journal.sink("13");
  const failure = await runLifecycleOwnedCommand({ file: process.execPath, args: ["--eval", "process.stdout.write('done')"], environment: process.env }, operation, async event => {
    if (event.stage === "prepared") closure = ownedCommandClosure(event.resourceId);
    await sink(event);
  }).catch(error => error);
  try {
    expect(failure).toMatchObject({ name: "OwnedCommandCleanupError" });
    expect(hasUnconfirmedOwnedCommandCleanup(failure)).toBe(true);
    expect((await journal.read())[0]!.event.stage).toBe("stopped");
    await expect(withinExecutionDeadline(closure!, Date.now() + 50)).rejects.toThrow();
    await journal.reconcileRetained({ generation: "13", deadline: Date.now() + 15_000 });
    await closure;
    expect(hasUnconfirmedOwnedCommandCleanup(failure)).toBe(false);
    expect(releasing).toHaveBeenCalledTimes(2);
    expect(releasing.mock.calls[1]![0]).toBe(releasing.mock.calls[0]![0]);
  } finally { operation.dispose(); await journal.reconcileRetained({ generation: "13", deadline: Date.now() + 15_000 }); }
}, 45_000);

it.skipIf(process.platform !== "win32")("recovers a never-resumed Windows child with saved birth proof after Job acquisition and stop-save failures", async () => {
  const { journalDirectory, journal } = await fixture(), operation = createOperation({ limits: { totalMs: 30_000, requestMs: 30_000 } });
  vi.spyOn(windowsJobs, "createControllerJobLease").mockRejectedValueOnce(new Error("Job acquisition rejected"));
  const replace = files.replaceFileAtomically;
  let rejectStop = true;
  vi.spyOn(files, "replaceFileAtomically").mockImplementation(async (file, text, ...rest) => {
    if (rejectStop && path.dirname(file) === journalDirectory && JSON.parse(String(text)).event.stage === "stopped") throw new Error("unstarted child stop save failed");
    return replace(file, text, ...rest);
  });
  const failure = await runLifecycleOwnedCommand({ file: process.execPath, args: ["--eval", "process.exit(99)"], environment: process.env }, operation, journal.sink("14")).catch(error => error);
  try {
    expect(hasUnconfirmedOwnedCommandCleanup(failure)).toBe(true);
    const original = (await journal.read())[0]!.event;
    expect(original).toMatchObject({ stage: "unknown", proof: { pid: expect.any(Number) } });
    rejectStop = false;
    await journal.reconcileRetained({ generation: "14", deadline: Date.now() + 1000 });
    expect(hasUnconfirmedOwnedCommandCleanup(failure)).toBe(false);
    expect((await journal.read())[0]!.event).toMatchObject({ stage: "stopped", proof: original.proof });
    await journal.assertClosed();
  } finally { rejectStop = false; operation.dispose(); await journal.reconcileRetained({ generation: "14", deadline: Date.now() + 1000 }); }
}, 45_000);

it.each(["before-rename", "after-rename"])("retains no-spawn responsibility when prepared persistence fails %s", async fault => {
  let rejectSave = false;
  const { directory, journalDirectory, journal } = await fixture(async () => { if (fault === "after-rename" && rejectSave) throw new Error("directory sync failed"); });
  const replace = files.replaceFileAtomically;
  vi.spyOn(files, "replaceFileAtomically").mockImplementation(async (file, text, ...rest) => {
    if (fault === "before-rename" && rejectSave && path.dirname(file) === journalDirectory) throw new Error("reservation rename failed");
    return replace(file, text, ...rest);
  });
  const spawned = vi.spyOn(childProcesses, "spawn"), suspended = vi.spyOn(suspendedChildren, "createSuspendedNodeChild");
  const operation = createOperation(), marker = path.join(directory, "executed");
  rejectSave = true;
  const failure = await runLifecycleOwnedCommand({ file: process.execPath, args: ["--eval", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed')`], environment: process.env }, operation, journal.sink("3")).catch(error => error);
  try {
    expect(failure).toMatchObject({ name: "OwnedCommandCleanupError" });
    expect(hasUnconfirmedOwnedCommandCleanup(failure)).toBe(true);
    expect(spawned).not.toHaveBeenCalled(); expect(suspended).not.toHaveBeenCalled();
    const original = retainedOwnedCommandBoundaries()[0]!;
    expect(original).toEqual({ resourceId: expect.any(String), proof: null });
    expect((await journal.read()).map(record => record.event.stage)).toEqual(fault === "before-rename" ? [] : ["prepared"]);
    await expect(journal.reconcileRetained({ generation: "3", deadline: Date.now() + 1000 })).rejects.toThrow("remain unconfirmed");
    rejectSave = false;
    await expect(journal.reconcileRetained({ generation: "4", deadline: Date.now() + 1000 })).rejects.toThrow("remain unconfirmed");
    expect(hasUnconfirmedOwnedCommandCleanup(failure)).toBe(true);
    await journal.reconcileRetained({ generation: "3", deadline: Date.now() + 1000 });
    expect(hasUnconfirmedOwnedCommandCleanup(failure)).toBe(false);
    expect((await journal.read())[0]).toMatchObject({ generation: "3", event: { resourceId: original.resourceId, stage: "stopped", proof: null } });
    const reopened = await openExecutionResourceJournal({ directory: journalDirectory, identity });
    await reopened.assertClosed();
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(spawned).not.toHaveBeenCalled(); expect(suspended).not.toHaveBeenCalled();
  } finally {
    rejectSave = false; operation.dispose();
    await journal.reconcileRetained({ generation: "3", deadline: Date.now() + 1000 });
  }
});

it.each(["cancelled", "spawn-rejected"])("recovers the original no-spawn terminal save after %s", async reason => {
  const { directory, journalDirectory, journal } = await fixture();
  const controller = new AbortController(), operation = createOperation({ signal: controller.signal });
  const replace = files.replaceFileAtomically;
  let rejectSave = true;
  vi.spyOn(files, "replaceFileAtomically").mockImplementation(async (file, text, ...rest) => {
    if (rejectSave && path.dirname(file) === journalDirectory && JSON.parse(String(text)).event.stage !== "prepared") throw new Error("terminal save failed");
    return replace(file, text, ...rest);
  });
  const sink = journal.sink("5"), cancellation = new Error("cancelled before spawn");
  const failure = await runLifecycleOwnedCommand({ file: process.execPath, args: ["--eval", "process.exit(99)"], environment: process.env,
    ...(reason === "spawn-rejected" ? { cwd: process.platform === "win32" ? path.join(directory, "missing") : `${directory}\0invalid` } : {}),
  }, operation, async event => { await sink(event); if (reason === "cancelled" && event.stage === "prepared") controller.abort(cancellation); }).catch(error => error);
  try {
    expect(failure).toMatchObject({ name: "OwnedCommandCleanupError" });
    expect(hasUnconfirmedOwnedCommandCleanup(failure)).toBe(true);
    if (reason === "cancelled") expect(failure.cause).toMatchObject({ kind: "cancelled", cause: cancellation });
    expect((await journal.read())[0]!.event).toMatchObject({ stage: "prepared", proof: null });
    rejectSave = false;
    await journal.reconcileRetained({ generation: "5", deadline: Date.now() + 1000 });
    expect(hasUnconfirmedOwnedCommandCleanup(failure)).toBe(false);
    await journal.assertClosed();
    await (await openExecutionResourceJournal({ directory: journalDirectory, identity })).assertClosed();
  } finally { rejectSave = false; operation.dispose(); await journal.reconcileRetained({ generation: "5", deadline: Date.now() + 1000 }); }
});

it("joins pending original prepared and terminal writes before retiring a no-spawn owner", async () => {
  const { journal } = await fixture(), operation = createOperation();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const terminalEntered = Promise.withResolvers<void>(), terminalRelease = Promise.withResolvers<void>();
  const replace = files.replaceFileAtomically;
  let delayTerminal = true, terminalWrites = 0;
  vi.spyOn(files, "replaceFileAtomically").mockImplementation(async (file, text, ...rest) => {
    if (JSON.parse(String(text)).event.stage === "stopped") {
      terminalWrites++; if (delayTerminal) { terminalEntered.resolve(); await terminalRelease.promise; }
    }
    return replace(file, text, ...rest);
  });
  const sink = journal.sink("8");
  const running = runLifecycleOwnedCommand({ file: process.execPath, args: ["--eval", "process.exit(99)"], environment: process.env }, operation, async event => {
    await sink(event); entered.resolve(); await release.promise; throw new Error("prepared acknowledgement failed");
  }).catch(error => error);
  try {
    await entered.promise;
    await expect(journal.reconcileRetained({ generation: "8", deadline: Date.now() + 50 })).rejects.toThrow();
    expect(terminalWrites).toBe(0);
    release.resolve();
    const failure = await running;
    expect(hasUnconfirmedOwnedCommandCleanup(failure)).toBe(true);
    const first = journal.reconcileRetained({ generation: "8", deadline: Date.now() + 50 });
    await terminalEntered.promise;
    await expect(first).rejects.toThrow();
    await expect(journal.reconcileRetained({ generation: "8", deadline: Date.now() + 50 })).rejects.toThrow();
    expect(terminalWrites).toBe(1);
    expect(hasUnconfirmedOwnedCommandCleanup(failure)).toBe(true);
    delayTerminal = false; terminalRelease.resolve();
    await journal.reconcileRetained({ generation: "8", deadline: Date.now() + 1000 });
    expect(hasUnconfirmedOwnedCommandCleanup(failure)).toBe(false);
    await journal.assertClosed();
  } finally {
    release.resolve(); terminalRelease.resolve(); delayTerminal = false;
    await running; operation.dispose(); await journal.reconcileRetained({ generation: "8", deadline: Date.now() + 1000 });
  }
});

it("accepts only an explicit pre-write rejection as absent reservation responsibility", async () => {
  const operation = createOperation(), cancellation = new Error("admission already closed");
  const spawned = vi.spyOn(childProcesses, "spawn"), suspended = vi.spyOn(suspendedChildren, "createSuspendedNodeChild");
  try {
    await expect(runLifecycleOwnedCommand({ file: process.execPath, args: [], environment: process.env }, operation, async () => { throw new OwnedCommandAdmissionError(cancellation); })).rejects.toBe(cancellation);
    expect(retainedOwnedCommandBoundaries()).toEqual([]);
    expect(spawned).not.toHaveBeenCalled(); expect(suspended).not.toHaveBeenCalled();
  } finally { operation.dispose(); }
});

it("does not treat a mixed failure containing an admission rejection as proof of no reservation", async () => {
  const { journal } = await fixture(), operation = createOperation(), sink = journal.sink("9");
  const failure = await runLifecycleOwnedCommand({ file: process.execPath, args: [], environment: process.env }, operation, async event => {
    await sink(event);
    throw new AggregateError([new OwnedCommandAdmissionError(new Error("other admission rejected")), new Error("reservation write outcome unknown")]);
  }).catch(error => error);
  try {
    expect(hasUnconfirmedOwnedCommandCleanup(failure)).toBe(true);
    await expect(journal.assertClosed()).rejects.toThrow();
    await journal.reconcileRetained({ generation: "9", deadline: Date.now() + 1000 });
    expect(hasUnconfirmedOwnedCommandCleanup(failure)).toBe(false);
  } finally { operation.dispose(); await journal.reconcileRetained({ generation: "9", deadline: Date.now() + 1000 }); }
});

it("retains the original prepared writer after its producer's save observation expires", async () => {
  const { journalDirectory, journal } = await fixture(), operation = createOperation({ limits: { totalMs: 20_000, requestMs: 20_000 } });
  const replace = files.replaceFileAtomically, entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let first = true, writes = 0;
  vi.spyOn(files, "replaceFileAtomically").mockImplementation(async (file, text, ...rest) => {
    if (path.dirname(file) === journalDirectory) {
      writes++;
      if (first) { first = false; entered.resolve(); await release.promise; }
    }
    return replace(file, text, ...rest);
  });
  const spawned = vi.spyOn(childProcesses, "spawn"), suspended = vi.spyOn(suspendedChildren, "createSuspendedNodeChild");
  const running = runLifecycleOwnedCommand({ file: process.execPath, args: [], environment: process.env }, operation, journal.sink("10")).catch(error => error);
  try {
    await entered.promise;
    const failure = await running;
    expect(failure).toMatchObject({ name: "OwnedCommandCleanupError", cause: { message: "Owned command responsibility save exceeded its deadline." } });
    expect(hasUnconfirmedOwnedCommandCleanup(failure)).toBe(true);
    await expect(journal.reconcileRetained({ generation: "10", deadline: Date.now() + 50 })).rejects.toThrow();
    expect(writes).toBe(1);
    expect(journal.snapshot().pending).toBe(1);
    release.resolve();
    await journal.reconcileRetained({ generation: "10", deadline: Date.now() + 1000 });
    expect(hasUnconfirmedOwnedCommandCleanup(failure)).toBe(false);
    await journal.assertClosed();
    expect(spawned).not.toHaveBeenCalled(); expect(suspended).not.toHaveBeenCalled();
  } finally { release.resolve(); await running; operation.dispose(); await journal.reconcileRetained({ generation: "10", deadline: Date.now() + 1000 }); }
}, 20_000);

it("reconciles a non-Git command's failed stop save in its original journal and generation without replay", async () => {
  const { directory, journalDirectory, journal } = await fixture(), marker = path.join(directory, "executed");
  const replace = files.replaceFileAtomically;
  let rejectStop = true;
  vi.spyOn(files, "replaceFileAtomically").mockImplementation(async (file, text, ...rest) => {
    if (path.dirname(file) === journalDirectory && JSON.parse(String(text)).event.stage === "stopped" && rejectStop) throw new Error("stop save unavailable");
    return replace(file, text, ...rest);
  });
  const operation = createOperation({ limits: { totalMs: 20_000, requestMs: 20_000 } });
  const command = { file: process.execPath, args: ["--input-type=module", "--eval", `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(marker)},${JSON.stringify('once\n')});process.stdout.write('probe-result');`], environment: process.env };
  let failure: unknown;
  try {
    failure = await withOwnedCommandLifecycle(journal.sink("3"), () => runOwnedCommand(command, operation)).catch(error => error);
    expect(failure).toMatchObject({ name: "OwnedCommandCleanupError" });
    expect(hasUnconfirmedOwnedCommandCleanup(failure)).toBe(true);
    const original = (await journal.read())[0]!;
    expect(original.event).toMatchObject({ stage: "unknown", proof: { pid: expect.any(Number) } });
    await expect(journal.drain()).resolves.toBeUndefined();
    await expect(journal.assertClosed()).rejects.toThrow("unconfirmed boundaries");
    rejectStop = false;
    await expect(journal.reconcileRetained({ generation: "4", deadline: Date.now() + 5000 })).rejects.toThrow("remain unconfirmed");
    expect(hasUnconfirmedOwnedCommandCleanup(failure)).toBe(true);
    await journal.reconcileRetained({ generation: "3", deadline: Date.now() + 10_000 });
    expect(hasUnconfirmedOwnedCommandCleanup(failure)).toBe(false);
    const saved = JSON.parse(await readFile(path.join(journalDirectory, `${original.event.resourceId}.json`), "utf8"));
    expect(saved).toMatchObject({ identity, generation: "3", event: { resourceId: original.event.resourceId, stage: "stopped", proof: original.event.proof } });
    expect(saved.event.sequence).toBeGreaterThan(original.event.sequence);
    expect(await readFile(marker, "utf8")).toBe("once\n");
    expect(retainedOwnedCommandBoundaries().some(entry => entry.resourceId === original.event.resourceId)).toBe(false);
    await journal.assertClosed();
  } finally {
    rejectStop = false; operation.dispose();
    await journal.reconcileRetained({ generation: "3", deadline: Date.now() + 10_000 });
  }
}, 30_000);

it("keeps the original streamed writer owned during management reconciliation until its real write finishes", async () => {
  const { directory, journal } = await fixture(), marker = path.join(directory, "executed");
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let output = "";
  const operation = createOperation({ limits: { totalMs: 3000, requestMs: 3000 } });
  const running = runLifecycleOwnedCommand({ file: process.execPath, args: ["--input-type=module", "--eval", `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(marker)},${JSON.stringify('once\n')});process.stdout.write('reviewer-result');`], environment: process.env }, operation, journal.sink("7"), {
    cleanupWithinDeadline: true,
    onStdout: async chunk => { entered.resolve(); await release.promise; output += chunk.toString(); },
  }).catch(error => error);
  try {
    await Promise.race([entered.promise, running.then(error => { throw error; })]);
    // The owner is still finishing its original invocation. Management cannot
    // race that producer's cleanup or treat its pending output as a closed pipe.
    await expect(journal.reconcileRetained({ generation: "7", deadline: Date.now() + 50 })).rejects.toThrow();
    expect(output).toBe("");
    expect((await journal.read())[0]!.event.stage).not.toBe("stopped");
    const failure = await running;
    expect(failure).toMatchObject({ name: "OwnedCommandCleanupError" });
    await expect(journal.reconcileRetained({ generation: "7", deadline: Date.now() + 50 })).rejects.toThrow();
    expect(output).toBe("");
    expect(hasUnconfirmedOwnedCommandCleanup(failure)).toBe(true);
    expect((await journal.read())[0]!.event.stage).toBe("unknown");
    release.resolve();
    await journal.reconcileRetained({ generation: "7", deadline: Date.now() + 10_000 });
    expect(output).toBe("reviewer-result");
    expect(hasUnconfirmedOwnedCommandCleanup(failure)).toBe(false);
    expect(await readFile(marker, "utf8")).toBe("once\n");
    await journal.assertClosed();
  } finally {
    release.resolve(); await running; operation.dispose();
    await journal.reconcileRetained({ generation: "7", deadline: Date.now() + 10_000 });
  }
}, 20_000);
