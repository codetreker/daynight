import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachWorker } from "../../../src/commands/worker/attach.js";

const mocks = vi.hoisted(() => ({ connect: vi.fn(), instance: vi.fn(), spawn: vi.fn() }));
vi.mock("../../../src/commands/worker/herdr/instance.js", () => ({ createHerdrInstance: mocks.instance }));
vi.mock("../../../src/commands/worker/herdr/command.js", () => ({ spawnHerdrProcess: mocks.spawn }));

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
  vi.clearAllMocks();
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  client = child();
  mocks.connect.mockResolvedValue({ reconnected: true });
  mocks.instance.mockReturnValue({ connect: mocks.connect, attachment });
  mocks.spawn.mockReturnValue(client as unknown as ChildProcess);
});
afterEach(() => {
  if (stdinTty === undefined) Reflect.deleteProperty(process.stdin, "isTTY"); else Object.defineProperty(process.stdin, "isTTY", stdinTty);
  if (stdoutTty === undefined) Reflect.deleteProperty(process.stdout, "isTTY"); else Object.defineProperty(process.stdout, "isTTY", stdoutTty);
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
const spawned = async (): Promise<void> => { await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce()); };

describe("worker terminal attachment", () => {
  it("connects to the existing private session with inherited terminal IO and cleaned routing identities", async () => {
    vi.stubEnv("HERDR_SESSION", "human"); vi.stubEnv("HERDR_SOCKET_PATH", "/human.sock"); vi.stubEnv("CODEX_THREAD_ID", "parent"); vi.stubEnv("CODEX_HOME", "/native-home");
    const pending = attachWorker({ homeDirectory: "/worker" });
    await spawned();
    expect(mocks.connect).toHaveBeenCalledOnce();
    const [executable, args, options] = mocks.spawn.mock.calls[0]!;
    expect(executable).toBe("herdr"); expect(args).toEqual(["--session", "w", "client"]);
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
