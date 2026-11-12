import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import { ControllerBootstrapReplacedError, reconcileSubmittedControllerLaunch, stopControllerBootstrap } from "../../../src/commands/controller/launch-observation.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { captureProcessProof, inspectProcessProof } from "../../../src/commands/controller/process-proof.js";

const roots: string[] = [], children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "close"); }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const fixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daynight-bootstrap-")); roots.push(root);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: root, nativeHome: path.join(root, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "original", resumeNativeSessionId: null, credentialFile: path.join(root, "grant.json"), ipcEndpoint: process.platform === "win32" ? `\\\\.\\pipe\\${randomUUID()}` : path.join("/tmp", `dn-${randomUUID()}.sock`), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const journalFile = path.join(root, "journal.sqlite");
  const child = spawn(process.execPath, ["-e", 'process.stdout.write("ready\\n");setInterval(()=>{},1000)'], { stdio: ["ignore", "pipe", "ignore"] }); children.push(child);
  await once(child.stdout!, "data", { signal: AbortSignal.timeout(10_000) });
  const proof = await captureProcessProof(child.pid!);
  return { root, ticket, journalFile, child, proof, observe: (next = ticket) => reconcileSubmittedControllerLaunch({ journalFile, ticket: next, spawnProof: proof, signal: new AbortController().signal }) };
};

it("retains the running instance and classifies a missing journal only after its real exit", async () => {
  const f = await fixture();
  expect((await f.observe()).kind).toBe("running-unobserved");
  await stopControllerBootstrap(f.proof, Date.now() + 15_000);
  expect(await f.observe()).toEqual({ kind: "pre-writer-exited", process: f.proof, journal: "missing" });
}, 30_000);

it("reads current and exact preceding generations with ticket and identity fences", async () => {
  const f = await fixture();
  const store = openControllerLifecycleStore(f.journalFile, f.ticket, { onMigration: () => {} });
  const nativeSessionId = "provider-session:non-uuid";
  store.patchSnapshot({ lifecycle: "stopped", nativeStopped: true, nativeSessionId, controllerProcess: f.proof }); store.close();
  await stopControllerBootstrap(f.proof, Date.now() + 15_000);
  expect((await f.observe()).kind).toBe("controller-exited");
  const next = { ...f.ticket, launchId: randomUUID(), controllerInstanceId: randomUUID(), executionGeneration: "2", resumeNativeSessionId: nativeSessionId };
  expect(await f.observe(next)).toEqual({ kind: "pre-writer-exited", process: f.proof, journal: "preceding-generation" });
  await expect(f.observe({ ...next, resumeNativeSessionId: randomUUID() })).rejects.toThrow(/generation conflict/);
  await expect(f.observe({ ...f.ticket, ipcSecret: "b".repeat(64) })).rejects.toThrow(/ticket or instance conflict/);
  await expect(f.observe({ ...next, sessionId: randomUUID() })).rejects.toThrow(/identity conflict/);
  const db = new Database(f.journalFile);
  const row = db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string };
  const snapshot = JSON.parse(row.snapshot);
  db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify({ ...snapshot, controllerProcess: { ...f.proof, jobObjectName: `Local\\Daynight-${randomUUID()}` } }));
  const conflict = await f.observe().catch(error => error);
  expect(conflict).toBeInstanceOf(AggregateError); expect(conflict.errors[0].name).toBe("Error");
  expect(conflict.errors[1].message).toMatch(/process identity conflict/); expect(conflict.cause).toBe(conflict.errors[1]);
  if (process.platform === "win32") {
    db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify({ ...snapshot, controllerProcess: { ...f.proof, parentPid: f.proof.parentPid + 1 } }));
    await expect(f.observe()).rejects.toThrow(/process identity conflict/);
  }
  db.prepare("DELETE FROM execution").run(); db.close();
  expect((await f.observe()).kind).toBe("pre-writer-exited");
}, 30_000);

it.skipIf(process.platform === "win32")("uses TERM then KILL for a resistant original and refuses a replacement or expired deadline", async () => {
  const f = await fixture();
  await expect(stopControllerBootstrap({ ...f.proof, commandHash: "replacement" }, Date.now() + 5000)).rejects.toThrow(/identity/);
  await expect(stopControllerBootstrap(f.proof, Date.now() - 1)).rejects.toThrow(/deadline/);
  expect(await inspectProcessProof(f.proof)).toBe("running");
  f.child.kill("SIGKILL"); await once(f.child, "close");
}, 20_000);

it.skipIf(process.platform === "win32")("kills a real bootstrap that ignores TERM", async () => {
  const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM",()=>{});process.stdout.write("ready\\n");setInterval(()=>{},1000)'], { stdio: ["ignore", "pipe", "ignore"] }); children.push(child);
  await once(child.stdout!, "data", { signal: AbortSignal.timeout(10_000) });
  const proof = await captureProcessProof(child.pid!);
  const start = Date.now(); await stopControllerBootstrap(proof, start + 8000);
  expect(Date.now() - start).toBeGreaterThanOrEqual(1800);
  expect(await inspectProcessProof(proof)).toBe("stopped");
}, 15_000);

it("propagates cancellation and an expired cleanup deadline before observing", async () => {
  const f = await fixture();
  const signal = new AbortController(), reason = new Error("business cancelled"); signal.abort(reason);
  await expect(reconcileSubmittedControllerLaunch({ journalFile: f.journalFile, ticket: f.ticket, spawnProof: f.proof, signal: signal.signal })).rejects.toBe(reason);
  await expect(reconcileSubmittedControllerLaunch({ journalFile: f.journalFile, ticket: f.ticket, spawnProof: f.proof, signal: new AbortController().signal, deadline: Date.now() - 1 })).rejects.toThrow(/deadline/);
  expect(await inspectProcessProof(f.proof)).toBe("running");
}, 20_000);

it("refuses an unversioned journal without creating or migrating it", async () => {
  const f = await fixture(); const db = new Database(f.journalFile);
  db.exec("CREATE TABLE unrelated (id INTEGER)"); db.close();
  await stopControllerBootstrap(f.proof, Date.now() + 15_000);
  await expect(f.observe()).rejects.toThrow(/current format/);
  const read = new Database(f.journalFile, { readonly: true });
  expect(read.pragma("user_version", { simple: true })).toBe(0); read.close();
}, 30_000);


it("returns observed only from the original authenticated IPC response", async () => {
  const f = await fixture();
  const store = openControllerLifecycleStore(f.journalFile, f.ticket, { onMigration: () => {} });
  const snapshot = store.getSnapshot(); store.close();
  const server = createServer(socket => {
    socket.once("data", bytes => {
      const request = JSON.parse(String(bytes));
      expect(request.secret).toBe(f.ticket.ipcSecret); expect(request.executionId).toBe(f.ticket.executionId);
      expect(request.controllerInstanceId).toBe(f.ticket.controllerInstanceId);
      socket.end(`${JSON.stringify({ requestId: request.requestId, ok: true, snapshot })}\n`);
    });
  });
  server.listen(f.ticket.ipcEndpoint); await once(server, "listening");
  try { expect(await f.observe()).toEqual({ kind: "observed", snapshot }); }
  finally { server.close(); await once(server, "close"); }
}, 20_000);

it("interrupts an in-flight IPC observation with the original cancellation reason", async () => {
  const f = await fixture(); const connected = Promise.withResolvers<void>();
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer(socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => {}); socket.resume(); connected.resolve(); });
  server.listen(f.ticket.ipcEndpoint); await once(server, "listening");
  try {
    const controller = new AbortController(), reason = new Error("cancel observation");
    const observed = reconcileSubmittedControllerLaunch({ journalFile: f.journalFile, ticket: f.ticket, spawnProof: f.proof, signal: controller.signal });
    await connected.promise; controller.abort(reason);
    await expect(observed).rejects.toBe(reason);
  } finally { for (const socket of sockets) socket.destroy(); server.close(); await once(server, "close"); }
}, 20_000);

it("classifies a changed birth without stopping the real live process at that PID", async () => {
  const f = await fixture();
  f.child.kill("SIGKILL"); await once(f.child, "close");
  // POSIX birth timestamps have one-second precision. Ensure the second real
  // process is distinguishable even when the fixture starts near a boundary.
  const nextSecond = Math.floor(Date.now() / 1000) * 1000 + 1050;
  if (Date.now() < nextSecond) await new Promise(resolve => setTimeout(resolve, nextSecond - Date.now()));
  const replacement = spawn(process.execPath, ["-e", 'process.stdout.write("ready\\n");setInterval(()=>{},1000)'], { stdio: ["ignore", "pipe", "ignore"] }); children.push(replacement);
  await once(replacement.stdout!, "data", { signal: AbortSignal.timeout(10_000) });
  const current = await captureProcessProof(replacement.pid!);
  expect(current.startedAt).not.toBe(f.proof.startedAt);
  // Keep the original birth proof but use the live process's PID to model PID
  // reuse without waiting for the OS to recycle a particular PID.
  const original = { ...f.proof, pid: current.pid };
  const observation = await reconcileSubmittedControllerLaunch({ journalFile: f.journalFile, ticket: f.ticket, spawnProof: original, signal: new AbortController().signal });
  expect(observation).toEqual({ kind: "pre-writer-exited", process: original, journal: "missing" });
  await expect(stopControllerBootstrap(original, Date.now() + 15_000)).rejects.toBeInstanceOf(ControllerBootstrapReplacedError);
  expect(await inspectProcessProof(current)).toBe("running");
}, 35_000);

it.skipIf(process.platform === "win32")("retains unknown for a same-birth POSIX identity conflict", async () => {
  const f = await fixture(), conflicting = { ...f.proof, commandHash: "a".repeat(64) };
  const observation = await reconcileSubmittedControllerLaunch({ journalFile: f.journalFile, ticket: f.ticket, spawnProof: conflicting, signal: new AbortController().signal });
  expect(observation.kind).toBe("unknown");
  const failure = await stopControllerBootstrap(conflicting, Date.now() + 5000).catch(error => error);
  expect(failure).toBeInstanceOf(Error); expect(failure).not.toBeInstanceOf(ControllerBootstrapReplacedError);
  expect(await inspectProcessProof(f.proof)).toBe("running");
}, 20_000);
