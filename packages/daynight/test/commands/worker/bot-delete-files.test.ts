import { openMediaBudgetLedger } from "../../../src/commands/controller/media/budget-ledger.js";
import Database from "better-sqlite3";
import { createServer } from "node:net";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureBotDeletionFiles, removeBotDeletionFile, type BotDeletionTarget } from "../../../src/commands/worker/bots/delete-files.js";
import { controllerExecutionDirectory, controllerTicketPath, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { resolveControllerIpcEndpoint } from "../../../src/commands/controller/paths.js";
import type { BotExecution } from "../../../src/commands/worker/bots/execution-store.js";
import { removeHerdrSourceDirectory } from "../../../src/commands/worker/resource-disposal.js";
import type { BotRecord } from "../../../src/commands/worker/bots/types.js";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const signal = () => new AbortController().signal;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/t15/files");
  await mkdir(base, { recursive: true });
  const home = await realpath(await mkdtemp(path.join(base, "h-")));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  vi.stubEnv("DN_CONFIG_DIR", path.join(home, "state"));
  const executionId = id(5), launchId = id(6), previousId = id(7);
  const directory = controllerExecutionDirectory(home, executionId), ticket = controllerTicketPath(home, launchId), previousTicket = controllerTicketPath(home, previousId);
  const alias = path.join(home, "state", "agent-cli-aliases", "execution-current");
  const retainedAlias = path.join(home, "state", "agent-cli-aliases", "execution-previous");
  const state = path.join(home, "state", "bots", id(3), "state");
  for (const target of [state, directory, path.dirname(ticket), alias, retainedAlias]) await mkdir(target, { recursive: true });
  for (const target of [path.join(state, "claim.json"), ticket, previousTicket, path.join(directory, "journal.sqlite"), path.join(directory, "journal.sqlite-wal"), path.join(directory, "credential.json"), path.join(directory, "pending.json"), path.join(directory, "receipt.json"), path.join(alias, "daynight"), path.join(retainedAlias, "dn")]) await writeFile(target, "private");
  const record: BotRecord = {
    owner: { serverOrigin: "https://daynight.example", ownerUserId: id(1), workerId: id(2) }, botId: id(3), observedAt: 1,
    observed: { id: id(3), workerId: id(2), version: "2", deletion: { deletionId: id(4), requestedVersion: "1", workerCleanup: { state: "pending", code: null }, serverCleanup: { state: "pending", code: null } } }, definition: null,
    intent: { botVersion: "1", registration: { protocol: "daynight.session.v1", schemaVersion: 1, projectionVersion: 1, registrationId: id(8), testExecutionId: executionId, controllerId: id(9), controllerInstanceId: id(10), provider: "codex", initialInput: "none" },
      launchId, executionId, initialOperationId: id(11), controllerInstanceId: id(10), sessionId: id(12), executionGeneration: "2", nativeSessionId: id(13),
      ticketPath: ticket, journalPath: path.join(directory, "journal.sqlite"), credentialFile: path.join(directory, "credential.json"), recoveryLimit: 3, roleConfiguration: null },
  };
  const execution: BotExecution = { launchId, executionId, executionGeneration: "2", launchSubmission: "acknowledged", controllerProcess: null, snapshot: null, aliasDirectory: alias, lastError: null, startup: null,
    recoveryCount: 0, restartAfterShutdown: false, recoveryBlocked: null, previous: null, retainedLaunchIds: [previousId], retainedAliasDirectories: [retainedAlias] };
  const ticketValue: ControllerLaunchTicket = { schemaVersion: 1, launchId, executionId, testExecutionId: executionId, controllerId: id(9), controllerInstanceId: id(10), sessionId: id(12), executionGeneration: "2", serverOrigin: record.owner.serverOrigin, ownerUserId: id(1), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 3 }, initialInput: "none", initialOperationId: id(11), initialPrompt: "", resumeNativeSessionId: id(13), credentialFile: record.intent!.credentialFile, ipcEndpoint: resolveControllerIpcEndpoint(home, launchId), ipcSecret: "a".repeat(64), createdAt: "2026-11-05T00:00:00Z" };
  const ticketContent = JSON.stringify(ticketValue);
  await writeFile(ticket, ticketContent, { mode: 0o600 }); await chmod(ticket, 0o600);
  await writeFile(previousTicket, JSON.stringify({ ...ticketValue, launchId: previousId, ipcEndpoint: resolveControllerIpcEndpoint(home, previousId), executionGeneration: "1", controllerInstanceId: id(14), resumeNativeSessionId: null }), { mode: 0o600 }); await chmod(previousTicket, 0o600);
  return { home, state, directory, ticket, previousTicket, alias, retainedAlias, record, execution, ticketValue, ticketContent };
};
const metadata = async (target: string) => { const entry = await lstat(target, { bigint: true }); return `${entry.dev}:${entry.ino}`; };
const captured = async (target: string, kind: BotDeletionTarget["kind"]): Promise<BotDeletionTarget> => ({ path: target, root: path.dirname(target), kind, identity: await metadata(target), rootIdentity: await metadata(path.dirname(target)), completed: false });

describe("Bot private file deletion", () => {
  it("captures only owned execution, launch and aliases while leaving cwd, native home and task worktrees intact", async () => {
    const f = await fixture();
    const unrelated = [path.join(f.home, "state", "bots", id(4), "state"), path.join(f.home, "state", "bots", id(3), "other"), path.join(f.home, "cwd"), path.join(f.home, ".codex"), path.join(f.home, ".worktrees", "task"), controllerExecutionDirectory(f.home, id(50))];
    for (const directory of unrelated) { await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, "keep"), "keep"); }
    const targets = await captureBotDeletionFiles(f.home, f.record, f.execution, signal());
    expect(targets.filter(target => !target.completed).map(target => target.path).sort()).toEqual([f.state, f.directory, f.ticket, f.previousTicket, f.alias, f.retainedAlias].sort());
    if (process.platform === "win32") {
      expect(f.ticketValue.ipcEndpoint.startsWith("\\\\.\\pipe\\")).toBe(true);
      expect(targets).toHaveLength(6);
      expect(targets.some(target => target.kind === "socket" || target.path === f.ticketValue.ipcEndpoint)).toBe(false);
    } else {
      expect(targets.filter(target => target.kind === "socket")).toHaveLength(2);
    }
    for (const target of targets) await removeBotDeletionFile(target, signal());
    for (const target of [f.state, f.directory, f.ticket, f.previousTicket, f.alias, f.retainedAlias]) await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    for (const directory of unrelated) expect(await readFile(path.join(directory, "keep"), "utf8")).toBe("keep");
  });


  it("captures private state created before a launch intent while preserving unrelated state", async () => {
    const f = await fixture();
    f.record.intent = null;
    const targets = await captureBotDeletionFiles(f.home, f.record, null, signal());
    expect(targets.map(target => target.path)).toEqual([f.state]);
    await removeBotDeletionFile(targets[0]!, signal());
    await expect(lstat(f.state)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(f.ticket, "utf8")).toBe(f.ticketContent);
  });

  it.each(["state", "bot root"])("rejects symbolic %s during private state capture", async kind => {
    const f = await fixture();
    const target = kind === "state" ? f.state : path.dirname(f.state);
    await rename(target, `${target}.original`);
    await symlink(`${target}.original`, target, "dir");
    await expect(captureBotDeletionFiles(f.home, f.record, f.execution, signal())).rejects.toThrow(/symbolic/);
    expect(await readFile(path.join(f.state, "claim.json"), "utf8")).toBe("private");
  });

  it.each([true, false])("protects cwd within Bot state with launch intent %s", async launched => {
    const f = await fixture(), cwd = path.join(f.state, "user-cwd");
    await mkdir(cwd); await writeFile(path.join(cwd, "keep"), "user data");
    f.record.definition = { resolvedConfiguration: { cwd } } as never;
    if (!launched) f.record.intent = null;
    await expect(captureBotDeletionFiles(f.home, f.record, launched ? f.execution : null, signal())).rejects.toThrow(/working directory/);
    expect(await readFile(path.join(cwd, "keep"), "utf8")).toBe("user data");
  });

  it("removes only canonical temporary tickets for the original current and retained launches", async () => {
    const f = await fixture();
    const owned = [`${f.ticket}.${id(70)}.tmp`, `${f.previousTicket}.${id(71)}.tmp`];
    const retained = [`${controllerTicketPath(f.home, id(90))}.${id(72)}.tmp`, `${f.ticket}.not-a-uuid.tmp`, `${f.ticket}.${id(73)}.tmp.other`];
    for (const file of [...owned, ...retained]) await writeFile(file, "private partial ticket");
    const targets = await captureBotDeletionFiles(f.home, f.record, f.execution, signal());
    for (const file of owned) expect(targets.find(target => target.path === file)).toMatchObject({ kind: "file", completed: false });
    for (const target of targets) await removeBotDeletionFile(target, signal());
    for (const file of owned) await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    for (const file of retained) expect(await readFile(file, "utf8")).toBe("private partial ticket");
  });

  it("rejects symbolic temporary tickets for an original launch", async () => {
    const f = await fixture(), user = path.join(f.home, "user"); await writeFile(user, "keep");
    await symlink(user, `${f.ticket}.${id(70)}.tmp`);
    await expect(captureBotDeletionFiles(f.home, f.record, f.execution, signal())).rejects.toThrow(/symbolic/);
    expect(await readFile(user, "utf8")).toBe("keep");
  });

  it("refuses to delete an execution directory containing the frozen working directory", async () => {
    const f = await fixture(), cwd = path.join(f.directory, "user-cwd"); await mkdir(cwd);
    f.record.definition = { id: id(3), ownerUserId: id(1), workerId: id(2), version: "1", deletion: null, name: "Bot", creationOrder: "1", requestedOverrides: {}, resolvedConfiguration: { workerId: id(2), cwd, provider: "codex", model: null, args: [] }, roleConfiguration: null, sessionId: id(12), testExecutionId: id(5), startupResult: { state: "pending", code: null }, createdAt: "2026-11-05T00:00:00Z", updatedAt: "2026-11-05T00:00:00Z" };
    await writeFile(path.join(cwd, "keep"), "user data");
    await expect(captureBotDeletionFiles(f.home, f.record, f.execution, signal())).rejects.toThrow(/working directory|cwd/);
    expect(await readFile(path.join(cwd, "keep"), "utf8")).toBe("user data");
  });

  it.each(["current", "retained"])("protects native home inside a private target declared by a %s ticket", async source => {
    const f = await fixture(), nativeHome = path.join(f.alias, "native"); await mkdir(nativeHome);
    const file = source === "current" ? f.ticket : f.previousTicket;
    const ticket = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...ticket, nativeHome }));
    await writeFile(path.join(nativeHome, "keep"), "native data");
    await expect(captureBotDeletionFiles(f.home, f.record, f.execution, signal())).rejects.toThrow(/native home/);
    expect(await readFile(path.join(nativeHome, "keep"), "utf8")).toBe("native data");
  });

  it("resolves a symlinked cwd before checking whether a private target contains it", async () => {
    const f = await fixture(), cwd = path.join(f.home, "cwd-link"), inner = path.join(f.directory, "user"); await mkdir(inner); await symlink(inner, cwd);
    const ticket = JSON.parse(await readFile(f.ticket, "utf8")); await writeFile(f.ticket, JSON.stringify({ ...ticket, cwd }));
    await expect(captureBotDeletionFiles(f.home, f.record, f.execution, signal())).rejects.toThrow(/working directory|cwd/);
    expect((await lstat(inner)).isDirectory()).toBe(true);
  });

  it.each(["ownerUserId", "serverOrigin", "testExecutionId", "controllerId", "controllerInstanceId"])("rejects a formal ticket with conflicting %s", async field => {
    const f = await fixture(), ticket = { ...f.ticketValue, [field]: field === "serverOrigin" ? "https://other.example" : id(90) };
    await writeFile(f.ticket, JSON.stringify(ticket));
    await expect(captureBotDeletionFiles(f.home, f.record, f.execution, signal())).rejects.toThrow(/ticket/);
    expect(await readFile(f.ticket, "utf8")).toBe(JSON.stringify(ticket));
  });

  it.each(["ticketPath", "journalPath", "credentialFile"] as const)("rejects a redirected %s before touching private files", async field => {
    const f = await fixture(); f.record.intent![field] = path.join(f.home, "user-data");
    await expect(captureBotDeletionFiles(f.home, f.record, f.execution, signal())).rejects.toThrow();
    expect(await readFile(f.ticket, "utf8")).toBe(f.ticketContent);
  });

  it.each(["outside", "root", "nested", "other-prefix"])("rejects %s alias directories", async variant => {
    const f = await fixture();
    f.execution.aliasDirectory = variant === "outside" ? f.home : variant === "root" ? path.dirname(f.alias) : variant === "nested" ? path.join(f.alias, "execution-child") : path.join(path.dirname(f.alias), "shared");
    await expect(captureBotDeletionFiles(f.home, f.record, f.execution, signal())).rejects.toThrow();
    expect(await readFile(f.ticket, "utf8")).toBe(f.ticketContent);
  });

  it("rejects an execution identity from another instance", async () => {
    const f = await fixture(); f.execution.launchId = id(90);
    await expect(captureBotDeletionFiles(f.home, f.record, f.execution, signal())).rejects.toThrow();
  });

  it("does not revisit a path captured as missing or already completed", async () => {
    const f = await fixture(); await rm(f.ticket);
    const target = (await captureBotDeletionFiles(f.home, f.record, f.execution, signal())).find(target => target.path === f.ticket)!;
    expect(target.completed).toBe(true); expect(target.identity).toBeNull();
    await writeFile(f.ticket, "new instance");
    await removeBotDeletionFile(target, signal());
    expect(await readFile(f.ticket, "utf8")).toBe("new instance");
    await removeBotDeletionFile({ ...await captured(f.ticket, "file"), completed: true }, signal());
    expect(await readFile(f.ticket, "utf8")).toBe("new instance");
  });

  it.each(["file", "directory"] as const)("refuses a replaced %s on a retry", async kind => {
    const f = await fixture(), targetPath = kind === "file" ? f.ticket : f.directory;
    const target = await captured(targetPath, kind);
    await rename(targetPath, `${targetPath}.original`);
    if (kind === "file") await writeFile(targetPath, "new instance");
    else { await mkdir(targetPath); await writeFile(path.join(targetPath, "keep"), "new instance"); }
    await expect(removeBotDeletionFile(target, signal())).rejects.toThrow(/identity/i);
    expect(await readFile(kind === "file" ? targetPath : path.join(targetPath, "keep"), "utf8")).toBe("new instance");
  });

  it("refuses a replaced root even when the target inode is unchanged", async () => {
    const f = await fixture(), target = await captured(f.ticket, "file");
    await rename(target.root, `${target.root}.original`); await mkdir(target.root);
    await rename(path.join(`${target.root}.original`, path.basename(f.ticket)), f.ticket);
    await expect(removeBotDeletionFile(target, signal())).rejects.toThrow(/identity/i);
    expect(await readFile(f.ticket, "utf8")).toBe(f.ticketContent);
  });

  it("treats a previously captured target now absent as removed", async () => {
    const f = await fixture(), target = await captured(f.ticket, "file");
    await rm(f.ticket); await removeBotDeletionFile(target, signal());
    await expect(lstat(f.ticket)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["root", "target"])("refuses a symbolic link at the %s during capture", async variant => {
    const f = await fixture();
    const original = variant === "root" ? path.dirname(f.ticket) : f.ticket;
    await rename(original, `${original}.real`); await symlink(`${original}.real`, original);
    await expect(captureBotDeletionFiles(f.home, f.record, f.execution, signal())).rejects.toThrow(/symbolic|physical/i);
    expect(await readFile(variant === "root" ? path.join(`${original}.real`, path.basename(f.ticket)) : `${original}.real`, "utf8")).toBe(f.ticketContent);
  });

  it("does not follow a symlink added inside the execution directory", async () => {
    const f = await fixture(), targets = await captureBotDeletionFiles(f.home, f.record, f.execution, signal());
    const userFile = path.join(f.home, "keep"); await writeFile(userFile, "user data");
    await symlink(userFile, path.join(f.directory, "outside"));
    await expect(removeBotDeletionFile(targets.find(target => target.path === f.directory)!, signal())).rejects.toThrow(/symbolic/);
    expect(await readFile(userFile, "utf8")).toBe("user data");
    expect(await readFile(path.join(f.directory, "journal.sqlite"), "utf8")).toBe("private");
  });

  it.skipIf(process.platform === "win32")("unlinks only the captured Unix socket and retains its parent", async () => {
    const f = await fixture(), socket = path.join(f.home, "socket");
    const server = createServer();
    // Relative bind avoids the Unix sockaddr length limit while keeping evidence
    // in the task's private temporary directory.
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path.relative(process.cwd(), socket), resolve); });
    cleanups.push(() => new Promise(resolve => server.close(() => resolve())));
    const target = await captured(socket, "socket");
    await removeBotDeletionFile(target, signal());
    await expect(lstat(socket)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(f.home)).isDirectory()).toBe(true);
  });

  it.skipIf(process.platform === "win32")("retains private files when permissions prevent directory cleanup", async () => {
    const f = await fixture(), target = await captured(f.directory, "directory");
    await chmod(f.directory, 0o000);
    try { await expect(removeBotDeletionFile(target, signal())).rejects.toThrow(); }
    finally { await chmod(f.directory, 0o700); }
    expect(await readFile(path.join(f.directory, "journal.sqlite"), "utf8")).toBe("private");
    await removeBotDeletionFile(target, signal());
    await expect(lstat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses an unexpected target type before capturing any deletion plan", async () => {
    const f = await fixture();
    await rm(f.ticket); await mkdir(f.ticket);
    await expect(captureBotDeletionFiles(f.home, f.record, f.execution, signal())).rejects.toThrow(/unsupported/);
    expect((await lstat(f.ticket)).isDirectory()).toBe(true);
    expect(await readFile(path.join(f.directory, "journal.sqlite"), "utf8")).toBe("private");
  });

  it("requires the captured inode inside the shared restricted directory remover", async () => {
    const f = await fixture();
    await expect(removeHerdrSourceDirectory(path.dirname(f.directory), f.directory, undefined, { rootIdentity: await metadata(path.dirname(f.directory)), sourceIdentity: "0:0" })).rejects.toThrow(/identity/);
    expect(await readFile(path.join(f.directory, "journal.sqlite"), "utf8")).toBe("private");
  });

  it("rejects cancellation before any file removal", async () => {
    const f = await fixture(), target = await captured(f.ticket, "file");
    await expect(removeBotDeletionFile(target, AbortSignal.abort())).rejects.toThrow();
    expect(await readFile(f.ticket, "utf8")).toBe(f.ticketContent);
  });
  it("releases image budget only after the complete original execution sweep, retaining pins on failure", async () => {
    const f = await fixture(), state = path.join(f.home, "state"), executionId = f.execution.executionId;
    const ledger = openMediaBudgetLedger(state, executionId); ledger.reserve(1024); ledger.close();
    const reserved = () => { const db = new Database(path.join(state, "controller", "media", "budget.sqlite")); try { return (db.prepare("SELECT reserved_bytes FROM allocations WHERE execution_id=?").get(executionId) as { reserved_bytes: number } | undefined)?.reserved_bytes ?? null; } finally { db.close(); } };
    const target = await captured(f.directory, "directory"), privateImage = path.join(f.directory, "journal.sqlite.media-staging", "native", "pinned.bin");
    await mkdir(path.dirname(privateImage), { recursive: true }); await writeFile(privateImage, "native resume pin");
    const outside = path.join(f.home, "outside"); await writeFile(outside, "keep"); const unsafe = path.join(f.directory, "outside-link"); await symlink(outside, unsafe);
    await expect(removeBotDeletionFile(target, signal())).rejects.toThrow(/symbolic/);
    expect(reserved()).toBe(1024); expect(await readFile(privateImage, "utf8")).toBe("native resume pin");
    await rm(unsafe); await removeBotDeletionFile(target, signal());
    expect(reserved()).toBeNull(); await expect(lstat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(outside, "utf8")).toBe("keep");
  });

});
