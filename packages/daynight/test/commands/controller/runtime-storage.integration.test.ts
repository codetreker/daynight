import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { expect, test, vi } from "vitest";
import { controllerExecutionDirectory, writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { acquireControllerStoragePermit, assertControllerStoragePermit } from "../../../src/commands/controller/storage-lock.js";

const waitForExit = <T>(exited: Promise<T>, diagnostics: () => string): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Controller process did not exit: ${diagnostics()}`)), 10_000);
  void exited.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

test.each(["permit", "ownership-gate"] as const)("a real Controller waiting for %s contention cancels before publishing its generation", async contention => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/runtime-storage");
  await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")), stateDirectory = path.join(home, "state");
  vi.stubEnv("DN_CONFIG_DIR", stateDirectory);
  const executionId = randomUUID();
  const ticket: ControllerLaunchTicket = {
    schemaVersion: 1, launchId: randomUUID(), executionId, controllerId: randomUUID(), controllerInstanceId: randomUUID(),
    sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", testExecutionId: executionId, ownerUserId: randomUUID(),
    provider: "codex", cwd: home, nativeHome: path.join(home, "native"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 0 },
    initialInput: "none", initialOperationId: randomUUID(), initialPrompt: "", resumeNativeSessionId: null,
    credentialFile: path.join(home, "credential.json"), ipcEndpoint: process.platform === "win32" ? String.raw`\\.\pipe\daynight-storage-${randomUUID()}` : path.join(home, "ipc.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString(),
  };
  let child: ChildProcess | undefined, exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let permit: ReturnType<typeof acquireControllerStoragePermit> | undefined, gate: Database.Database | undefined;
  let stderr = "", stdout = "", failed = false, primary: unknown;
  try {
    await writeLaunchTicket(home, ticket);
    const directory = controllerExecutionDirectory(home, executionId), journal = path.join(directory, "journal.sqlite"), lock = path.join(directory, "storage.lock");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    permit = acquireControllerStoragePermit(journal);
    const originalLock = await readFile(lock, "utf8");
    if (contention === "ownership-gate") {
      gate = new Database(journal);
      gate.exec("BEGIN IMMEDIATE");
    }
    const startedAt = Date.now();
    child = spawn(process.execPath, ["--experimental-transform-types", fileURLToPath(new URL("../../fixtures/controller-storage-wait.mjs", import.meta.url)), home, ticket.launchId], {
      cwd: home, env: { ...process.env, DN_CONFIG_DIR: stateDirectory }, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
    });
    const processChild = child;
    exited = new Promise((resolve, reject) => {
      processChild.once("error", reject);
      processChild.once("close", (code, signal) => resolve({ code, signal }));
    });
    void exited.catch(() => {});
    child.stdout!.on("data", chunk => { stdout += String(chunk); });
    child.stderr!.on("data", chunk => { stderr += String(chunk); });
    await new Promise<void>((resolve, reject) => {
      const marker = "Controller storage is busy; the original launch is waiting.\n";
      const cleanup = (): void => { clearTimeout(timer); processChild.stderr!.off("data", observe); processChild.off("error", failure); processChild.off("close", closed); };
      const observe = (): void => { if (stderr.includes(marker)) { cleanup(); resolve(); } };
      const failure = (error: Error): void => { cleanup(); reject(error); };
      const closed = (): void => { cleanup(); reject(new Error(`Controller exited before storage contention: ${stderr}\n${stdout}`)); };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Controller did not reach storage contention: ${stderr}\n${stdout}`)); }, 15_000);
      processChild.stderr!.on("data", observe); processChild.once("error", failure); processChild.once("close", closed); observe();
    });
    if (contention === "ownership-gate") expect(Date.now() - startedAt).toBeGreaterThanOrEqual(5000);
    expect(child.exitCode).toBeNull();
    assertControllerStoragePermit(permit, journal);
    child.send("stop");
    expect(await waitForExit(exited, () => `${stderr}\n${stdout}`)).toEqual({ code: 0, signal: null });
    expect(stdout).toBe("controller-returned\n");
    expect(stderr.match(/Controller storage is busy;/g)).toHaveLength(1);
    expect(stderr).not.toContain("sqlite-migration-started");
    expect(await readFile(lock, "utf8")).toBe(originalLock);
    assertControllerStoragePermit(permit, journal);
    if (gate) { gate.exec("ROLLBACK"); gate.close(); gate = undefined; }
    const journalRead = new Database(journal, { readonly: true, fileMustExist: true });
    try {
      expect(journalRead.pragma("user_version", { simple: true })).toBe(0);
      expect(journalRead.prepare("SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all()).toEqual([]);
    } finally { journalRead.close(); }
    expect((await readdir(directory)).sort()).toEqual(["journal.sqlite", "storage.lock"]);
    await expect(stat(ticket.nativeHome)).rejects.toMatchObject({ code: "ENOENT" });
    permit.release(); permit = undefined;
    await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
    const next = acquireControllerStoragePermit(journal); next.release();
  } catch (error) { failed = true; primary = error; throw error; }
  finally {
    const failures: unknown[] = [];
    try {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (exited) await waitForExit(exited, () => `${stderr}\n${stdout}`);
    } catch (error) { failures.push(error); }
    if (gate) { try { gate.exec("ROLLBACK"); gate.close(); } catch (error) { failures.push(error); } }
    if (permit) try { permit.release(); } catch (error) { failures.push(error); }
    vi.unstubAllEnvs();
    if (failures.length > 0) throw new AggregateError(failed ? [primary, ...failures] : failures, `Controller storage fixture cleanup failed: ${stderr}\n${stdout}`, failed ? { cause: primary } : undefined);
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);
