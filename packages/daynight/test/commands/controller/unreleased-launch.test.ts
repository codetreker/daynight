import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as durableDirectory from "../../../src/platform/durable-directory.js";
import { controllerPayloadHash, controllerTicketPath, writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { readUnreleasedLaunch, unreleasedLaunchPath, writeUnreleasedLaunch } from "../../../src/commands/controller/unreleased-launch.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const fixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daynight-unreleased-")); roots.push(root);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: root, nativeHome: path.join(root, "native"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "original", resumeNativeSessionId: null, credentialFile: path.join(root, "grant.json"), ipcEndpoint: process.platform === "win32" ? `\\\\.\\pipe\\${randomUUID()}` : path.join(root, "ipc.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  await writeLaunchTicket(root, ticket);
  return { root, ticket, file: unreleasedLaunchPath(root, ticket) };
};

it("publishes a private receipt beside the ticket and accepts an identical repeat", async () => {
  const { root, ticket, file } = await fixture();
  expect(file).toBe(path.join(path.dirname(controllerTicketPath(root, ticket.launchId)), `${ticket.launchId}.unreleased.json`));
  expect(await readUnreleasedLaunch(root, ticket)).toBeUndefined();
  const expected = { kind: "controller-unreleased", ticketHash: controllerPayloadHash(ticket), pid: 1234 };
  expect(await writeUnreleasedLaunch(root, ticket, 1234)).toEqual(expected);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual(expected);
  const bytes = await readFile(file);
  expect(await writeUnreleasedLaunch(root, ticket, 1234)).toEqual(expected);
  expect(await readFile(file)).toEqual(bytes);
  expect(await readUnreleasedLaunch(root, ticket)).toEqual(expected);
  expect((await readdir(path.dirname(file))).filter(name => name.endsWith(".tmp"))).toEqual([]);
});

it("retains the original evidence on a different PID or changed ticket", async () => {
  const { root, ticket, file } = await fixture();
  await writeUnreleasedLaunch(root, ticket, 1234);
  const original = await readFile(file);
  await expect(writeUnreleasedLaunch(root, ticket, 1235)).rejects.toThrow(/conflict/i);
  const changed = { ...ticket, configuration: { ...ticket.configuration, args: ["changed"] } };
  await expect(readUnreleasedLaunch(root, changed)).rejects.toThrow(/conflict/i);
  await expect(writeUnreleasedLaunch(root, changed, 1234)).rejects.toThrow(/conflict/i);
  expect(await readFile(file)).toEqual(original);
});

it("atomically picks one concurrent result without overwriting it", async () => {
  const { root, ticket } = await fixture();
  const results = await Promise.allSettled([writeUnreleasedLaunch(root, ticket, 111), writeUnreleasedLaunch(root, ticket, 222)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  const winner = results.find(result => result.status === "fulfilled");
  expect(await readUnreleasedLaunch(root, ticket)).toEqual(winner!.value);
});

it("accepts concurrent identical publications", async () => {
  const { root, ticket } = await fixture();
  const receipts = await Promise.all([writeUnreleasedLaunch(root, ticket, 111), writeUnreleasedLaunch(root, ticket, 111)]);
  expect(receipts[0]).toEqual(receipts[1]);
  expect(await readUnreleasedLaunch(root, ticket)).toEqual(receipts[0]);
});

it.each([0, -1, 1.5, 2_147_483_648, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid PID %s without publication", async pid => {
  const { root, ticket } = await fixture();
  await expect(writeUnreleasedLaunch(root, ticket, pid)).rejects.toThrow(/invalid/i);
  expect(await readUnreleasedLaunch(root, ticket)).toBeUndefined();
});

it.each([
  "{", "null", "[]", "{}", JSON.stringify({ kind: "other", ticketHash: "a".repeat(64), pid: 1 }),
  JSON.stringify({ kind: "controller-unreleased", ticketHash: "A".repeat(64), pid: 1 }),
  JSON.stringify({ kind: "controller-unreleased", ticketHash: "a".repeat(64), pid: 0 }),
  "x".repeat(1025),
])("rejects malformed or oversized existing evidence", async content => {
  const { root, ticket, file } = await fixture();
  await writeFile(file, content, { mode: 0o600 });
  await expect(readUnreleasedLaunch(root, ticket)).rejects.toThrow();
  await expect(writeUnreleasedLaunch(root, ticket, 1234)).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe(content);
});

it("rejects extra fields and invalid PIDs even with the correct ticket hash", async () => {
  const { root, ticket, file } = await fixture();
  for (const value of [
    { kind: "controller-unreleased", ticketHash: controllerPayloadHash(ticket), pid: 1, extra: true },
    { kind: "controller-unreleased", ticketHash: controllerPayloadHash(ticket), pid: 1.5 },
  ]) {
    await writeFile(file, JSON.stringify(value), { mode: 0o600 });
    await expect(readUnreleasedLaunch(root, ticket)).rejects.toThrow();
  }
});

it("rejects duplicate JSON fields rather than accepting the last value", async () => {
  const { root, ticket, file } = await fixture();
  await writeFile(file, `{"kind":"other","kind":"controller-unreleased","ticketHash":"${controllerPayloadHash(ticket)}","pid":1}`, { mode: 0o600 });
  await expect(readUnreleasedLaunch(root, ticket)).rejects.toThrow(/duplicate/);
  await expect(writeUnreleasedLaunch(root, ticket, 1)).rejects.toThrow(/duplicate/);
});

it.skipIf(process.platform === "win32")("rejects public files, symlinks, and directories", async () => {
  const { root, ticket, file } = await fixture();
  await writeFile(file, "{}", { mode: 0o644 }); await chmod(file, 0o644);
  await expect(readUnreleasedLaunch(root, ticket)).rejects.toThrow(/private/);
  await rm(file); await symlink(controllerTicketPath(root, ticket.launchId), file);
  await expect(readUnreleasedLaunch(root, ticket)).rejects.toThrow();
  await rm(file); await mkdir(file);
  await expect(readUnreleasedLaunch(root, ticket)).rejects.toThrow(/regular/);
});

it("does not report success when directory durability is unknown and permits an identical durable retry", async () => {
  const { root, ticket } = await fixture();
  const sync = vi.spyOn(durableDirectory, "syncDurableDirectory").mockImplementationOnce(() => { throw new Error("directory sync failed"); });
  await expect(writeUnreleasedLaunch(root, ticket, 99)).rejects.toThrow("directory sync failed");
  sync.mockImplementationOnce(() => { throw new Error("read sync failed"); });
  await expect(readUnreleasedLaunch(root, ticket)).rejects.toThrow("read sync failed");
  expect((await readUnreleasedLaunch(root, ticket))?.pid).toBe(99);
  expect(await writeUnreleasedLaunch(root, ticket, 99)).toMatchObject({ pid: 99 });
  expect(sync).toHaveBeenCalledTimes(4);
});
