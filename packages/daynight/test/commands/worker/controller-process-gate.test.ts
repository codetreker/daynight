import type { ChildProcess, Serializable } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { afterEach, expect, test, vi } from "vitest";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";

const controlled = vi.hoisted(() => ({ spawn: vi.fn(), capture: vi.fn(), prepare: vi.fn(), reconcile: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), spawn: controlled.spawn }));
vi.mock("../../../src/commands/controller/linux-controller-launch.js", async importOriginal => ({ ...await importOriginal<typeof import("../../../src/commands/controller/linux-controller-launch.js")>(), captureLinuxControllerLaunch: controlled.capture }));
vi.mock("../../../src/commands/controller/storage-preparation.js", async importOriginal => ({ ...await importOriginal<typeof import("../../../src/commands/controller/storage-preparation.js")>(), prepareControllerStorage: controlled.prepare }));
vi.mock("../../../src/commands/controller/launch-observation.js", () => ({ reconcileSubmittedControllerLaunch: controlled.reconcile }));
import { controllerExecutionDirectory, controllerPayloadHash, controllerTicketPath } from "../../../src/commands/controller/launch-ticket.js";
import { readUnreleasedLaunch, unreleasedLaunchPath } from "../../../src/commands/controller/unreleased-launch.js";
import { launchControllerProcess } from "../../../src/commands/worker/backends/controller-process.js";

const roots: string[] = [];
const children: { child: ChildProcess; closed: Promise<unknown> }[] = [];
afterEach(async () => {
  for (const { child, closed } of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await bounded(closed);
  }
  vi.resetAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const bounded = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, new Promise<never>((_, reject) => {
  const timer = setTimeout(() => reject(new Error("bootstrap timeout")), 4000); timer.unref();
})]);

const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/controller-process-gate");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "h-")); roots.push(root);
  const launchId = randomUUID(), executionId = randomUUID();
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId, executionId, controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), testExecutionId: executionId, ownerUserId: randomUUID(), initialInput: "none", executionGeneration: "1", serverOrigin: "https://daynight.example", provider: "codex", cwd: root, nativeHome: root, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "", resumeNativeSessionId: null, credentialFile: path.join(root, "grant.json"), ipcEndpoint: path.join(root, "ipc.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const directory = controllerExecutionDirectory(root, executionId);
  await mkdir(directory, { recursive: true });
  await mkdir(path.dirname(controllerTicketPath(root, launchId)), { recursive: true });
  const bootstrap = path.join(root, "controller-bootstrap.js"), marker = path.join(root, "provider-started.json");
  const source = await readFile(path.resolve(import.meta.dirname, "../../../src/commands/worker/backends/controller-bootstrap.ts"), "utf8");
  await writeFile(bootstrap, stripTypeScriptTypes(source));
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "dist/main.js"), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv));\n`);
  await writeFile(path.join(root, "package.json"), '{"type":"module"}');
  const { spawn: spawnProcess } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  let originalChild!: ChildProcess, ready!: Promise<unknown>;
  controlled.prepare.mockReturnValue({ kind: "prepared", snapshot: null, legacyTimelineCleanupPending: false });
  controlled.spawn.mockImplementation((file, args, options) => {
    // The test transpiles the actual bootstrap into its isolated directory.
    originalChild = spawnProcess(file, [bootstrap, ...args.slice(1)], options);
    ready = bounded(once(originalChild, "message"));
    const closed = once(originalChild, "exit"); children.push({ child: originalChild, closed });
    return originalChild;
  });
  const actual = await vi.importActual<typeof import("../../../src/commands/controller/linux-controller-launch.js")>("../../../src/commands/controller/linux-controller-launch.js");
  controlled.capture.mockImplementation(async (pid: number, id: string) => { await ready; return actual.captureLinuxControllerLaunch(pid, id); });
  const abort = new AbortController();
  const cleanups = new Set<(deadline: number) => Promise<void>>();
  const options = { homeDirectory: root, packageDirectory: root, ticket, env: { ...process.env }, signal: abort.signal,
    retainBirthCleanup: (cleanup: (deadline: number) => Promise<void>) => { cleanups.add(cleanup); return () => { cleanups.delete(cleanup); }; },
    onSubmitting: vi.fn(), onSpawned: vi.fn(), onObserved: vi.fn() };
  return { root, ticket, bootstrap, marker, abort, options, cleanups, child: () => originalChild, ready: () => ready };
};

const linuxTest = test.skipIf(process.platform !== "linux");

linuxTest.each(["capture", "write", "cancel"])("confirms the original gate exited and persists its receipt after %s failure", async failureMode => {
  const f = await fixture(), failure = new Error(`${failureMode} failed`);
  if (failureMode === "capture") controlled.capture.mockImplementationOnce(async () => { await f.ready(); throw failure; });
  if (failureMode === "write") f.options.onSpawned.mockImplementationOnce(() => { throw failure; });
  if (failureMode === "cancel") f.options.onSpawned.mockImplementationOnce(() => { f.abort.abort(failure); });
  await expect(launchControllerProcess(f.options)).rejects.toBe(failure);
  const child = f.child();
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  expect(f.cleanups.size).toBe(0);
  expect(controlled.reconcile).not.toHaveBeenCalled();
  await expect(readFile(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readUnreleasedLaunch(f.root, f.ticket)).toEqual({ kind: "controller-unreleased", ticketHash: controllerPayloadHash(f.ticket), pid: child.pid });
  const args = controlled.spawn.mock.calls[0]![1];
  expect(args).toEqual([expect.stringContaining("controller-bootstrap.js"), path.join(f.root, "dist/main.js"), "codex", "--launch-id", f.ticket.launchId, expect.stringContaining("controller.log")]);
}, 20000);

linuxTest("keeps an uncertain release unconfirmed even when the gate receives it", async () => {
  const f = await fixture(), failure = new Error("release result unknown");
  f.options.onSpawned.mockImplementationOnce(() => {
    const child = f.child(), send = child.send!.bind(child);
    child.send = ((message: Serializable) => { send(message); throw failure; }) as typeof child.send;
  });
  await expect(launchControllerProcess(f.options)).rejects.toBe(failure);
  await bounded(children[0]!.closed);
  expect(JSON.parse(await readFile(f.marker, "utf8"))).toEqual([process.execPath, path.join(f.root, "dist/main.js"), "controller", "codex", "--launch-id", f.ticket.launchId]);
  expect(await readUnreleasedLaunch(f.root, f.ticket)).toBeUndefined();
  expect(f.cleanups.size).toBe(0);
  expect(controlled.reconcile).not.toHaveBeenCalled();
}, 15000);

linuxTest("retains cleanup responsibility when receipt publication fails after exit", async () => {
  const f = await fixture(), failure = new Error("birth proof failed");
  await mkdir(unreleasedLaunchPath(f.root, f.ticket));
  f.options.onSpawned.mockImplementationOnce(() => { throw failure; });
  const result = await launchControllerProcess(f.options).catch(error => error);
  expect(result).toBeInstanceOf(AggregateError);
  expect(result).toMatchObject({ message: "Controller launch failed with retained original birth handles.", cause: failure });
  expect(result.errors[1]).toMatchObject({ message: expect.stringMatching(/private regular file|EISDIR/) });
  expect(f.child().exitCode !== null || f.child().signalCode !== null).toBe(true);
  expect(f.cleanups.size).toBe(1);
  await expect(readUnreleasedLaunch(f.root, f.ticket)).rejects.toThrow();
  await expect(readFile(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
}, 20000);

linuxTest("accepts legacy positional bootstrap arguments and forwards the original launch id", async () => {
  const f = await fixture();
  const { spawn: spawnProcess } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const child = spawnProcess(process.execPath, [f.bootstrap, path.join(f.root, "dist/main.js"), "codex", f.ticket.launchId, path.join(f.root, "controller.log")], { cwd: f.root, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const closed = once(child, "exit"); children.push({ child, closed });
  expect((await bounded(once(child, "message")))[0]).toEqual({ kind: "waiting", launchId: f.ticket.launchId });
  child.send!({ launchId: f.ticket.launchId });
  await bounded(closed);
  expect(JSON.parse(await readFile(f.marker, "utf8"))).toEqual([process.execPath, path.join(f.root, "dist/main.js"), "controller", "codex", "--launch-id", f.ticket.launchId]);
}, 15000);
