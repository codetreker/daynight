import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { controllerExecutionDirectory, writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { readCurrentControllerSnapshot, readProvenWindowsStoppedControllerGeneration, recordStoppedControllerGeneration } from "../../../src/commands/controller/lifecycle-store.js";
import { stopControllerBootstrap } from "../../../src/commands/controller/launch-observation.js";
import { captureProcessProof, stopControllerProcesses, type ProcessProof } from "../../../src/commands/controller/process-proof.js";
import { acquireControllerJobLease, releaseControllerJobLease, type ControllerJobLease } from "../../../src/commands/controller/windows-job.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test.skipIf(process.platform !== "win32").each(["idle", "writing", "closing"] as const)("reads and records the real WAL journal after Windows Controller termination during %s", async phase => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/windows-journal-crash"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-"));
  const executionId = randomUUID(), launchId = randomUUID();
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId, executionId, controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", testExecutionId: executionId, ownerUserId: randomUUID(), initialInput: "none", serverOrigin: "https://daynight.example", provider: "codex", cwd: home, nativeHome: home, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 0 }, initialOperationId: randomUUID(), initialPrompt: "", resumeNativeSessionId: null, credentialFile: path.join(home, "credential"), ipcEndpoint: path.join(home, "local.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const previousState = process.env.DN_CONFIG_DIR; process.env.DN_CONFIG_DIR = path.join(home, ".daynight");
  let child: ChildProcess | undefined, close: Promise<void> | undefined, proof: ProcessProof | undefined, lease: ControllerJobLease | undefined;
  let failed = false, originalFailure: unknown;
  let diagnostics = "", stderr = "";
  const directory = controllerExecutionDirectory(home, executionId), journal = path.join(directory, "journal.sqlite");
  const marker = path.join(home, "shutdown-stage"), closedMarker = path.join(home, "journal-closed");
  const fileStates = async () => Object.fromEntries(await Promise.all([journal, `${journal}-wal`, `${journal}-shm`, marker, closedMarker].map(async file => [path.basename(file), await stat(file).then(value => ({ size: value.size, modified: value.mtimeMs }), error => ({ error: String(error) }))])));
  try {
    await writeLaunchTicket(home, ticket);
    await mkdir(directory, { recursive: true });
    const entry = (module: string) => pathToFileURL(path.resolve(import.meta.dirname, `../../../dist/commands/controller/${module}.js`)).href;
    const sqliteEntry = pathToFileURL(createRequire(import.meta.url).resolve("better-sqlite3")).href;
    const script = `const fs = await import('node:fs'); const { readLaunchTicket } = await import(${JSON.stringify(entry("launch-ticket"))}); const { openControllerLifecycleStore } = await import(${JSON.stringify(entry("lifecycle-store"))}); const { captureControllerProcessProof } = await import(${JSON.stringify(entry("process-proof"))}); const ticket = await readLaunchTicket(${JSON.stringify(home)}, ${JSON.stringify(launchId)}); const store = openControllerLifecycleStore(${JSON.stringify(journal)}, ticket); store.patchSnapshot({ controllerProcess: await captureControllerProcessProof(ticket.launchId), lifecycle: 'ready' }); store.appendEvent({ kind: 'fixture', value: 'x'.repeat(8192) }); process.on('message', async () => { process.send({ stopAccepted: true }, () => { setImmediate(async () => { if (${JSON.stringify(phase)} === 'writing') { const Database = (await import(${JSON.stringify(sqliteEntry)})).default; const db = new Database(${JSON.stringify(journal)}); db.exec('BEGIN IMMEDIATE'); db.prepare('UPDATE execution SET snapshot=snapshot WHERE id=1').run(); fs.writeFileSync(${JSON.stringify(marker)}, 'write transaction active'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000); db.exec('ROLLBACK'); db.close(); } else { fs.writeFileSync(${JSON.stringify(marker)}, 'about to close'); store.close(); fs.writeFileSync(${JSON.stringify(closedMarker)}, 'close completed'); } }); }); }); process.send({ ready: true }); setInterval(() => {}, 1000);`;
    child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: home, env: { ...process.env, DN_CONFIG_DIR: path.join(home, ".daynight") }, stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
    child.stderr!.on("data", chunk => { stderr += String(chunk); });
    close = new Promise(resolve => child!.once("close", () => resolve()));
    const [ready] = await once(child, "message", { signal: AbortSignal.timeout(15_000) }); expect(ready).toEqual({ ready: true });
    expect((await stat(`${journal}-wal`)).size).toBeGreaterThan(0);
    proof = await captureProcessProof(child.pid!); lease = await acquireControllerJobLease(launchId, proof, Date.now() + 15_000);
    expect(readCurrentControllerSnapshot(journal, ticket, Date.now() + 5000)).toMatchObject({ lifecycle: "ready", controllerProcess: { pid: proof.pid } });
    const deadline = Date.now() + 15_000;
    if (phase === "idle") {
      await stopControllerBootstrap(proof, deadline);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([close, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Original WAL writer did not close.")), 5000); })]); }
      finally { if (timer) clearTimeout(timer); }
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect((await stat(`${journal}-wal`)).size).toBeGreaterThan(0);
    } else {
      const accepted = once(child, "message", { signal: AbortSignal.timeout(10_000) }); child.send("stop");
      expect((await accepted)[0]).toEqual({ stopAccepted: true });
      await vi.waitFor(async () => expect((await stat(marker)).size).toBeGreaterThan(0), { timeout: 10_000, interval: 10 });
      await stopControllerProcesses({ ...proof, jobObjectName: `Local\\Daynight-${launchId}` }, [], deadline, lease);
    }
    diagnostics = JSON.stringify({ phase, childExitCode: child.exitCode, childSignal: child.signalCode, files: await fileStates() });
    expect(readCurrentControllerSnapshot(journal, ticket, deadline)).toMatchObject({ lifecycle: "ready", controllerProcess: { pid: proof.pid } });
    const stopped = await recordStoppedControllerGeneration(journal, ticket, deadline, lease);
    expect(stopped).toMatchObject({ lifecycle: "stopped", nativeStopped: true, windowsJobStopProof: { version: 1 } });
    expect(readProvenWindowsStoppedControllerGeneration(journal, ticket, deadline)).toEqual(stopped); expect(stderr).not.toContain("Error");
  } catch (error) { failed = true; originalFailure = error; diagnostics = JSON.stringify({ phase, childExitCode: child?.exitCode, childSignal: child?.signalCode, files: await fileStates(), stderr }); }
  finally {
    const failures: unknown[] = [];
    try { if (child && child.exitCode === null && child.signalCode === null) child.kill(); if (close) { let timer: ReturnType<typeof setTimeout> | undefined; try { await Promise.race([close, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("WAL writer cleanup timed out.")), 5000); })]); } finally { if (timer) clearTimeout(timer); } } } catch (error) { failures.push(error); }
    if (lease) try { releaseControllerJobLease(lease); } catch (error) { failures.push(error); }
    if (previousState === undefined) delete process.env.DN_CONFIG_DIR; else process.env.DN_CONFIG_DIR = previousState;
    if (failures.length) throw new AggregateError(failed ? [originalFailure, ...failures] : failures, `WAL writer fixture cleanup failed; evidence retained in ${home}.`, failed ? { cause: originalFailure } : undefined);
  }
  if (failed) throw new AggregateError([originalFailure], `WAL writer fixture failed; evidence retained in ${home}. ${diagnostics}`, { cause: originalFailure });
  roots.push(home);
}, 60_000);
