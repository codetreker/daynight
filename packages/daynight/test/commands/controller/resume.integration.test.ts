import { currentSqliteVersion } from "../../../src/platform/sqlite-format.js";
import { controllerJournalFormat } from "../../../src/commands/controller/journal-format.js";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CliContext } from "../../../src/cli/context.js";
import { openControllerLifecycleStore, recordStoppedControllerGeneration } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerJobLease } from "../../../src/commands/controller/windows-job.js";
import { controllerExecutionDirectory, writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import type { SessionSnapshot } from "../../../src/session/protocol.js";
const journalVersion = currentSqliteVersion(controllerJournalFormat);
const proof = vi.hoisted(() => ({ capture: vi.fn(), stopped: vi.fn() }));
vi.mock("../../../src/commands/controller/process-proof.js", () => ({ captureProcessProof: proof.capture, confirmControllerProcessesStopped: proof.stopped }));
import { acquireResume } from "../../../src/commands/controller/resume.js";
type Mutable<T> = { -readonly [P in keyof T]: T[P] extends object ? Mutable<T[P]> : T[P] };
const roots: string[] = [];
const identity = { pid: 789, parentPid: 1, processGroupId: 789, startedAt: "original", commandHash: "a".repeat(64) };
const config = { serverUrl: "https://daynight.example", serverToken: "secret" };
beforeEach(() => { vi.clearAllMocks(); proof.capture.mockResolvedValue(identity); proof.stopped.mockResolvedValue(true); });
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
async function fixture(serverOrigin = config.serverUrl) {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/resume-tests"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); roots.push(home);
  const cwd = path.join(home, "project"), nativeHome = path.join(home, "native"); await mkdir(cwd); await mkdir(nativeHome);
  const output: string[] = [], context: CliContext = { version: "test", packageDirectory: "/package", homeDirectory: () => home, workingDirectory: () => cwd, stdout: text => output.push(text), stderr: text => output.push(text), stdoutBytes: async () => {} };
  const executionId = randomUUID(), ownerUserId = randomUUID(), nativeSessionId = randomUUID();
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId, controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", testExecutionId: executionId, ownerUserId, initialInput: "none", serverOrigin, provider: "codex", cwd, nativeHome, configuration: { agent: "codex", agentControlMode: "web", model: "original-model", args: [], recoveryLimit: 0 }, initialOperationId: randomUUID(), initialPrompt: "", resumeNativeSessionId: null, credentialFile: path.join(home, "credential.json"), ipcEndpoint: path.join(home, "local.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  async function save(target: ControllerLaunchTicket, nativeId = nativeSessionId, stopped = true) {
    await writeLaunchTicket(home, target); const directory = controllerExecutionDirectory(home, target.executionId); await mkdir(directory, { recursive: true });
    const journal = openControllerLifecycleStore(path.join(directory, "journal.sqlite"), target);
    journal.patchSnapshot({ nativeSessionId: nativeId, lifecycle: stopped ? "stopped" : "ready", nativeStopped: stopped, stoppedAt: stopped ? new Date().toISOString() : null, controllerProcess: process.platform === "win32" ? { ...identity, processGroupId: null, jobObjectName: `Local\\Daynight-${target.launchId}` } : identity }); journal.close();
    if (stopped && process.platform === "win32") await recordStoppedControllerGeneration(path.join(directory, "journal.sqlite"), target, undefined, {} as ControllerJobLease);
  }
  await save(ticket); proof.stopped.mockClear();
  const session: Mutable<SessionSnapshot> = { protocol: "daynight.session.v1", schemaVersion: 1, projectionVersion: 1, sessionId: ticket.sessionId, testExecutionId: executionId, executionGeneration: "1", connectionEpoch: "1", identity: { ownerUserId, controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId, agentControlMode: "web", provider: "codex", nativeSessionId }, sessionRevision: "1", historyEpoch: randomUUID(), lastEventSeq: "0", lastTimelineSeq: "0", initialInputState: "not_required", synchronized: false, lifecycle: "archived", connectionState: "disconnected", activity: "stopped", currentTurnId: null, capabilities: { send: false, steer: false, cancel: false, respond: false }, operations: { canSend: false, canCancel: false, canRespond: false } };
  const fetch = vi.fn(async (url: string) => url.endsWith("/me") ? Response.json({ id: ownerUserId }) : Response.json({ session })); vi.stubGlobal("fetch", fetch);
  return { home, cwd, nativeHome, context, output, ticket, nativeSessionId, session, fetch, save };
}

const withWindowsPlatform = async (action: () => Promise<void>): Promise<void> => {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value: "win32" });
  try { await action(); } finally { Object.defineProperty(process, "platform", original); }
};

test("Windows resume reuses a committed Job proof after the original lease is gone", async () => {
  await withWindowsPlatform(async () => {
    const f = await fixture();
    const lease = await acquireResume({ provider: "codex", sessionId: f.ticket.sessionId }, f.context, config);
    expect(lease.nativeSessionId).toBe(f.nativeSessionId); expect(proof.stopped).not.toHaveBeenCalled();
    await lease.release();
  });
});

test.each(["missing", "snapshot conflict", "ticket conflict"] as const)("Windows resume rejects %s stop proof", async kind => {
  await withWindowsPlatform(async () => {
    const f = await fixture(), file = path.join(controllerExecutionDirectory(f.home, f.ticket.executionId), "journal.sqlite"), db = new Database(file);
    try {
      const row = db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string };
      const value = JSON.parse(row.snapshot);
      if (kind === "missing") delete value.windowsJobStopProof;
      if (kind === "snapshot conflict") value.activity = "working";
      if (kind === "ticket conflict") value.windowsJobStopProof.ticketHash = "b".repeat(64);
      db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify(value));
    } finally { db.close(); }
    await expect(acquireResume({ provider: "codex", sessionId: f.ticket.sessionId }, f.context, config)).rejects.toThrow(/proof/);
    expect(f.fetch).not.toHaveBeenCalled(); expect(proof.capture).not.toHaveBeenCalled(); expect(proof.stopped).not.toHaveBeenCalled();
  });
});

test("Windows resume rechecks the persisted proof while holding the native lease", async () => {
  await withWindowsPlatform(async () => {
    const f = await fixture(), file = path.join(controllerExecutionDirectory(f.home, f.ticket.executionId), "journal.sqlite");
    f.fetch.mockImplementation(async url => {
      if (url.endsWith("/me")) {
        const db = new Database(file); try { const row = db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string }; const value = JSON.parse(row.snapshot); value.activity = "working"; db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify(value)); } finally { db.close(); }
        return Response.json({ id: f.ticket.ownerUserId });
      }
      return Response.json({ session: f.session });
    });
    await expect(acquireResume({ provider: "codex", sessionId: f.ticket.sessionId }, f.context, config)).rejects.toThrow(/proof/);
    const db = new Database(path.join(f.home, ".daynight", "controller", "native-resume-leases.sqlite"));
    try { expect(db.prepare("SELECT count(*) AS total FROM leases").get()).toEqual({ total: 0 }); } finally { db.close(); }
    expect(proof.stopped).not.toHaveBeenCalled();
  });
});

test.skipIf(process.platform !== "win32")("Windows restart reuses the persisted proof for resume and archive, and rejects a missing proof", async () => {
  let owner = "", session: unknown, writes = 0;
  const status = { state: "ready", sha256: "a".repeat(64), byteLength: "1", errorCode: null, schemaVersion: 3, completeness: "complete" };
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json"); request.resume();
    if (request.url === "/api/v1/me") response.end(JSON.stringify({ id: owner }));
    else if (request.method === "GET" && request.url?.endsWith("/archive")) response.end(JSON.stringify({ archive: status }));
    else if (request.method === "GET" && request.url?.includes("/test-sessions/")) response.end(JSON.stringify({ session }));
    else if (request.method === "POST" && request.url?.endsWith("/stop")) { writes++; response.end(JSON.stringify({ session })); }
    else if (request.method === "POST" && request.url?.endsWith("/archive")) { writes++; response.end(JSON.stringify({ archive: status })); }
    else { response.writeHead(404); response.end("{}"); }
  });
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("Fixture server address is unavailable.");
    const serverOrigin = `http://127.0.0.1:${address.port}`, v = await fixture(serverOrigin); owner = v.ticket.ownerUserId; session = v.session;
    const state = path.join(v.home, ".daynight"), journal = path.join(controllerExecutionDirectory(v.home, v.ticket.executionId), "journal.sqlite");
    await writeFile(path.join(state, "config.yml"), `serverUrl: ${serverOrigin}\nserverToken: secret\n`);
    await writeFile(`${journal}.archive-receipt-1.json`, JSON.stringify(status));
    const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, "../../../dist/commands/controller/resume.js")).href;
    const source = `const { acquireResume } = await import(${JSON.stringify(moduleUrl)}); const context = { version: 'test', packageDirectory: '', homeDirectory: () => ${JSON.stringify(v.home)}, workingDirectory: () => ${JSON.stringify(v.cwd)}, stdout: () => {}, stderr: () => {}, stdoutBytes: async () => {} }; const lease = await acquireResume({ provider: 'codex', sessionId: ${JSON.stringify(v.ticket.sessionId)} }, context, { serverUrl: ${JSON.stringify(serverOrigin)}, serverToken: 'secret' }); await lease.release(); console.log('resume-proof-accepted');`;
    const run = promisify(execFile), env = { ...process.env, HOME: v.home, USERPROFILE: v.home, DN_CONFIG_DIR: state };
    const resume = () => run(process.execPath, ["--input-type=module", "-e", source], { cwd: v.cwd, env, timeout: 30_000 });
    const archive = () => run(process.execPath, [path.resolve(import.meta.dirname, "../../../dist/main.js"), "controller", "codex", "archive", v.ticket.sessionId], { cwd: v.cwd, env, timeout: 30_000 });
    expect((await resume()).stdout).toContain("resume-proof-accepted");
    expect((await archive()).stdout).toContain("Test Session history archived"); expect(writes).toBe(2);
    const db = new Database(journal); try { const row = db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string }; const value = JSON.parse(row.snapshot); delete value.windowsJobStopProof; db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify(value)); } finally { db.close(); }
    await expect(resume()).rejects.toThrow(/proof/i); await expect(archive()).rejects.toThrow(/proof/i); expect(writes).toBe(2);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 90_000);
test("resume binds the original stopped native identity and holds an exclusive lease until release", async () => {
  const f = await fixture(), input = { provider: "codex" as const, sessionId: f.ticket.sessionId };
  const lease = await acquireResume(input, f.context, config);
  expect(lease.nativeSessionId).toBe(f.nativeSessionId); expect(lease.ticket.nativeHome).toBe(f.nativeHome);
  if (process.platform === "win32") expect(proof.stopped).not.toHaveBeenCalled(); else expect(proof.stopped).toHaveBeenCalledWith(identity, []);
  await expect(acquireResume(input, f.context, config)).rejects.toThrow(/lease|already/i);
  await lease.release(); await lease.release(); const next = await acquireResume(input, f.context, config); await next.release();
});
test("simultaneous resume invocations cannot both acquire the same native writer", async () => {
  const f = await fixture(); const outcomes = await Promise.allSettled([1, 2].map(() => acquireResume({ provider: "codex", sessionId: f.ticket.sessionId }, f.context, config)));
  expect(outcomes.filter(v => v.status === "fulfilled")).toHaveLength(1);
  for (const result of outcomes) if (result.status === "fulfilled") await result.value.release();
});
test("noninteractive resume lists local candidates without choosing or acquiring a lease", async () => {
  const f = await fixture(); await expect(acquireResume({ provider: "codex" }, f.context, config)).rejects.toThrow(/session.*ID|session-id/i);
  expect(f.output.join("")).toContain(f.ticket.sessionId); expect(proof.capture).not.toHaveBeenCalled();
});
test("cancelling the interactive selection changes no local files", async () => {
  const f = await fixture(), directory = path.join(f.home, ".daynight", "controller"), before = await readdir(directory);
  f.context.prompt = { isInteractive: true, ask: vi.fn(), selectMany: vi.fn(), select: vi.fn(async () => { throw new Error("Selection cancelled"); }), close: vi.fn() };
  await expect(acquireResume({ provider: "codex" }, f.context, config)).rejects.toThrow("Selection cancelled");
  expect(await readdir(directory)).toEqual(before); expect(proof.capture).not.toHaveBeenCalled();
});
test.each(["owner", "native", "provider", "execution", "lifecycle", "principal"])("resume refuses mismatched server %s evidence", async mismatch => {
  const f = await fixture();
  if (mismatch === "owner") f.session.identity = { ...f.session.identity, ownerUserId: randomUUID() } as typeof f.session.identity;
  if (mismatch === "native") f.session.identity.nativeSessionId = randomUUID();
  if (mismatch === "provider") f.session.identity.provider = "claude";
  if (mismatch === "execution") f.session.testExecutionId = randomUUID();
  if (mismatch === "lifecycle") f.session.lifecycle = "active";
  if (mismatch === "principal") f.fetch.mockImplementation(async url => url.endsWith("/me") ? Response.json({ id: randomUUID() }) : Response.json({ session: f.session }));
  await expect(acquireResume({ provider: "codex", sessionId: f.ticket.sessionId }, f.context, config)).rejects.toThrow(); expect(proof.capture).not.toHaveBeenCalled();
});
test("resume refuses origin changes, foreign cwd and unknown IDs", async () => {
  const f = await fixture(), input = { provider: "codex" as const, sessionId: f.ticket.sessionId };
  await expect(acquireResume(input, f.context, { ...config, serverUrl: "https://other.example" })).rejects.toThrow();
  await expect(acquireResume(input, { ...f.context, workingDirectory: () => f.home }, config)).rejects.toThrow();
  await expect(acquireResume({ ...input, sessionId: f.nativeSessionId }, f.context, config)).rejects.toThrow();
});
test.skipIf(process.platform === "win32")("resume refuses live original descendants", async () => {
  const f = await fixture(); proof.stopped.mockResolvedValue(false);
  await expect(acquireResume({ provider: "codex", sessionId: f.ticket.sessionId }, f.context, config)).rejects.toThrow(/stopp|running/i);
});
test("a different active execution for the same native identity blocks resume and releases only the unexposed lease", async () => {
  const f = await fixture(), executionId = randomUUID();
  const other = { ...f.ticket, launchId: randomUUID(), executionId, testExecutionId: executionId, sessionId: randomUUID(), controllerInstanceId: randomUUID() };
  await f.save(other, f.nativeSessionId, false);
  await expect(acquireResume({ provider: "codex", sessionId: f.ticket.sessionId }, f.context, config)).rejects.toThrow(/native|execution|stopp/i);

});
test("native home aliases cannot bypass the writer lease", async () => {
  const f = await fixture(), first = await acquireResume({ provider: "codex", sessionId: f.ticket.sessionId }, f.context, config);
  const alias = path.join(f.home, "native-alias"); await symlink(f.nativeHome, alias, "dir");
  const executionId = randomUUID(), other = { ...f.ticket, nativeHome: alias, executionId, testExecutionId: executionId, launchId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID() };
  await f.save(other); f.fetch.mockImplementation(async url => url.endsWith("/me") ? Response.json({ id: f.ticket.ownerUserId }) : Response.json({ session: { ...f.session, sessionId: other.sessionId, testExecutionId: executionId, identity: { ...f.session.identity, controllerInstanceId: other.controllerInstanceId } } }));
  await expect(acquireResume({ provider: "codex", sessionId: other.sessionId }, f.context, config)).rejects.toThrow(/lease|already/i); await first.release();
});


test("a retained lease cannot be stolen merely because its recorded launcher no longer exists", async () => {
  const f = await fixture(), input = { provider: "codex" as const, sessionId: f.ticket.sessionId };
  const lease = await acquireResume(input, f.context, config);
  const db = new Database(path.join(f.home, ".daynight", "controller", "native-resume-leases.sqlite"));
  db.prepare("UPDATE leases SET launcher_proof=?,created_at=?").run(JSON.stringify({ ...identity, pid: 2_000_000_000 }), "2000-01-01T00:00:00.000Z"); db.close();
  await expect(acquireResume(input, f.context, config)).rejects.toThrow(/lease/); await lease.release();
});
test.skipIf(process.platform === "win32")("stop evidence is rechecked under the lease and a failed prelaunch check leaves no held lease", async () => {
  const f = await fixture(), input = { provider: "codex" as const, sessionId: f.ticket.sessionId };
  proof.stopped.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(acquireResume(input, f.context, config)).rejects.toThrow(/running/);
  proof.stopped.mockResolvedValue(true); const lease = await acquireResume(input, f.context, config); await lease.release();
});
test("a symlink journal is refused before it can authorize a native writer", async () => {
  const f = await fixture(), journal = path.join(controllerExecutionDirectory(f.home, f.ticket.executionId), "journal.sqlite");
  const { rename } = await import("node:fs/promises"); await rename(journal, journal + ".original"); await symlink(journal + ".original", journal);
  await expect(acquireResume({ provider: "codex", sessionId: f.ticket.sessionId }, f.context, config)).rejects.toThrow(/private regular file/);
  expect(proof.capture).not.toHaveBeenCalled();
});


test("resume reads only the selected state root and puts its lease there", async () => {
  const f = await fixture(), root = path.join(f.home, "dev-state");
  vi.stubEnv("DN_CONFIG_DIR", root);
  const input = { provider: "codex" as const, sessionId: f.ticket.sessionId };
  await expect(acquireResume(input, f.context, config)).rejects.toThrow(/No stopped local/);
  await f.save(f.ticket);
  const lease = await acquireResume(input, f.context, config);
  expect(await readdir(path.join(root, "controller"))).toContain("native-resume-leases.sqlite");
  expect(await readdir(path.join(f.home, ".daynight", "controller"))).not.toContain("native-resume-leases.sqlite");
  await lease.release();
});

test.each([false, true])("unversioned native leases reset only when no retained ownership exists (%s)", async retained => {
  const f = await fixture(), file = path.join(f.home, ".daynight", "controller", "native-resume-leases.sqlite");
  const db = new Database(file); db.exec("CREATE TABLE IF NOT EXISTS leases (native_key TEXT PRIMARY KEY, nonce TEXT NOT NULL, source_session_id TEXT NOT NULL, launcher_proof TEXT NOT NULL, created_at TEXT NOT NULL)");
  if (retained) db.prepare("INSERT INTO leases VALUES(?,?,?,?,?)").run("retained", "original-nonce", f.ticket.sessionId, JSON.stringify(identity), "2000-01-01T00:00:00.000Z");
  db.close(); await chmod(file, 0o600);
  if (retained) {
    await expect(acquireResume({ provider: "codex", sessionId: f.ticket.sessionId }, f.context, config)).rejects.toThrow("upgrade-blocked");
    const check = new Database(file); try { expect(check.pragma("user_version", { simple: true })).toBe(0); expect(check.prepare("SELECT nonce FROM leases").all()).toEqual([{ nonce: "original-nonce" }]); } finally { check.close(); }
  } else {
    const lease = await acquireResume({ provider: "codex", sessionId: f.ticket.sessionId }, f.context, config);
    const check = new Database(file); try { expect(check.pragma("user_version", { simple: true })).toBe(1); expect(check.prepare("SELECT count(*) AS total FROM leases").get()).toEqual({ total: 1 }); } finally { check.close(); }
    await lease.release();
  }
});

test.each(["missing", "empty", "retained"] as const)("resume resets unknown unversioned leases only without retained rows (%s)", async kind => {
  const f = await fixture(), file = path.join(f.home, ".daynight", "controller", "native-resume-leases.sqlite");
  const db = new Database(file);
  db.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('original')");
  if (kind !== "missing") db.exec("CREATE TABLE leases(unrecognized_owner TEXT)");
  if (kind === "retained") db.exec("INSERT INTO leases VALUES ('retained without a known ownership schema')");
  db.close(); await chmod(file, 0o600);
  if (kind === "retained") {
    await expect(acquireResume({ provider: "codex", sessionId: f.ticket.sessionId }, f.context, config)).rejects.toThrow("upgrade-blocked");
    const check = new Database(file);
    try {
      expect(check.pragma("user_version", { simple: true })).toBe(0);
      expect(check.prepare("SELECT * FROM leases").all()).toEqual([{ unrecognized_owner: "retained without a known ownership schema" }]);
      expect(check.prepare("SELECT value FROM sentinel").get()).toEqual({ value: "original" });
    } finally { check.close(); }
  } else {
    const lease = await acquireResume({ provider: "codex", sessionId: f.ticket.sessionId }, f.context, config);
    const check = new Database(file);
    try {
      expect(check.pragma("user_version", { simple: true })).toBe(1);
      expect(check.prepare("SELECT name FROM sqlite_schema WHERE name='sentinel'").get()).toBeUndefined();
      expect(check.prepare("SELECT source_session_id FROM leases").all()).toEqual([{ source_session_id: f.ticket.sessionId }]);
    } finally { check.close(); await lease.release(); }
  }
});

test.each(["table", "view"] as const)("case-insensitive %s lease evidence blocks unversioned reset", async kind => {
  const f = await fixture(), file = path.join(f.home, ".daynight", "controller", "native-resume-leases.sqlite");
  const db = new Database(file);
  db.exec(kind === "table" ? "CREATE TABLE LeAsEs(sentinel TEXT); INSERT INTO LeAsEs VALUES ('preserved')" : "CREATE TABLE lease_evidence(sentinel TEXT); INSERT INTO lease_evidence VALUES ('preserved'); CREATE VIEW LeAsEs AS SELECT * FROM lease_evidence");
  db.close(); await chmod(file, 0o600);
  await expect(acquireResume({ provider: "codex", sessionId: f.ticket.sessionId }, f.context, config)).rejects.toThrow("upgrade-blocked");
  const check = new Database(file);
  try { expect(check.pragma("user_version", { simple: true })).toBe(0); expect(check.prepare("SELECT sentinel FROM leases").get()).toEqual({ sentinel: "preserved" }); }
  finally { check.close(); }
});

test.each([1, 2])("resume refuses unknown nonzero native lease version %s and preserves its data", async version => {
  const f = await fixture(), file = path.join(f.home, ".daynight", "controller", "native-resume-leases.sqlite");
  const db = new Database(file); db.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('preserved')"); db.pragma(`user_version=${version}`); db.close(); await chmod(file, 0o600);
  await expect(acquireResume({ provider: "codex", sessionId: f.ticket.sessionId }, f.context, config)).rejects.toThrow(version === 2 ? "unsupported-version" : "invalid-format");
  const check = new Database(file);
  try { expect(check.pragma("user_version", { simple: true })).toBe(version); expect(check.prepare("SELECT value FROM sentinel").get()).toEqual({ value: "preserved" }); }
  finally { check.close(); }
});

test("lease release preserves its row when another actor changes the format", async () => {
  const f = await fixture(), lease = await acquireResume({ provider: "codex", sessionId: f.ticket.sessionId }, f.context, config);
  const file = path.join(f.home, ".daynight", "controller", "native-resume-leases.sqlite"), db = new Database(file); db.pragma("user_version=2"); db.close();
  await expect(lease.release()).rejects.toThrow("unsupported-version");
  const check = new Database(file); try { expect(check.prepare("SELECT count(*) AS total FROM leases").get()).toEqual({ total: 1 }); } finally { check.close(); }
});

test("journal format failure aborts resume inventory rather than hiding a candidate", async () => {
  const f = await fixture(), file = path.join(controllerExecutionDirectory(f.home, f.ticket.executionId), "journal.sqlite"), db = new Database(file); db.pragma(`user_version=${journalVersion + 1}`); db.close();
  await expect(acquireResume({ provider: "codex", sessionId: f.ticket.sessionId }, f.context, config)).rejects.toThrow("unsupported-version");
  expect(f.fetch).not.toHaveBeenCalled(); expect(proof.capture).not.toHaveBeenCalled();
});

test("a committed lease release reports close failure and can close again without repeating DELETE", async () => {
  const f = await fixture(), lease = await acquireResume({ provider: "codex", sessionId: f.ticket.sessionId }, f.context, config);
  const file = path.join(f.home, ".daynight", "controller", "native-resume-leases.sqlite"), originalClose = Database.prototype.close;
  let fail = true;
  const closing = vi.spyOn(Database.prototype, "close").mockImplementation(function (this: Database.Database) {
    if (this.name === file && fail) { fail = false; throw new Error("Injected close failure"); }
    return originalClose.call(this);
  });
  try {
    const error = await lease.release().catch(error => error);
    expect(error).toMatchObject({ kind: "cleanup-failed", outcome: "committed" });
    const check = new Database(file); try { expect(check.prepare("SELECT count(*) AS total FROM leases").get()).toEqual({ total: 0 }); } finally { check.close(); }
    await lease.release();
  } finally { closing.mockRestore(); }
});

const failLeaseCompletionReport = (failure: Error, beforeFailure?: () => void) => vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
  const line = String(chunk);
  if (line.includes('"kind":"sqlite-migration-completed"') && line.includes('"database":"native-resume-leases"')) {
    beforeFailure?.();
    throw failure;
  }
  return true;
});

test("a committed acquisition reporting failure reconciles its unreturned lease and preserves the report error", async () => {
  const f = await fixture(), input = { provider: "codex" as const, sessionId: f.ticket.sessionId };
  const file = path.join(f.home, ".daynight", "controller", "native-resume-leases.sqlite"), reportingFailure = new Error("Completion reporter failed");
  const reporting = failLeaseCompletionReport(reportingFailure);
  try {
    const error = await acquireResume(input, f.context, config).catch(error => error);
    expect(error).toMatchObject({ kind: "cleanup-failed", outcome: "committed", connectionClosed: true, cause: reportingFailure });
    const check = new Database(file);
    try { expect(check.pragma("user_version", { simple: true })).toBe(1); expect(check.prepare("SELECT count(*) AS total FROM leases").get()).toEqual({ total: 0 }); }
    finally { check.close(); }
  } finally { reporting.mockRestore(); }
  const next = await acquireResume(input, f.context, config);
  expect(next.nativeSessionId).toBe(f.nativeSessionId); await next.release();
});

test("unreturned-lease reconciliation never removes a replacement nonce", async () => {
  const f = await fixture(), file = path.join(f.home, ".daynight", "controller", "native-resume-leases.sqlite"), reportingFailure = new Error("Completion reporter failed"), replacementNonce = randomUUID();
  const reporting = failLeaseCompletionReport(reportingFailure, () => {
    const changed = new Database(file);
    try { changed.prepare("UPDATE leases SET nonce=?").run(replacementNonce); } finally { changed.close(); }
  });
  try {
    const error = await acquireResume({ provider: "codex", sessionId: f.ticket.sessionId }, f.context, config).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors[0]).toMatchObject({ kind: "cleanup-failed", outcome: "committed", cause: reportingFailure });
    expect(error.errors[1]).toHaveProperty("message", "Native resume lease ownership changed; reconciliation is required.");
    const check = new Database(file);
    try { expect(check.prepare("SELECT nonce FROM leases").all()).toEqual([{ nonce: replacementNonce }]); } finally { check.close(); }
  } finally { reporting.mockRestore(); }
});

test("a committed acquisition with an unconfirmed connection close retains its lease", async () => {
  const f = await fixture(), file = path.join(f.home, ".daynight", "controller", "native-resume-leases.sqlite"), reportingFailure = new Error("Completion reporter failed"), closeFailure = new Error("Close acknowledgment lost"), originalClose = Database.prototype.close;
  let first = true;
  const closing = vi.spyOn(Database.prototype, "close").mockImplementation(function (this: Database.Database) {
    const result = originalClose.call(this);
    if (this.name === file && first) { first = false; throw closeFailure; }
    return result;
  });
  const reporting = failLeaseCompletionReport(reportingFailure);
  try {
    const error = await acquireResume({ provider: "codex", sessionId: f.ticket.sessionId }, f.context, config).catch(error => error);
    expect(error).toMatchObject({ kind: "cleanup-failed", outcome: "committed", connectionClosed: false });
    expect(error.cause).toBeInstanceOf(AggregateError); expect(error.cause.errors).toEqual([reportingFailure, closeFailure]);
    const check = new Database(file);
    try { expect(check.prepare("SELECT count(*) AS total FROM leases").get()).toEqual({ total: 1 }); } finally { check.close(); }
  } finally { reporting.mockRestore(); closing.mockRestore(); }
});

test("an acquisition whose commit result is unknown retains its nonce even after a confirmed close", async () => {
  const f = await fixture(), file = path.join(f.home, ".daynight", "controller", "native-resume-leases.sqlite"), commitFailure = new Error("Commit acknowledgment lost"), originalExec = Database.prototype.exec;
  let first = true, acquisition = false;
  const committing = vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql: string) {
    const target = this.name === file, loseAcknowledgment = target && sql === "COMMIT" && acquisition && first;
    const result = originalExec.call(this, sql);
    if (target && sql === "BEGIN IMMEDIATE") acquisition = true;
    if (target && (sql === "COMMIT" || sql === "ROLLBACK")) acquisition = false;
    if (loseAcknowledgment) { first = false; throw commitFailure; }
    return result;
  });
  try {
    const error = await acquireResume({ provider: "codex", sessionId: f.ticket.sessionId }, f.context, config).catch(error => error);
    expect(error).toMatchObject({ kind: "migration-failed", outcome: "unknown", connectionClosed: true, cause: commitFailure });
    const check = new Database(file);
    try { expect(check.prepare("SELECT count(*) AS total FROM leases").get()).toEqual({ total: 1 }); } finally { check.close(); }
  } finally { committing.mockRestore(); }
});
