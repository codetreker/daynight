import { mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { reconcileOwnedCommandBoundary, retainedOwnedCommandBoundaries, runLifecycleOwnedCommand, type OwnedCommandLifecycleEvent } from "../../../src/commands/worker/owned-command-lifecycle.js";

it("joins every streamed output write before saving the original command's stop", async () => {
  const parent = path.resolve(import.meta.dirname, "../../../../../.tmp/owned-stream");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, "capture-"));
  const stdout = await open(path.join(directory, "stdout"), "wx"), stderr = await open(path.join(directory, "stderr"), "wx");
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const events: OwnedCommandLifecycleEvent[] = [];
  const size = 512 * 1024, prompt = "literal reviewer input\n";
  let received = 0, persisted = 0, callbacks = 0;
  const operation = createOperation({ limits: { totalMs: 30_000, requestMs: 30_000, totalBytes: 2 * size } });
  const source = `let input='';for await(const chunk of process.stdin) input+=chunk;if(input!==${JSON.stringify(prompt)})process.exit(2);process.stdout.write('x'.repeat(${size}));process.stderr.write('y'.repeat(${size}));`;
  const running = runLifecycleOwnedCommand({ file: process.execPath, args: ["--input-type=module", "--eval", source], environment: process.env }, operation,
    async event => {
      if (event.stage === "stopped") expect(persisted).toBe(size);
      events.push(event);
    }, {
      timeoutMs: 20_000, maximumOutputBytes: 2 * size, captureOutput: false, stdin: prompt,
      onStdout: async chunk => {
        callbacks++; received += chunk.length;
        if (received === size) { entered.resolve(); await release.promise; }
        await stdout.writeFile(chunk); persisted += chunk.length;
      },
      onStderr: async chunk => { await stderr.writeFile(chunk); },
    });
  let settled = false;
  void running.then(() => { settled = true; }, () => { settled = true; });
  try {
    await Promise.race([entered.promise, running.then(() => { throw new Error("Output completed without the final writer barrier."); })]);
    expect(settled).toBe(false);
    expect(events.map(event => event.stage)).toEqual(["prepared", "bound"]);
    expect(persisted).toBeLessThan(size);
    release.resolve();
    expect(await running).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(callbacks).toBeGreaterThan(1);
    expect(await readFile(path.join(directory, "stdout"), "utf8")).toBe("x".repeat(size));
    expect(await readFile(path.join(directory, "stderr"), "utf8")).toBe("y".repeat(size));
    expect(events.map(event => event.stage)).toEqual(["prepared", "bound", "stopped"]);
  } finally {
    release.resolve(); await running.catch(() => {}); operation.dispose();
    await Promise.all([stdout.close(), stderr.close()]);
    await rm(directory, { recursive: true, force: true });
  }
}, 35_000);

it("retains a timed-out output writer during native boundary reconciliation", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const events: OwnedCommandLifecycleEvent[] = [];
  const sink = async (event: OwnedCommandLifecycleEvent) => { events.push(event); };
  const operation = createOperation({ limits: { totalMs: 3000, requestMs: 3000 } });
  let written = false;
  const running = runLifecycleOwnedCommand({ file: process.execPath, args: ["--eval", "process.stdout.write('retained');"], environment: process.env }, operation, sink, {
    cleanupWithinDeadline: true, onStdout: async () => { entered.resolve(); await release.promise; written = true; },
  }).then(() => { throw new Error("Unjoined writer must not report completion."); }, error => error);
  try {
    await Promise.race([entered.promise, running.then(error => { throw error; })]);
    const error = await running;
    expect(error.name).toBe("OwnedCommandCleanupError");
    const resourceId = events[0]!.resourceId;
    await expect(reconcileOwnedCommandBoundary(resourceId, sink, Date.now() + 50)).rejects.toThrow();
    expect(written).toBe(false);
    expect(events.some(event => event.stage === "stopped")).toBe(false);
    expect(retainedOwnedCommandBoundaries().some(value => value.resourceId === resourceId)).toBe(true);
    release.resolve();
    await reconcileOwnedCommandBoundary(resourceId, sink, Date.now() + 5000);
    expect(written).toBe(true);
    expect(events.at(-1)?.stage).toBe("stopped");
  } finally {
    release.resolve(); await running; operation.dispose();
    const resourceId = events[0]?.resourceId;
    if (resourceId && retainedOwnedCommandBoundaries().some(value => value.resourceId === resourceId)) await reconcileOwnedCommandBoundary(resourceId, sink, Date.now() + 5000);
  }
}, 15_000);
