import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import * as files from "../../../src/platform/files.js";
import { openExecutionResourceJournal } from "../../../src/commands/worker/execution-resource-journal.js";
import { hasUnconfirmedOwnedCommandCleanup, runOwnedCommand } from "../../../src/commands/worker/owned-command.js";
import { retainedOwnedCommandBoundaries, runLifecycleOwnedCommand, withOwnedCommandLifecycle } from "../../../src/commands/worker/owned-command-lifecycle.js";

const roots: string[] = [];
const identity = { serverOrigin: "https://daynight.example", userId: "00000000-0000-4000-8000-000000000001", workerId: "00000000-0000-4000-8000-000000000002" };
const fixture = async () => {
  const parent = path.resolve(import.meta.dirname, "../../../../../.tmp/execution-resource-reconciliation");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, "case-")); roots.push(directory);
  const journalDirectory = path.join(directory, "journal");
  const journal = await openExecutionResourceJournal({ directory: journalDirectory, identity });
  return { directory, journalDirectory, journal };
};
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

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
