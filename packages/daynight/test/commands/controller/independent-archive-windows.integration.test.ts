import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { CliContext } from "../../../src/cli/context.js";
import type { ControllerJobLease } from "../../../src/commands/controller/windows-job.js";
import { controllerExecutionDirectory, writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { openControllerLifecycleStore, recordStoppedControllerGeneration } from "../../../src/commands/controller/lifecycle-store.js";
import { retryIndependentArchive } from "../../../src/commands/controller/independent-archive.js";

const f = vi.hoisted(() => ({ confirm: vi.fn(), upload: vi.fn() }));
vi.mock("../../../src/config/server.js", async original => ({ ...await original<typeof import("../../../src/config/server.js")>(), loadServerConfiguration: async () => ({ serverUrl: "https://daynight.example", serverToken: "secret" }) }));
vi.mock("../../../src/commands/controller/process-proof.js", () => ({ confirmControllerProcessesStopped: f.confirm }));
vi.mock("../../../src/commands/controller/archive-upload.js", () => ({ uploadStoppedControllerArchive: f.upload }));
const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const withWindowsPlatform = async (action: () => Promise<void>): Promise<void> => {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value: "win32" });
  try { await action(); } finally { Object.defineProperty(process, "platform", original); }
};

async function fixture() {
  f.confirm.mockReset().mockResolvedValue(true); f.upload.mockReset().mockResolvedValue({ state: "ready" });
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/archive-retry-windows"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); roots.push(home);
  const executionId = randomUUID(), sessionId = randomUUID(), output: string[] = [];
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId, controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId, executionGeneration: "1", testExecutionId: executionId, ownerUserId: randomUUID(), initialInput: "none", serverOrigin: "https://daynight.example", provider: "codex", cwd: home, nativeHome: home, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 0 }, initialOperationId: randomUUID(), initialPrompt: "", resumeNativeSessionId: null, credentialFile: path.join(home, "credential"), ipcEndpoint: path.join(home, "local.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  await writeLaunchTicket(home, ticket); const directory = controllerExecutionDirectory(home, executionId); await mkdir(directory, { recursive: true });
  const journal = path.join(directory, "journal.sqlite"), store = openControllerLifecycleStore(journal, ticket);
  store.patchSnapshot({ controllerProcess: { pid: 987, parentPid: 1, processGroupId: null, startedAt: "original", commandHash: "a".repeat(64), jobObjectName: `Local\\Daynight-${ticket.launchId}` } }); store.close();
  await recordStoppedControllerGeneration(journal, ticket, { stateDirectory: path.join(home, ".daynight"), jobLease: {} as ControllerJobLease }); f.confirm.mockClear();
  const session = { protocol: "daynight.session.v1", schemaVersion: 1, projectionVersion: 1, sessionId, testExecutionId: executionId, executionGeneration: "1", connectionEpoch: "1", identity: { ownerUserId: ticket.ownerUserId, controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId, agentControlMode: "web", provider: "codex", nativeSessionId: null }, sessionRevision: "1", historyEpoch: randomUUID(), lastEventSeq: "0", lastTimelineSeq: "0", initialInputState: "not_required", synchronized: false, lifecycle: "archived", connectionState: "disconnected", activity: "stopped", currentTurnId: null, capabilities: { send: false, steer: false, cancel: false, respond: false }, operations: { canSend: false, canCancel: false, canRespond: false } };
  const fetch = vi.fn(async (url: string) => url.endsWith("/stop") ? Response.json({ session }) : Response.json({ archive: { state: "pending" } })); vi.stubGlobal("fetch", fetch);
  const context: CliContext = { version: "test", packageDirectory: home, homeDirectory: () => home, workingDirectory: () => home, stdout: text => output.push(text), stderr: text => output.push(text), stdoutBytes: async () => {} };
  return { ticket, journal, context, fetch, output };
}

test("Windows archive retry uses the committed proof without reopening a Job", async () => {
  await withWindowsPlatform(async () => {
    const v = await fixture();
    await retryIndependentArchive({ provider: "codex", sessionId: v.ticket.sessionId }, v.context);
    expect(f.confirm).not.toHaveBeenCalled(); expect(f.upload).toHaveBeenCalledOnce();
    expect(v.fetch.mock.calls.map(([url]) => url.split("/").at(-1))).toEqual(["archive", "stop"]);
    expect(v.output.join("")).toContain("Test Session history archived");
  });
});

test.each(["missing", "conflict"] as const)("Windows archive retry rejects %s committed proof before server writes", async kind => {
  await withWindowsPlatform(async () => {
    const v = await fixture(), db = new Database(v.journal);
    try { const row = db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string }; const value = JSON.parse(row.snapshot); if (kind === "missing") delete value.windowsJobStopProof; else value.activity = "working"; db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify(value)); }
    finally { db.close(); }
    await expect(retryIndependentArchive({ provider: "codex", sessionId: v.ticket.sessionId }, v.context)).rejects.toThrow(/proof/);
    expect(f.confirm).not.toHaveBeenCalled(); expect(f.upload).not.toHaveBeenCalled(); expect(v.fetch).not.toHaveBeenCalled();
  });
});

test.skipIf(process.platform === "win32")("Windows archive retry rejects a symlink journal", async () => {
  await withWindowsPlatform(async () => {
    const v = await fixture(); await rename(v.journal, `${v.journal}.original`); await symlink(`${v.journal}.original`, v.journal);
    await expect(retryIndependentArchive({ provider: "codex", sessionId: v.ticket.sessionId }, v.context)).rejects.toThrow(/private regular file/);
    expect(v.fetch).not.toHaveBeenCalled(); expect(f.upload).not.toHaveBeenCalled();
  });
});
