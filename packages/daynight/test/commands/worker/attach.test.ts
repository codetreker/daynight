import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HerdrLifecycleRecord, MacProcessIdentity } from "../../../src/commands/worker/herdr/lifecycle-types.js";
import { recordedHerdrTools } from "./herdr-tool-snapshot.fixtures.js";
import { attachWorker } from "../../../src/commands/worker/attach.js";

const mocks = vi.hoisted(() => ({ connect: vi.fn(), instance: vi.fn(), spawn: vi.fn(), stat: vi.fn(), records: vi.fn(), peer: vi.fn(), observe: vi.fn(), select: vi.fn(), verifyLaunch: vi.fn(), shared: vi.fn(), inspectSharedDaemon: vi.fn() }));
vi.mock("../../../src/commands/worker/herdr/instance.js", () => ({ createHerdrInstance: mocks.instance }));
vi.mock("../../../src/commands/worker/herdr/command.js", async original => ({ ...await original<object>(), spawnHerdrProcess: mocks.spawn }));
vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>(), statSync: mocks.stat }));
vi.mock("../../../src/commands/worker/herdr/lifecycle-store.js", () => ({ readHerdrLifecycleRecords: mocks.records }));
vi.mock("../../../src/commands/worker/herdr/native-macos.js", () => ({ createMacProcessControl: () => ({ peer: mocks.peer, observe: mocks.observe }) }));
vi.mock("../../../src/platform/tool-executables.js", async original => ({ ...await original<object>(), verifyToolLaunch: mocks.verifyLaunch }));
vi.mock("../../../src/commands/worker/herdr/shared-instance-store.js", () => ({ readHerdrSharedInstance: mocks.shared }));
vi.mock("../../../src/commands/controller/process-proof.js", () => ({ inspectProcessProof: mocks.inspectSharedDaemon }));
vi.mock("@inquirer/prompts", () => ({ select: mocks.select }));
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const proof: MacProcessIdentity = { role: "daemon", pid: 123, birthToken: "birth", bootId: "boot", auditToken: [0, 0, 0, 0, 0, 123, 0, 5], ppid: 1, pgid: 123, sid: 123 };
const sharedProof = { pid: 321, parentPid: 1, processGroupId: 321, startedAt: "original-birth", commandHash: "a".repeat(64) };
const record = (suffix = "one"): HerdrLifecycleRecord => ({
  owner: { projectId: "project", taskId: `task-${suffix}`, workerId: "worker", worktreeId: "worktree", ownerUserId: "owner", serverOrigin: "https://daynight.example", provider: "codex" },
  claimId: `claim-${suffix}`, cwd: "/worktree", sessionId: `session-${suffix}`, registrationId: "registration", connectionEpoch: "1", registrationRequest: null, ledgerRequest: null, publishedLedgerHash: null, controlEpoch: "3", initialAssignment: "transport_completed", initialPrompt: "assignment", automationBlocked: true, preparation: null, segments: [], version: 3,
  runs: [{ run: { executionGeneration: "1", owner: { projectId: "project", taskId: `task-${suffix}`, workerId: "worker", worktreeId: "worktree", ownerUserId: "owner", serverOrigin: "https://daynight.example", provider: "codex" }, binding: { instanceId: suffix, sessionId: "w", workspaceId: "workspace", paneId: "1", terminalId: "terminal", nativeSessionId: "native" }, startedAt: "2026-11-04T00:00:00.000Z", stoppedAt: null, stopProof: null, segmentIds: [] }, phase: "active", nativeLaunch: "observed", launches: recordedHerdrTools(), instanceDirectory: `/worker/h/r/${suffix}`, daemon: proof, processes: [], stopOperationId: null, stopReason: null, error: null, admission: null }],
});
const durableRecords = (...records: HerdrLifecycleRecord[]): void => {
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  mocks.stat.mockReturnValue({}); mocks.records.mockReturnValue(records);
};

const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"];
const child = () => Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: vi.fn(() => true) });
let client: ReturnType<typeof child>;
const attachment = {
  executable: "herdr", arguments: ["--session", "w"],
  environment: { XDG_CONFIG_HOME: "/worker/h/c", XDG_STATE_HOME: "/worker/h/s", HERDR_CONFIG_PATH: "/worker/h/config.toml", HISTFILE: "/worker/h/shell.history" },
  unsetEnvironment: ["HERDR_SESSION", "HERDR_SOCKET_PATH", "CODEX_THREAD_ID"],
};

beforeEach(() => {
  vi.clearAllMocks(); mocks.verifyLaunch.mockResolvedValue(undefined); mocks.shared.mockReturnValue({ current: { launch: recordedHerdrTools().herdr, daemon: sharedProof, phase: "ready" }, pending: null }); mocks.inspectSharedDaemon.mockResolvedValue("running");
  mocks.stat.mockImplementation(() => { throw Object.assign(new Error("Missing journal"), { code: "ENOENT" }); }); mocks.records.mockReturnValue([]); mocks.peer.mockResolvedValue(proof); mocks.observe.mockResolvedValue("same");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  client = child();
  mocks.connect.mockResolvedValue({ reconnected: true });
  mocks.instance.mockReturnValue({ connect: mocks.connect, attachment, paths: { apiEndpoint: "/run/api.sock", clientEndpoint: "/run/client.sock" } });
  mocks.spawn.mockReturnValue(client as unknown as ChildProcess);
});
afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  if (stdinTty === undefined) Reflect.deleteProperty(process.stdin, "isTTY"); else Object.defineProperty(process.stdin, "isTTY", stdinTty);
  if (stdoutTty === undefined) Reflect.deleteProperty(process.stdout, "isTTY"); else Object.defineProperty(process.stdout, "isTTY", stdoutTty);
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
const spawned = async (): Promise<void> => { await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce()); };

describe("worker terminal attachment", () => {
  it("attaches to the recorded isolated runtime even when automatic input is blocked", async () => {
    durableRecords(record());
    const pending = attachWorker({ homeDirectory: "/worker" }); await spawned();
    expect(mocks.instance).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ isolatedRun: true, paths: expect.objectContaining({ herdrDirectory: "/worker/h/r/one", logsDirectory: path.join("/worker/h/r/one", "logs") }) }));
    expect(mocks.records).toHaveBeenCalledOnce(); expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.peer).toHaveBeenCalledWith("/run/api.sock"); expect(mocks.peer).toHaveBeenCalledWith("/run/client.sock");
    expect(mocks.observe).toHaveBeenCalledWith(proof);
    client.emit("close", 0, null); await pending;
  });

  it("spawns the original frozen client and never resolves a replacement from PATH", async () => {
    durableRecords(record());
    const pending = attachWorker({ homeDirectory: "/worker" }); await spawned();
    expect(mocks.verifyLaunch).toHaveBeenCalledWith(record().runs[0]!.launches!.herdr, expect.anything());
    expect(mocks.spawn.mock.calls[0]!.slice(0, 2)).toEqual([record().runs[0]!.launches!.herdr!.command.file, ["--session", "w", "client"]]);
    client.emit("close", 0, null); await pending;
  });

  it("keeps an unpinned original runtime without spawning a new client", async () => {
    const original = record(); delete original.runs[0]!.launches; durableRecords(original);
    await expect(attachWorker({ homeDirectory: "/worker" })).rejects.toMatchObject({ code: "legacy_tool_identity_missing" });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("retains a changed original executable without substituting a new client", async () => {
    durableRecords(record());
    const failure = Object.assign(new Error("Original client changed"), { code: "tool_identity_changed" }); mocks.verifyLaunch.mockRejectedValue(failure);
    await expect(attachWorker({ homeDirectory: "/worker" })).rejects.toBe(failure);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it.each(["stopped", "replaced"])("retains the shared runtime when its original daemon is %s", async status => {
    mocks.inspectSharedDaemon.mockResolvedValue(status);
    await expect(attachWorker({ homeDirectory: "/worker" })).rejects.toThrow(/original.*daemon/i);
    expect(mocks.inspectSharedDaemon).toHaveBeenCalledWith(sharedProof);
    expect(mocks.connect).not.toHaveBeenCalled(); expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("refuses a shared replacement after connection without spawning a client", async () => {
    mocks.inspectSharedDaemon.mockResolvedValueOnce("running").mockResolvedValue("replaced");
    await expect(attachWorker({ homeDirectory: "/worker" })).rejects.toThrow(/original.*daemon/i);
    expect(mocks.connect).toHaveBeenCalledOnce(); expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("keeps an unjournaled shared daemon without resolving a client from current targets", async () => {
    mocks.shared.mockReturnValue(null);
    await expect(attachWorker({ homeDirectory: "/worker" })).rejects.toMatchObject({ code: "legacy_tool_identity_missing" });
    expect(mocks.connect).toHaveBeenCalledOnce(); expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("reports missing tool identity for a recorded legacy shared daemon without spawning a client", async () => {
    mocks.shared.mockReturnValue({ current: { launch: null, daemon: null, phase: "ready" }, pending: null });
    await expect(attachWorker({ homeDirectory: "/worker" })).rejects.toMatchObject({ code: "legacy_tool_identity_missing" });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it.each([null, "starting", "stopping", "stopped"])("does not attach while the shared daemon state is %s", async phase => {
    mocks.shared.mockReturnValue({ current: phase === null ? null : { launch: recordedHerdrTools().herdr, daemon: sharedProof, phase }, pending: null });
    await expect(attachWorker({ homeDirectory: "/worker" })).rejects.toThrow(/original.*daemon/i);
    expect(mocks.connect).not.toHaveBeenCalled(); expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("selects among unfinished original runtimes without offering confirmed stopped runs", async () => {
    const one = record("one"), two = record("two"), stopped = record("stopped"); stopped.runs[0]!.phase = "stopped_confirmed";
    durableRecords(one, stopped, two); mocks.select.mockResolvedValue(two);
    const pending = attachWorker({ homeDirectory: "/worker" }); await spawned();
    const prompt = mocks.select.mock.calls[0]![0];
    expect(prompt.choices).toHaveLength(2); expect(prompt.choices[1]).toMatchObject({ name: expect.stringMatching(/task-two.*claim-two.*codex/), value: two });
    expect(mocks.instance.mock.calls[0]![0].paths.herdrDirectory).toBe("/worker/h/r/two");
    client.emit("close", 0, null); await pending;
  });

  it("does not fall back to an unknown shared daemon when the journal has no unfinished run", async () => {
    durableRecords();
    await expect(attachWorker({ homeDirectory: "/worker" })).rejects.toThrow(/recorded.*runtime/i);
    expect(mocks.instance).not.toHaveBeenCalled(); expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("does not treat an inaccessible journal as a legacy installation", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const failure = Object.assign(new Error("Lifecycle journal access denied"), { code: "EACCES" }); mocks.stat.mockImplementation(() => { throw failure; });
    await expect(attachWorker({ homeDirectory: "/worker" })).rejects.toBe(failure);
    expect(mocks.instance).not.toHaveBeenCalled(); expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("preserves unreadable journal failures without accessing the legacy daemon", async () => {
    durableRecords(); const failure = new Error("Unsupported lifecycle version"); mocks.records.mockImplementationOnce(() => { throw failure; });
    await expect(attachWorker({ homeDirectory: "/worker" })).rejects.toBe(failure);
    expect(mocks.instance).not.toHaveBeenCalled(); expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it.each(["api", "client"])("refuses a replaced %s endpoint before connecting the interactive client", async endpoint => {
    durableRecords(record());
    mocks.peer.mockImplementation(async (name: string) => name.includes(endpoint) ? { ...proof, birthToken: "replacement" } : proof);
    await expect(attachWorker({ homeDirectory: "/worker" })).rejects.toThrow(/original.*daemon/i);
    expect(mocks.connect).not.toHaveBeenCalled(); expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("rejects an original daemon whose native identity can no longer be proved", async () => {
    durableRecords(record()); mocks.observe.mockResolvedValue("unknown");
    await expect(attachWorker({ homeDirectory: "/worker" })).rejects.toThrow(/original.*daemon/i);
    expect(mocks.connect).not.toHaveBeenCalled(); expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("connects to the existing private session with inherited terminal IO and cleaned routing identities", async () => {
    vi.stubEnv("HERDR_SESSION", "human"); vi.stubEnv("HERDR_SOCKET_PATH", "/human.sock"); vi.stubEnv("CODEX_THREAD_ID", "parent"); vi.stubEnv("CODEX_HOME", "/native-home");
    const pending = attachWorker({ homeDirectory: "/worker" });
    await spawned();
    expect(mocks.connect).toHaveBeenCalledOnce();
    const [executable, args, options] = mocks.spawn.mock.calls[0]!;
    expect(executable).toBe(record().runs[0]!.launches!.herdr!.command.file); expect(args).toEqual(["--session", "w", "client"]);
    expect(options).toMatchObject({ stdio: "inherit", detached: false, windowsHide: false, env: { ...attachment.environment, CODEX_HOME: "/native-home" } });
    for (const key of attachment.unsetEnvironment) expect(options.env).not.toHaveProperty(key);
    expect(process.env.HERDR_SESSION).toBe("human");
    const operation = mocks.connect.mock.calls[0]![0];
    expect(() => operation.check()).toThrow("disposed");
    client.emit("close", 0, null); await pending;
  });

  it("refuses noninteractive IO before inspecting the private instance", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    await expect(attachWorker({ homeDirectory: "/worker" })).rejects.toThrow("interactive terminal");
    expect(mocks.instance).not.toHaveBeenCalled(); expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("keeps a failed instance inspection visible without starting a client", async () => {
    const cause = new Error("The worker Herdr session is not running. Start it with daynight worker run."); mocks.connect.mockRejectedValue(cause);
    await expect(attachWorker({ homeDirectory: "/worker" })).rejects.toBe(cause);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("forwards parent termination only to the client and removes signal listeners after it closes", async () => {
    const before = signals.map((signal) => process.listenerCount(signal));
    const pending = attachWorker({ homeDirectory: "/worker" }); await spawned();
    process.emit("SIGTERM"); expect(client.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    client.emit("close", 0, null); await pending;
    expect(signals.map((signal) => process.listenerCount(signal))).toEqual(before);
  });

  it.each([{ code: 7, signal: null }, { code: null, signal: "SIGTERM" }])("reports an unsuccessful client exit %j", async ({ code, signal }) => {
    const before = signals.map((value) => process.listenerCount(value));
    const pending = attachWorker({ homeDirectory: "/worker" }); await spawned();
    client.emit("close", code, signal);
    await expect(pending).rejects.toThrow(`exit=${String(code)}, signal=${String(signal)}`);
    expect(signals.map((value) => process.listenerCount(value))).toEqual(before);
  });

  it("preserves executable failures and releases its signal listeners", async () => {
    const before = signals.map((signal) => process.listenerCount(signal));
    const pending = attachWorker({ homeDirectory: "/worker" }); await spawned();
    const cause = Object.assign(new Error("Missing herdr"), { code: "ENOENT" }); client.emit("error", cause); client.emit("close", -2, null);
    await expect(pending).rejects.toMatchObject({ message: "Cannot start the Herdr attach client.", cause });
    expect(signals.map((signal) => process.listenerCount(signal))).toEqual(before);
  });
});
