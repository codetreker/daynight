import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CliContext } from "../../../src/cli/context.js";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import { controllerExecutionDirectory, writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import type { SessionSnapshot } from "../../../src/session/protocol.js";
const proof = vi.hoisted(() => ({ capture: vi.fn(), stopped: vi.fn() }));
vi.mock("../../../src/commands/controller/process-proof.js", () => ({ captureProcessProof: proof.capture, confirmControllerProcessesStopped: proof.stopped }));
import { acquireResume } from "../../../src/commands/controller/resume.js";
type Mutable<T> = { -readonly [P in keyof T]: T[P] extends object ? Mutable<T[P]> : T[P] };
const roots: string[] = [];
const identity = { pid: 789, parentPid: 1, processGroupId: 789, startedAt: "original", commandHash: "a".repeat(64) };
const config = { serverUrl: "https://daynight.example", serverToken: "secret" };
beforeEach(() => { vi.clearAllMocks(); proof.capture.mockResolvedValue(identity); proof.stopped.mockResolvedValue(true); });
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
async function fixture() {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/resume-tests"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); roots.push(home);
  const cwd = path.join(home, "project"), nativeHome = path.join(home, "native"); await mkdir(cwd); await mkdir(nativeHome);
  const output: string[] = [], context: CliContext = { version: "test", packageDirectory: "/package", homeDirectory: () => home, workingDirectory: () => cwd, stdout: text => output.push(text), stderr: text => output.push(text), stdoutBytes: async () => {} };
  const executionId = randomUUID(), ownerUserId = randomUUID(), nativeSessionId = randomUUID();
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId, controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", testExecutionId: executionId, ownerUserId, initialInput: "none", serverOrigin: config.serverUrl, provider: "codex", cwd, nativeHome, configuration: { agent: "codex", agentControlMode: "web", model: "original-model", args: [], recoveryLimit: 0 }, initialOperationId: randomUUID(), initialPrompt: "", resumeNativeSessionId: null, credentialFile: path.join(home, "credential.json"), ipcEndpoint: path.join(home, "local.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  async function save(target: ControllerLaunchTicket, nativeId = nativeSessionId, stopped = true) {
    await writeLaunchTicket(home, target); const directory = controllerExecutionDirectory(home, target.executionId); await mkdir(directory, { recursive: true });
    const journal = openControllerLifecycleStore(path.join(directory, "journal.sqlite"), target);
    journal.patchSnapshot({ nativeSessionId: nativeId, lifecycle: stopped ? "stopped" : "ready", nativeStopped: stopped, stoppedAt: stopped ? new Date().toISOString() : null, controllerProcess: identity }); journal.close();
  }
  await save(ticket);
  const session: Mutable<SessionSnapshot> = { protocol: "daynight.session.v1", schemaVersion: 1, projectionVersion: 1, sessionId: ticket.sessionId, testExecutionId: executionId, executionGeneration: "1", connectionEpoch: "1", identity: { ownerUserId, controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId, agentControlMode: "web", provider: "codex", nativeSessionId }, sessionRevision: "1", historyEpoch: randomUUID(), lastEventSeq: "0", lastTimelineSeq: "0", initialInputState: "not_required", synchronized: false, lifecycle: "archived", connectionState: "disconnected", activity: "stopped", currentTurnId: null, capabilities: { send: false, steer: false, cancel: false, respond: false }, operations: { canSend: false, canCancel: false, canRespond: false } };
  const fetch = vi.fn(async (url: string) => url.endsWith("/me") ? Response.json({ id: ownerUserId }) : Response.json({ session })); vi.stubGlobal("fetch", fetch);
  return { home, cwd, nativeHome, context, output, ticket, nativeSessionId, session, fetch, save };
}
test("resume binds the original stopped native identity and holds an exclusive lease until release", async () => {
  const f = await fixture(), input = { provider: "codex" as const, sessionId: f.ticket.sessionId };
  const lease = await acquireResume(input, f.context, config);
  expect(lease.nativeSessionId).toBe(f.nativeSessionId); expect(lease.ticket.nativeHome).toBe(f.nativeHome); expect(proof.stopped).toHaveBeenCalledWith(identity, []);
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
test("resume refuses origin changes, foreign cwd, unknown IDs and live original descendants", async () => {
  const f = await fixture(), input = { provider: "codex" as const, sessionId: f.ticket.sessionId };
  await expect(acquireResume(input, f.context, { ...config, serverUrl: "https://other.example" })).rejects.toThrow();
  await expect(acquireResume(input, { ...f.context, workingDirectory: () => f.home }, config)).rejects.toThrow();
  await expect(acquireResume({ ...input, sessionId: f.nativeSessionId }, f.context, config)).rejects.toThrow();
  proof.stopped.mockResolvedValue(false); await expect(acquireResume(input, f.context, config)).rejects.toThrow(/stopp|running/i);
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
test("stop evidence is rechecked under the lease and a failed prelaunch check leaves no held lease", async () => {
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
