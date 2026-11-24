import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createOperation, OperationError, type Operation } from "../../../src/api/operation.js";
import type { WorkerTelemetry } from "../../../src/api/types.js";
import { confirmControllerProcessesStopped, ControllerProcessWaitDeadlineError } from "../../../src/commands/controller/process-proof.js";
import { openExecutionResourceJournal } from "../../../src/commands/worker/execution-resource-journal.js";
import { isConfirmedOwnedCommandCleanupWait, OwnedCommandCleanupError, OwnedCommandDeadlineError } from "../../../src/commands/worker/owned-command.js";
import { reconcileOwnedCommandBoundary, retainedOwnedCommandBoundaries, runLifecycleOwnedCommand } from "../../../src/commands/worker/owned-command-lifecycle.js";
import { createWorkerReporter } from "../../../src/commands/worker/reporter.js";

const timestamp = "2026-10-29T00:00:00.000Z";
const telemetry: WorkerTelemetry = {
  machine: { id: "machine", name: "machine" }, platform: "linux", workingDirectory: "/worker", sampledAt: timestamp,
  os: { state: "ok", checkedAt: timestamp, value: { type: "Linux", release: "6", version: "kernel", arch: "x64" } },
  cpu: { state: "ok", checkedAt: timestamp, value: { model: "CPU", logicalProcessors: 4, usagePercent: 12 } },
  memory: { state: "ok", checkedAt: timestamp, value: { usedBytes: 100, totalBytes: 200 } },
  disk: { state: "ok", checkedAt: timestamp, value: { availableBytes: 300, totalBytes: 400 } },
  versions: { daynight: "0.26.1", codex: { state: "not_installed", checkedAt: timestamp }, copilot: { state: "not_installed", checkedAt: timestamp } },
};

it.skipIf(process.platform !== "linux").each(["confirmed", "independent journal failure", "late output failure", "late reporter cancellation", "late unrelated cancellation", "late tampered cancellation"] as const)(
  "settles a real observation deadline only with complete original cleanup: %s", async scenario => {
    const parent = path.resolve(import.meta.dirname, "../../../../../.tmp/owned-observation");
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(path.join(parent, "run-")), bin = path.join(directory, "bin");
    await mkdir(bin);
    const marker = path.join(directory, "slow-ps"), lateOutput = path.join(directory, "late-output"), lateRelease = path.join(directory, "late-release"), ps = path.join(bin, "ps"), oldPath = process.env.PATH, oldMarker = process.env.DAYNIGHT_TEST_SLOW_PS;
    const lateCancellation = scenario === "late reporter cancellation" || scenario === "late unrelated cancellation" || scenario === "late tampered cancellation";
    await writeFile(ps, `#!${process.execPath}\nconst fs=require('node:fs'), cp=require('node:child_process');\nif(process.argv.includes('-p') && fs.existsSync(process.env.DAYNIGHT_TEST_SLOW_PS)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${lateCancellation ? 6500 : 1800});\nconst result=cp.spawnSync('/usr/bin/ps',process.argv.slice(2),{stdio:'inherit'});process.exit(result.status??1);\n`);
    await chmod(ps, 0o700);
    const journal = await openExecutionResourceJournal({ directory: path.join(directory, "journal"), identity: { serverOrigin: "https://example.test", userId: randomUUID(), workerId: randomUUID() } });
    process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ""}`;
    process.env.DAYNIGHT_TEST_SLOW_PS = marker;
    const durableSink = journal.sink("1"), persistenceFailure = new Error("controlled unknown-event persistence failure");
    let rejectStopped = false;
    const sink: typeof durableSink = async event => {
      if (scenario === "independent journal failure" && event.stage === "unknown") throw persistenceFailure;
      if (rejectStopped && event.stage === "stopped") throw new Error("controlled stopped-event persistence failure");
      await durableSink(event);
    };
    let output = "", issue: unknown, resourceId: string | undefined;
    const outputGate = Promise.withResolvers<void>();
    let lateConsumed = false;
    let activeOperation: Operation | undefined;
    const releaseCollector = Promise.withResolvers<void>();
    const unrelated = new AbortController();
    const collected = Promise.withResolvers<void>();
    const controller = new AbortController();
    const reporter = createWorkerReporter({ signal: controller.signal, collect: async reporterOperation => {
      const operation = createOperation({ ...(lateCancellation ? { signal: scenario === "late unrelated cancellation" ? unrelated.signal : reporterOperation.signal } : {}), limits: lateCancellation ? { totalMs: 15_000, requestMs: 10_000 } : { totalMs: 5000, requestMs: 5000 } });
      activeOperation = operation;
      const consume = operation.consume;
      operation.consume = bytes => { if (operation.signal.aborted) lateConsumed = true; consume(bytes); };
      const source = `const fs=require('node:fs');process.stdout.write('original output');setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'armed'),${lateCancellation ? 500 : 3000});${scenario === "late output failure" || lateCancellation ? `setTimeout(()=>{process.stdout.write('x');fs.writeFileSync(${JSON.stringify(lateOutput)},'written');${scenario === "late output failure" ? `const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(lateRelease)})){clearInterval(timer);process.stdout.write('independent overflow');}},10);` : ""}},${lateCancellation ? 6500 : 5200});` : ""}process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`;
      try {
        await runLifecycleOwnedCommand({ file: process.execPath, args: ["-e", source], environment: process.env }, operation, sink,
          { cleanupWithinDeadline: true, ...(lateCancellation ? { timeoutMs: 1000 } : {}), ...(scenario === "late output failure" ? { maximumOutputBytes: 16 } : {}), onStdout: async chunk => { output += chunk.toString(); await outputGate.promise; } });
        throw new Error("The controlled process unexpectedly completed.");
      } catch (error) { issue = error; }
      finally { if (!lateCancellation) operation.dispose(); }
      collected.resolve();
      if (lateCancellation) await releaseCollector.promise;
      return { telemetry, issues: [{ component: "assistantHost_claude", code: "timeout", error: issue }] };
    }, send: async () => ({ observedAt: timestamp, lastReportedAt: timestamp }), emit: () => {} });
    try {
      await collected.promise;
      expect(issue).toBeInstanceOf(OwnedCommandCleanupError);
      const cleanup = issue as OwnedCommandCleanupError;
      if (scenario === "late unrelated cancellation") unrelated.abort(new Error("unrelated cancellation"));
      const initialStop = reporter.stop();
      releaseCollector.resolve();
      await expect(initialStop).rejects.toBe(cleanup);
      const original = retainedOwnedCommandBoundaries();
      expect(original).toHaveLength(1);
      const boundary = original[0]!;
      resourceId = boundary.resourceId;
      expect(boundary.proof?.processGroupId).toBe(boundary.proof?.pid);
      const [savedBefore] = await journal.read();
      expect(savedBefore?.event).toMatchObject({ resourceId, stage: scenario === "independent journal failure" ? "bound" : "unknown", proof: boundary.proof });
      expect(isConfirmedOwnedCommandCleanupWait(cleanup)).toBe(false);
      if (scenario === "late output failure" || lateCancellation) {
        await vi.waitFor(async () => { expect(await readFile(lateOutput, "utf8")).toBe("written"); }, { timeout: 5000, interval: 25 });
        if (scenario === "late tampered cancellation") cleanup.errors.push(new Error("tampered evidence"));
        const failures = cleanup.errors.length;
        outputGate.resolve();
        await vi.waitFor(() => { expect(lateConsumed).toBe(true); }, { timeout: 5000, interval: 25 });
        if (lateCancellation) {
          expect(cleanup.errors).toHaveLength(failures + 1);
          expect(cleanup.errors.at(-1)).toBe(activeOperation?.signal.reason);
          expect(cleanup.errors.at(-1)).toBeInstanceOf(OperationError);
        } else {
          expect(cleanup.errors).toHaveLength(failures);
          await writeFile(lateRelease, "release");
          await vi.waitFor(() => { expect(cleanup.errors.some(error => error instanceof RangeError)).toBe(true); }, { timeout: 5000, interval: 25 });
        }
      }
      await unlink(marker);

      // Re-observing the process group cannot substitute for joining the
      // original output consumer, even after the process has terminated.
      if (scenario !== "late output failure" && !lateCancellation) {
        await expect(reconcileOwnedCommandBoundary(resourceId, durableSink, Date.now() + 1000)).rejects.toThrow();
        expect(retainedOwnedCommandBoundaries()).toContainEqual(boundary);
        await expect(reporter.stop()).rejects.toBe(cleanup);
        outputGate.resolve();
      }

      // The real process boundary and streams may be closed, but a failed
      // durable terminal event must retain the original owner's responsibility.
      rejectStopped = true;
      await expect(reconcileOwnedCommandBoundary(resourceId, sink, Date.now() + 15_000)).rejects.toThrow("controlled stopped-event persistence failure");
      expect(retainedOwnedCommandBoundaries()).toContainEqual(boundary);
      await expect(reporter.stop()).rejects.toBe(cleanup);
      expect(isConfirmedOwnedCommandCleanupWait(cleanup)).toBe(false);
      rejectStopped = false;
      await reconcileOwnedCommandBoundary(resourceId, durableSink, Date.now() + 15_000);
      expect(await confirmControllerProcessesStopped(boundary.proof!, [], Date.now() + 5000)).toBe(true);
      expect(output).toBe("original output");
      expect(retainedOwnedCommandBoundaries()).not.toContainEqual(boundary);
      await journal.assertClosed();
      const saved = JSON.parse(await readFile(path.join(directory, "journal", `${resourceId}.json`), "utf8"));
      expect(saved).toMatchObject({ generation: "1", event: { resourceId, stage: "stopped", proof: boundary.proof } });
      if (scenario === "confirmed") {
        expect(isConfirmedOwnedCommandCleanupWait(cleanup)).toBe(true);
        await expect(reporter.stop()).resolves.toBeUndefined();
        const commandDeadline = cleanup.errors.find((item: unknown) => item instanceof OwnedCommandDeadlineError);
        expect(commandDeadline).toBeInstanceOf(OwnedCommandDeadlineError);
        if (!(commandDeadline instanceof OwnedCommandDeadlineError)) throw new Error("Expected the original command deadline.");
        Object.setPrototypeOf(commandDeadline, AggregateError.prototype);
        Object.assign(commandDeadline, { errors: [new Error("independent command failure")] });
        expect(isConfirmedOwnedCommandCleanupWait(cleanup)).toBe(false);
        await expect(reporter.stop()).rejects.toBe(cleanup);
        Object.setPrototypeOf(commandDeadline, OwnedCommandDeadlineError.prototype);
        Reflect.deleteProperty(commandDeadline, "errors");
        expect(isConfirmedOwnedCommandCleanupWait(cleanup)).toBe(true);
        cleanup.errors.push(new Error("later independent failure"));
        expect(isConfirmedOwnedCommandCleanupWait(cleanup)).toBe(false);
        await expect(reporter.stop()).rejects.toBe(cleanup);
        cleanup.errors.pop();
        const wait = cleanup.cause as Error;
        Object.setPrototypeOf(wait, ControllerProcessWaitDeadlineError.prototype);
        delete wait.cause;
        Object.assign(wait, { errors: [new Error("independent observation failure")] });
        expect(isConfirmedOwnedCommandCleanupWait(cleanup)).toBe(false);
        await expect(reporter.stop()).rejects.toBe(cleanup);
      } else if (scenario === "independent journal failure") {
        expect(cleanup.errors).toContain(persistenceFailure);
        expect(isConfirmedOwnedCommandCleanupWait(cleanup)).toBe(false);
        await expect(reporter.stop()).rejects.toBe(cleanup);
      } else if (scenario === "late output failure") {
        expect(cleanup.errors.filter(error => error instanceof RangeError)).toHaveLength(1);
        expect(isConfirmedOwnedCommandCleanupWait(cleanup)).toBe(false);
        await expect(reporter.stop()).rejects.toBe(cleanup);
      } else if (scenario === "late reporter cancellation") {
        expect(isConfirmedOwnedCommandCleanupWait(cleanup)).toBe(false);
        await expect(reporter.stop()).resolves.toBeUndefined();
        const signal = activeOperation!.signal, original = Object.getOwnPropertyDescriptor(signal, "reason");
        Object.defineProperty(signal, "reason", { configurable: true, value: new Error("changed signal") });
        await expect(reporter.stop()).rejects.toBe(cleanup);
        if (original === undefined) Reflect.deleteProperty(signal, "reason"); else Object.defineProperty(signal, "reason", original);
        await expect(reporter.stop()).resolves.toBeUndefined();
      } else {
        expect(isConfirmedOwnedCommandCleanupWait(cleanup)).toBe(false);
        await expect(reporter.stop()).rejects.toBe(cleanup);
      }
    } finally {
      controller.abort();
      unrelated.abort(); releaseCollector.resolve(); activeOperation?.dispose();
      outputGate.resolve();
      await unlink(marker).catch(() => {});
      rejectStopped = false;
      try {
        const owned = new Set((await journal.read()).map(record => record.event.resourceId));
        for (const boundary of retainedOwnedCommandBoundaries()) {
          if (owned.has(boundary.resourceId)) await reconcileOwnedCommandBoundary(boundary.resourceId, durableSink, Date.now() + 15_000);
        }
      } finally {
        if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
        if (oldMarker === undefined) delete process.env.DAYNIGHT_TEST_SLOW_PS; else process.env.DAYNIGHT_TEST_SLOW_PS = oldMarker;
        await rm(directory, { recursive: true, force: true });
        await rmdir(parent).catch(() => {});
      }
    }
  }, 35_000,
);
