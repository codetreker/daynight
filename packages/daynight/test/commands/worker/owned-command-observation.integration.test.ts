import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createOperation, OperationError, type Operation } from "../../../src/api/operation.js";
import type { WorkerTelemetry } from "../../../src/api/types.js";
import { confirmControllerProcessesStopped, ControllerProcessWaitDeadlineError, isControllerProcessObservationDeadline } from "../../../src/commands/controller/process-proof.js";
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
    const marker = path.join(directory, "slow-ps"), psStarted = `${marker}.started`, childReady = path.join(directory, "child-ready"), childRelease = path.join(directory, "child-release"), lateOutput = path.join(directory, "late-output"), lateRelease = path.join(directory, "late-release"), overflowRelease = path.join(directory, "overflow-release"), ps = path.join(bin, "ps"), oldPath = process.env.PATH, oldMarker = process.env.DAYNIGHT_TEST_SLOW_PS;
    const lateCancellation = scenario === "late reporter cancellation" || scenario === "late unrelated cancellation" || scenario === "late tampered cancellation";
    const controlledLate = scenario === "late output failure" || lateCancellation;
    await writeFile(ps, '#!/bin/sh\nif [ "$1" = "-p" ] && [ -f "$DAYNIGHT_TEST_SLOW_PS" ]; then\n  printf started > "$DAYNIGHT_TEST_SLOW_PS.started"\n  exec /bin/sleep 30\nfi\nexec /usr/bin/ps "$@"\n');
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
    let reporterSignal: AbortSignal | undefined;
    const releaseCollector = Promise.withResolvers<void>();
    const unrelated = new AbortController();
    const collected = Promise.withResolvers<void>();
    const controller = new AbortController();
    const realNow = Date.now, frozenNow = realNow();
    let advanceClock = false;
    const clock = controlledLate ? vi.spyOn(Date, "now").mockImplementation(() => frozenNow + (advanceClock ? 1100 : 0)) : undefined;
    const reporter = createWorkerReporter({ signal: controller.signal, collect: async reporterOperation => {
      reporterSignal = reporterOperation.signal;
      const operation = createOperation({ ...(lateCancellation ? { signal: scenario === "late unrelated cancellation" ? unrelated.signal : reporterOperation.signal } : {}), limits: controlledLate ? { totalMs: 15_000, requestMs: 10_000 } : { totalMs: 5000, requestMs: 5000 } });
      activeOperation = operation;
      const consume = operation.consume;
      operation.consume = bytes => { if (operation.signal.aborted && bytes === 1) lateConsumed = true; consume(bytes); };
      const source = `const fs=require('node:fs');${controlledLate ? `fs.writeFileSync(${JSON.stringify(childReady)},'ready');let started=false,sent=false,overflow=false;setInterval(()=>{if(!started&&fs.existsSync(${JSON.stringify(childRelease)})){started=true;process.stdout.write('original output');}if(!sent&&fs.existsSync(${JSON.stringify(lateRelease)})){sent=true;process.stdout.write('x');fs.writeFileSync(${JSON.stringify(lateOutput)},'written');}if(!overflow&&fs.existsSync(${JSON.stringify(overflowRelease)})){overflow=true;process.stdout.write('independent overflow');}},10);` : `process.stdout.write('original output');setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'armed'),3000);`}process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`;
      try {
        await runLifecycleOwnedCommand({ file: process.execPath, args: ["-e", source], environment: process.env }, operation, sink,
          { cleanupWithinDeadline: true, ...(controlledLate ? { timeoutMs: 1000 } : {}), ...(scenario === "late output failure" ? { maximumOutputBytes: 16 } : {}), onStdout: async chunk => {
            output += chunk.toString();
            if (controlledLate && output !== "original output") return;
            if (controlledLate) { await writeFile(marker, "armed"); advanceClock = true; }
            await outputGate.promise;
          } });
        throw new Error("The controlled process unexpectedly completed.");
      } catch (error) { issue = error; }
      finally { if (!lateCancellation) operation.dispose(); }
      collected.resolve();
      if (lateCancellation) await releaseCollector.promise;
      return { telemetry, issues: [{ component: "assistantHost_claude", code: "timeout", error: issue }] };
    }, send: async () => ({ observedAt: timestamp, lastReportedAt: timestamp }), emit: () => {} });
    try {
      if (controlledLate) {
        await Promise.race([vi.waitFor(async () => { expect(await readFile(childReady, "utf8")).toBe("ready"); }, { timeout: 10_000, interval: 25 }), collected.promise.then(() => { throw new Error("The command finished before the child was ready.", { cause: issue }); })]);
        await writeFile(childRelease, "release");
        await Promise.race([vi.waitFor(async () => { expect(await readFile(psStarted, "utf8")).toBe("started"); }, { timeout: 10_000, interval: 25 }), collected.promise.then(() => { throw new Error("The command finished before the controlled observation started.", { cause: issue }); })]);
        clock?.mockRestore();
      }
      await collected.promise;
      expect(issue).toBeInstanceOf(OwnedCommandCleanupError);
      const cleanup = issue as OwnedCommandCleanupError;
      if (controlledLate) {
        expect(cleanup.errors.some(error => error instanceof OwnedCommandDeadlineError)).toBe(true);
        expect(isControllerProcessObservationDeadline(cleanup.cause)).toBe(true);
        expect(cleanup.errors).toHaveLength(2);
      }
      if (lateCancellation) expect(activeOperation?.signal.aborted).toBe(false);
      if (scenario === "late tampered cancellation") cleanup.errors.push(new Error("tampered evidence"));
      const failures = cleanup.errors.length;
      if (scenario === "late unrelated cancellation") unrelated.abort(new Error("unrelated cancellation"));
      const initialStop = reporter.stop();
      if (lateCancellation) {
        const cancellation = activeOperation!.signal.reason;
        expect(cancellation).toBeInstanceOf(OperationError);
        expect(cancellation.kind).toBe("cancelled");
        expect(cancellation.cause).toBe(scenario === "late unrelated cancellation" ? unrelated.signal.reason : reporterSignal?.reason);
      }
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
        outputGate.resolve();
        await writeFile(lateRelease, "release");
        await vi.waitFor(async () => { expect(await readFile(lateOutput, "utf8")).toBe("written"); }, { timeout: 5000, interval: 25 });
        await vi.waitFor(() => { expect(lateConsumed).toBe(true); }, { timeout: 5000, interval: 25 });
        if (lateCancellation) {
          expect(cleanup.errors).toHaveLength(failures + 1);
          expect(cleanup.errors.at(-1)).toBe(activeOperation?.signal.reason);
          expect(cleanup.errors.at(-1)).toBeInstanceOf(OperationError);
        } else {
          expect(cleanup.errors).toHaveLength(failures);
          await writeFile(overflowRelease, "release");
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
      clock?.mockRestore();
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
