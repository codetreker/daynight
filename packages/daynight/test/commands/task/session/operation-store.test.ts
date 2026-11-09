import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createOperationStore, sessionBodyHash } from "../../../../src/commands/task/session/operation-store.js";
import type { SessionOperationRecord } from "../../../../src/commands/task/session/operation-store.js";
import { actorId, origin, inspection, operationId, projectId, sessionId, taskId } from "./fixtures.js";
let root: string;
beforeAll(async () => { const tmp = fileURLToPath(new URL("../../../../../../.tmp/", import.meta.url)); await mkdir(tmp, { recursive: true }); root = await mkdtemp(path.join(tmp, "session-store-")); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
const base: SessionOperationRecord = { schemaVersion: 1, origin, actorId, projectId, taskId, sessionId, operationId, fence: inspection.fence, expectedTurnId: null, bodySha256: sessionBodyHash("body"), createdAt: "2026-11-10T01:02:03Z", updatedAt: "2026-11-10T01:02:03Z", phase: "prepared", receipt: null };
const create = async () => { const directory = await mkdtemp(path.join(root, "record-")); return { directory, store: await createOperationStore(directory, origin, actorId, operationId), actor: path.join(directory, "session-operations", sessionBodyHash(origin), actorId) }; };
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
  const script = "$ErrorActionPreference='Stop'; $a=Get-Acl -LiteralPath $env:DAYNIGHT_ACL_PROBE; $s=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; if (!$a.AreAccessRulesProtected -or $a.Access.Count -ne 1 -or $a.Access[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $s -or $a.Access[0].IsInherited) { throw 'Unexpected ACL' }; Write-Output 'private'";
  const observed = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, DAYNIGHT_ACL_PROBE: target }, timeout: 10_000 }); expect(observed.stdout.trim()).toBe("private");
  await execute("icacls.exe", [target, "/grant", "*S-1-1-0:(R)"], { timeout: 10_000 });
  await expect(f.store.read()).rejects.toThrow();
});
