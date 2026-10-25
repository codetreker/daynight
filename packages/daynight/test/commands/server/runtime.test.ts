import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError, OperationError, stringifyApiJson } from "../../../src/api/index.js";
import type { CliContext } from "../../../src/cli/context.js";
import { runServerCommand } from "../../../src/commands/server/runtime.js";
import type { ServerSession } from "../../../src/commands/server/runtime.js";

const projectId = "11111111-1111-1111-1111-111111111111";
const time = "2026-10-20T01:02:03.123456789Z";
const project = { id: projectId, name: "Project", repoUrl: "git@github.com:Org/Repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time };
let directory: string;
const cleanups: (() => void | Promise<void>)[] = [];
beforeAll(async () => {
  const temporary = fileURLToPath(new URL("../../../../../.tmp/", import.meta.url));
  await mkdir(temporary, { recursive: true });
  directory = await mkdtemp(path.join(temporary, "server-runtime-"));
});
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

const fixture = async (serverUrl = "http://127.0.0.1:8787"): Promise<CliContext & { stdout: ReturnType<typeof vi.fn<(text: string) => void>>; stderr: ReturnType<typeof vi.fn<(text: string) => void>> }> => {
  const home = await mkdtemp(path.join(directory, "home-"));
  await mkdir(path.join(home, ".daynight"));
  await writeFile(path.join(home, ".daynight", "config.yml"), `serverUrl: ${serverUrl}\nserverToken: fixture-token\n`);
  return {
    version: "0.0.0", packageDirectory: "unused", homeDirectory: () => home,
    workingDirectory: () => { throw new Error("Server runtime must not query cwd"); },
    stdoutBytes: vi.fn(async () => {}), stdout: vi.fn<(text: string) => void>(), stderr: vi.fn<(text: string) => void>(),
  };
};

const server = async (handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> => {
  const created = createServer(handler);
  await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    created.close((error) => error === undefined ? resolve() : reject(error));
    created.closeAllConnections();
  }));
  const address = created.address();
  if (typeof address !== "object" || address === null) throw new Error("Server address unavailable");
  return `http://127.0.0.1:${address.port}`;
};

const expectReleased = (signals: EventEmitter): void => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) expect(signals.listenerCount(signal)).toBe(0);
};

describe("shared server command runtime", () => {
  it("loads server-only configuration, returns complete real HTTP results once, and owns one session lifetime", async () => {
    const requests: string[] = [];
    const serverUrl = await server((request, response) => {
      requests.push(request.url!);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(stringifyApiJson(request.url!.includes("?") ? { items: [project], nextCursor: null } : project));
    });
    const context = await fixture(`${serverUrl}/`);
    const signals = new EventEmitter();
    let session: ServerSession | undefined;
    await runServerCommand(context, async (current) => {
      session = current;
      expect(current.serverUrl).toBe(serverUrl);
      expect(current.operation.signal.aborted).toBe(false);
      const listed = await current.api.listProjects();
      const detail = await current.api.getProject(listed[0]!.id);
      expect(context.stdout).not.toHaveBeenCalled();
      return `${listed.length}: ${detail.name}\n`;
    }, { signalEmitter: signals });
    expect(context.stdout).toHaveBeenCalledExactlyOnceWith("1: Project\n");
    expect(context.stderr).not.toHaveBeenCalled();
    expect(requests).toEqual(["/api/v1/projects?limit=100", `/api/v1/projects/${projectId}`]);
    expect(session!.operation.signal.aborted).toBe(true);
    expect(() => session!.operation.check()).toThrow("disposed");
    expectReleased(signals);
  });

  it("keeps stdout empty and preserves the original failure after a callback rejects", async () => {
    const context = await fixture();
    const signals = new EventEmitter();
    const failure = new Error("Rendering failed", { cause: new Error("Malformed render state") });
    let session: ServerSession | undefined;
    await expect(runServerCommand(context, async (current) => { session = current; throw failure; }, { signalEmitter: signals })).rejects.toBe(failure);
    expect(context.stdout).not.toHaveBeenCalled();
    expect(session!.operation.signal.aborted).toBe(true);
    expectReleased(signals);
  });

  it("releases cancellation listeners when credentials are missing", async () => {
    const context = await fixture();
    await rm(path.join(context.homeDirectory(), ".daynight", "config.yml"));
    const signals = new EventEmitter();
    const callback = vi.fn(async () => "unreachable\n");
    await expect(runServerCommand(context, callback, { signalEmitter: signals })).rejects.toMatchObject({ message: expect.stringContaining("daynight login") });
    expect(callback).not.toHaveBeenCalled();
    expect(context.stdout).not.toHaveBeenCalled();
    expectReleased(signals);
  });

  it("passes cancellation into configuration reading before entering the command callback", async () => {
    const context = await fixture();
    const signals = new EventEmitter();
    const home = context.homeDirectory();
    context.homeDirectory = () => { signals.emit("SIGINT"); return home; };
    const callback = vi.fn(async () => "unreachable\n");
    await expect(runServerCommand(context, callback, { signalEmitter: signals })).rejects.toMatchObject({
      message: expect.stringContaining("Cannot read configuration file"),
      cause: { code: "ABORT_ERR", cause: { kind: "cancelled" } },
    });
    expect(callback).not.toHaveBeenCalled();
    expect(context.stdout).not.toHaveBeenCalled();
    expectReleased(signals);
  });

  it.each(["SIGINT", "SIGTERM", "SIGBREAK"])("cancels the active HTTP body on %s and removes owned listeners", async (signal) => {
    let entered: () => void = () => {};
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const url = await server((_request, response) => { response.writeHead(200, { "Content-Type": "application/json" }); response.write("{"); entered(); });
    const context = await fixture(url);
    const signals = new EventEmitter();
    const pending = runServerCommand(context, async ({ api }) => `${(await api.getProject(projectId)).name}\n`, { signalEmitter: signals, platform: signal === "SIGBREAK" ? "win32" : "linux" });
    await ready;
    signals.emit(signal);
    await expect(pending).rejects.toMatchObject({ operation: "project.show", projectId, cause: { kind: "cancelled", cause: { message: `Received ${signal}.` } } });
    expect(context.stdout).not.toHaveBeenCalled();
    expectReleased(signals);
  });

  it("checks cancellation after rendering before writing stdout", async () => {
    const context = await fixture();
    const signals = new EventEmitter();
    await expect(runServerCommand(context, async () => { signals.emit("SIGINT"); return "complete render\n"; }, { signalEmitter: signals })).rejects.toBeInstanceOf(OperationError);
    expect(context.stdout).not.toHaveBeenCalled();
    expectReleased(signals);
  });

  it("checks the shared deadline after a callback completes its render", async () => {
    const context = await fixture();
    const signals = new EventEmitter();
    await expect(runServerCommand(context, async ({ operation }) => {
      await new Promise<void>((resolve) => operation.signal.addEventListener("abort", () => resolve(), { once: true }));
      return "render completed after deadline\n";
    }, { signalEmitter: signals, operationLimits: { totalMs: 100 } })).rejects.toMatchObject({ kind: "deadline" });
    expect(context.stdout).not.toHaveBeenCalled();
    expectReleased(signals);
  });

  it("shares the cumulative response budget across all API calls in a command", async () => {
    let requests = 0;
    const serverUrl = await server((_request, response) => { requests++; response.writeHead(200, { "Content-Type": "application/json" }); response.end(stringifyApiJson(project)); });
    const context = await fixture(serverUrl);
    const signals = new EventEmitter();
    await expect(runServerCommand(context, async ({ api }) => {
      await api.getProject(projectId);
      await api.getProject(projectId);
      return "should remain unpublished\n";
    }, { signalEmitter: signals, operationLimits: { totalBytes: Buffer.byteLength(stringifyApiJson(project)) + 1 } })).rejects.toMatchObject({ cause: { kind: "total_limit" } });
    expect(requests).toBe(2);
    expect(context.stdout).not.toHaveBeenCalled();
    expectReleased(signals);
  });

  it("preserves an HTTP refusal and does not retry it", async () => {
    const context = await fixture();
    const signals = new EventEmitter();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(stringifyApiJson({ error: { code: "not_found", message: "Project was not found.", requestId: "runtime-refusal" } }), { status: 404, headers: { "Content-Type": "application/json" } }));
    const failure = await runServerCommand(context, async ({ api }) => `${(await api.getProject(projectId)).name}\n`, { signalEmitter: signals, fetch }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ code: "not_found", requestId: "runtime-refusal", projectId, status: 404 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(context.stdout).not.toHaveBeenCalled();
    expectReleased(signals);
  });

  it("preserves another listener on the same process signal", async () => {
    const context = await fixture();
    const signals = new EventEmitter();
    const existing = vi.fn();
    signals.on("SIGINT", existing);
    await runServerCommand(context, async () => "ok\n", { signalEmitter: signals });
    expect(signals.listeners("SIGINT")).toEqual([existing]);
    expect(existing).not.toHaveBeenCalled();
  });

  it.each([
    { platform: "linux" as const, expectedSignals: ["SIGINT", "SIGTERM"] },
    { platform: "win32" as const, expectedSignals: ["SIGINT", "SIGTERM", "SIGBREAK"] },
  ])("retains callback and every listener cleanup failure on $platform", async ({ platform, expectedSignals }) => {
    const context = await fixture();
    const signals = new EventEmitter();
    const failure = new Error("Command failed");
    const cleanupFailure = new Error("Listener cleanup failed");
    const added = vi.spyOn(signals, "on");
    const removed = vi.spyOn(signals, "off").mockImplementation((event, listener) => { EventEmitter.prototype.off.call(signals, event, listener); throw cleanupFailure; });
    const result = await runServerCommand(context, async () => { throw failure; }, { signalEmitter: signals, platform }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual(platform === "win32"
      ? [failure, cleanupFailure, cleanupFailure, cleanupFailure]
      : [failure, cleanupFailure, cleanupFailure]);
    expect(added.mock.calls.map(([signal]) => signal)).toEqual(expectedSignals);
    expect(removed.mock.calls.map(([signal]) => signal)).toEqual(expectedSignals);
    expect(context.stdout).not.toHaveBeenCalled();
    expectReleased(signals);
  });
});

describe("binary server command lifetime", () => {
  it("waits for raw output completion without a text write", async () => {
    const context = await fixture();
    const signals = new EventEmitter();
    let flush: () => void = () => {};
    let started: () => void = () => {};
    const writing = new Promise<void>((resolve) => { started = resolve; });
    const flushed = new Promise<void>((resolve) => { flush = resolve; });
    let session: ServerSession | undefined;
    const bytes = new Uint8Array([255, 0, 128]);
    context.stdoutBytes = vi.fn(async (_chunk, signal) => { expect(signal.aborted).toBe(false); started(); await flushed; });
    const pending = runServerCommand(context, async (current) => {
      session = current;
      await current.api.readTaskAttachment(projectId, "22222222-2222-2222-2222-222222222222", "file", context.stdoutBytes);
    }, { signalEmitter: signals, fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(bytes)) });
    await writing;
    expect(session?.operation.signal.aborted).toBe(false);
    expect(signals.listenerCount("SIGINT")).toBe(1);
    flush();
    await pending;
    expect(context.stdoutBytes).toHaveBeenCalledWith(bytes, expect.any(AbortSignal));
    expect(context.stdout).not.toHaveBeenCalled();
    expect(() => session?.operation.check()).toThrow("disposed");
    expectReleased(signals);
  });
});

describe("binary output resource ownership", () => {
  it("closes output before releasing operation cancellation and signal listeners", async () => {
    const context = await fixture();
    const signals = new EventEmitter();
    let session: ServerSession | undefined;
    context.closeStdoutBytes = vi.fn(async () => {
      expect(session?.operation.signal.aborted).toBe(false);
      expect(signals.listenerCount("SIGINT")).toBe(1);
    });
    await runServerCommand(context, async (current) => { session = current; }, { signalEmitter: signals });
    expect(context.closeStdoutBytes).toHaveBeenCalledOnce();
    expectReleased(signals);
  });

  it("retains the command failure when output shutdown also fails", async () => {
    const context = await fixture();
    const failure = new Error("Content read failed.");
    const cleanup = new Error("Output helper shutdown failed.");
    context.closeStdoutBytes = vi.fn(async () => { throw cleanup; });
    const signals = new EventEmitter();
    const result = await runServerCommand(context, async () => { throw failure; }, { signalEmitter: signals }).catch((cause: unknown) => cause);
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([failure, cleanup]);
    expectReleased(signals);
  });
});
