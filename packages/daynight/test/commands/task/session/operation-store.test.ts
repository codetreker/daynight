import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { createOperationStore, sessionBodyHash } from "../../../../src/commands/task/session/operation-store.js";
import type { OperationStore, SessionOperationRecord } from "../../../../src/commands/task/session/operation-store.js";
import { actorId, origin, inspection, operationId, projectId, sessionId, taskId } from "./fixtures.js";
let root: string;
const stores: OperationStore[] = [];
const aclProcessMs = 10_000;
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });
beforeAll(async () => { const tmp = fileURLToPath(new URL("../../../../../../.tmp/", import.meta.url)); await mkdir(tmp, { recursive: true }); root = await mkdtemp(path.join(tmp, "session-store-")); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
const base: SessionOperationRecord = { schemaVersion: 1, origin, actorId, projectId, taskId, sessionId, operationId, fence: inspection.fence, expectedTurnId: null, bodySha256: sessionBodyHash("body"), createdAt: "2026-11-10T01:02:03Z", updatedAt: "2026-11-10T01:02:03Z", phase: "prepared", receipt: null };
const create = async (directory?: string) => {
  directory ??= await mkdtemp(path.join(root, "record-"));
  const store = await createOperationStore(directory, origin, actorId, operationId); stores.push(store);
  return { directory, store, actor: path.join(directory, "session-operations", sessionBodyHash(origin), actorId) };
};
it("privately creates and durably replaces records without changing the existing parent", async () => {
  const f = await create(), parent = await stat(f.directory);
  expect(await f.store.read()).toBeUndefined(); await f.store.acquire(); await f.store.write(base);
  expect(await f.store.read()).toEqual(base);
  await f.store.write({ ...base, phase: "dispatch_unknown" }); await f.store.close();
  expect((await stat(f.directory)).mode).toBe(parent.mode);
  const next = await createOperationStore(f.directory, origin, actorId, operationId); expect(await next.read()).toMatchObject({ phase: "dispatch_unknown" }); await next.close();
  if (process.platform !== "win32") {
    for (const dir of [path.join(f.directory, "session-operations"), path.dirname(f.actor), f.actor]) expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(f.actor, `${operationId}.json`))).mode & 0o777).toBe(0o600);
  }
});
it("isolates current actor and normalized server origin", async () => {
  const f = await create(); await f.store.acquire(); await f.store.write(base); await f.store.close();
  const normalized = await createOperationStore(f.directory, `${origin}/`, actorId, operationId); expect(await normalized.read()).toEqual(base); await normalized.close();
  for (const [server, actor] of [["http://127.0.0.1:8788", actorId], [origin, projectId]]) { const other = await createOperationStore(f.directory, server!, actor!, operationId); expect(await other.read()).toBeUndefined(); await other.close(); }
});
it("rejects extra record fields, foreign identity and unknown persisted error text", async () => {
  const f = await create(); await f.store.acquire();
  for (const value of [{ ...base, text: "SECRET" }, { ...base, actorId: projectId }, { ...base, phase: "receipt", receipt: { state: "failed", providerResult: null, errorCode: "SECRET" } }]) await expect(f.store.write(value as SessionOperationRecord)).rejects.toThrow();
  expect(await f.store.read()).toBeUndefined(); await f.store.close();
});
it.skipIf(process.platform === "win32")("rejects unsafe permissions and symlink records without repairing them", async () => {
  const f = await create(); await f.store.acquire(); await f.store.write(base); await f.store.close();
  const target = path.join(f.actor, `${operationId}.json`); await chmod(target, 0o644);
  await expect(f.store.read()).rejects.toThrow(); expect((await stat(target)).mode & 0o777).toBe(0o644);
  await rm(target); const foreign = path.join(f.directory, "foreign"); await writeFile(foreign, JSON.stringify(base), { mode: 0o600 }); await symlink(foreign, target); await expect(f.store.read()).rejects.toThrow();
});
it("excludes a second real process and releases the kernel lock after process death", async () => {
  const f = await create();
  const moduleUrl = new URL("../../../../dist/commands/task/session/operation-store.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `const { createOperationStore } = await import(${JSON.stringify(moduleUrl)}); const store = await createOperationStore(...JSON.parse(process.argv[1])); await store.acquire(); process.send('locked'); setInterval(() => {}, 1000);`, JSON.stringify([f.directory, origin, actorId, operationId])], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let errors = ""; child.stderr!.on("data", chunk => { errors += String(chunk); });
  try {
    const ready = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(errors || "Lock child exited."); }), new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Lock child readiness timed out.")), 10_000); timer.unref(); })]);
    expect(ready[0]).toBe("locked");
    await expect(f.store.acquire()).rejects.toThrow(); await f.store.close();
    // Read-only recovery is independent of the submission lock.
    expect(await f.store.read()).toBeUndefined();
    const ended = once(child, "exit"); child.kill("SIGKILL"); await ended;
    await f.store.acquire(); await f.store.write(base); await f.store.close(); expect(await f.store.read()).toEqual(base);
  } finally { if (child.exitCode === null && child.signalCode === null) { const ended = once(child, "exit"); child.kill("SIGKILL"); await ended; } await f.store.close(); }
});
it.each(["prepared", "dispatch_unknown"] as const)("recovers a real child-process crash after %s without losing its original fence", async phase => {
  const f = await create(), record = { ...base, phase };
  const moduleUrl = new URL("../../../../dist/commands/task/session/operation-store.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `const { createOperationStore } = await import(${JSON.stringify(moduleUrl)}); const [args,record] = JSON.parse(process.argv[1]); const store = await createOperationStore(...args); await store.acquire(); await store.write(record); process.exit(19);`, JSON.stringify([[f.directory, origin, actorId, operationId], record])], { stdio: ["ignore", "pipe", "pipe"] });
  let errors = ""; child.stderr!.on("data", chunk => { errors += String(chunk); });
  const [code] = await once(child, "exit"); expect(code, errors).toBe(19); expect(await f.store.read()).toEqual(record); await f.store.close();
});
it.skipIf(process.platform !== "win32")("uses real protected current-user Windows DACLs and rejects an added public ACE", async () => {
  const f = await create(); await f.store.acquire(); await f.store.write(base); await f.store.close();
  const { execFile } = await import("node:child_process"), { promisify } = await import("node:util");
  const execute = promisify(execFile), target = path.join(f.actor, `${operationId}.json`);
  const runNative = async (stage: string, executable: string, args: string[], environment?: NodeJS.ProcessEnv) => {
    const started = performance.now();
    process.stderr.write(`${JSON.stringify({ kind: "session-acl-probe", stage, state: "started", deadlineMs: aclProcessMs })}\n`);
    const pending = execute(executable, args, { timeout: aclProcessMs, killSignal: "SIGKILL", ...(environment === undefined ? {} : { env: environment }) });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => pending.child.once("close", (code, signal) => resolve({ code, signal })));
    try {
      const output = await pending, exit = await closed;
      expect(exit, `${stage} process must exit successfully`).toEqual({ code: 0, signal: null });
      process.stderr.write(`${JSON.stringify({ kind: "session-acl-probe", stage, state: "completed", elapsedMs: Math.round(performance.now() - started), ...exit })}\n`);
      return output;
    } catch (cause) {
      const exit = await closed;
      throw new Error(`Windows ACL ${stage} failed after process close (code=${exit.code}, signal=${exit.signal}).`, { cause });
    }
  };
  // Windows PowerShell's .NET Framework reads the OS ACL without module autoloading.
  const script = `
$ErrorActionPreference = 'Stop'
$acl = [System.IO.File]::GetAccessControl($env:DAYNIGHT_ACL_PROBE, [System.Security.AccessControl.AccessControlSections]::Access)
$rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if (!$acl.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid -or $rules[0].IsInherited -or $rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $rules[0].FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { throw 'Unexpected ACL' }
[Console]::WriteLine('private')
`;
  const observed = await runNative("private-acl-readback", "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { ...process.env, DAYNIGHT_ACL_PROBE: target });
  expect(observed.stdout.trim()).toBe("private");
  await runNative("public-ace-grant", "icacls.exe", [target, "/grant", "*S-1-1-0:(R)"]);
  await expect(f.store.read()).rejects.toThrow("exactly one current-user allow ACE");
  process.stderr.write(`${JSON.stringify({ kind: "session-acl-probe", stage: "unsafe-acl-rejection", state: "completed" })}\n`);
}, 2 * aclProcessMs + 5_000);

it.skipIf(process.platform !== "win32")("durably writes and recovers Windows records whose directory and files exceed MAX_PATH", async () => {
  const directory = path.join(root, "deep-state-" + "x".repeat(110), "next-level-" + "y".repeat(110));
  await mkdir(directory, { recursive: true });
  expect(directory.length).toBeGreaterThan(260);
  const f = await create(directory);
  await f.store.acquire(); await f.store.write(base);
  await f.store.write({ ...base, phase: "dispatch_unknown" }); await f.store.close();
  expect(await f.store.read()).toMatchObject({ phase: "dispatch_unknown", fence: base.fence });
  expect((await readdir(f.actor)).toSorted()).toEqual([`${operationId}.json`, `${operationId}.lock`].toSorted());
});
it.skipIf(process.platform !== "win32")("preserves a failed native create and cleans only its own created temporary file", async () => {
  const f = await create(); await f.store.acquire(); await f.store.close();
  const { loadWindowsOperationFiles } = await import("../../../../src/commands/task/session/windows-files.js");
  const directory = await (await loadWindowsOperationFiles()).open(f.actor, false);
  if (directory === undefined) throw new Error("Missing prepared native directory.");
  try {
    const before = await readdir(f.actor);
    await expect(directory.replace("invalid<record>.json", Buffer.from("record"))).rejects.toMatchObject({ stage: "open", win32Code: 123 });
    expect(await readdir(f.actor)).toEqual(before);
    // The target directory cannot be replaced by a file; the private temporary has already been created and flushed.
    await mkdir(path.join(f.actor, "existing-directory"));
    await expect(directory.replace("existing-directory", Buffer.from("record"))).rejects.toMatchObject({ stage: "open" });
    expect((await readdir(f.actor)).toSorted()).toEqual([...before, "existing-directory"].toSorted());
  } finally { await directory.close(); }
});
