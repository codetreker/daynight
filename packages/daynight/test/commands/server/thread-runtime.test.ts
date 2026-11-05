import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OperationError } from "../../../src/api/index.js";
import type { CliContext } from "../../../src/cli/context.js";
import { writeOutputBytes } from "../../../src/cli/byte-output.js";
import { runServerCommand } from "../../../src/commands/server/runtime.js";
import type { ConfirmedMutationOutput, ServerSession } from "../../../src/commands/server/runtime.js";
import { formatError, PublicDiagnosticError } from "../../../src/platform/diagnostics.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const messageId = "44444444-4444-4444-8444-444444444444";
const body = "A complete message";
const message = { id: messageId, author: { userId, displayName: null, Agent: false }, body, createdAt: "2026-11-03T10:20:30.000Z" };
const receipt = `Message posted.\nId: ${messageId}\n`;
const confirmed = (): ConfirmedMutationOutput => ({ kind: "confirmed-mutation", output: receipt, failureText: (phase) => `Message posted. Id: ${messageId}\nThe message is confirmed, but local ${phase} failed.` });
const response = (): Response => new Response(JSON.stringify(message), { status: 201, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } });
let directory: string;
beforeAll(async () => {
  const temporary = fileURLToPath(new URL("../../../../../.tmp/", import.meta.url));
  await mkdir(temporary, { recursive: true });
  directory = await mkdtemp(path.join(temporary, "thread-runtime-"));
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

const fixture = async () => {
  const home = await mkdtemp(path.join(directory, "home-"));
  const config = path.join(home, ".daynight", "config.yml");
  await mkdir(path.dirname(config));
  await writeFile(config, "serverUrl: http://127.0.0.1:8787\nserverToken: fixture-token\n");
  const context = {
    version: "0.0.0", packageDirectory: "unused", homeDirectory: () => home,
    workingDirectory: () => { throw new Error("An explicit project must not discover Git"); },
    stdout: vi.fn<(text: string) => void>(), stdoutBytes: vi.fn<CliContext["stdoutBytes"]>(async () => {}),
    stderr: vi.fn<(text: string) => void>(), closeStdoutBytes: vi.fn(async () => {}),
  } satisfies CliContext;
  return { context, config, signals: new EventEmitter(), fetch: vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response()) };
};
const expectReleased = (signals: EventEmitter): void => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) expect(signals.listenerCount(signal)).toBe(0);
};

describe("confirmed Thread post runtime lifecycle", () => {
  it("keeps secret output failures and nested cleanup causes out of the error chain", async () => {
    const f = await fixture();
    const secret = "dnteam_private-secret";
    f.context.stdoutBytes.mockRejectedValue(new TypeError(`failed to write ${secret}`, { cause: new Error(secret) }));
    f.context.closeStdoutBytes.mockRejectedValue(new Error(`close ${secret}`));
    const result = runServerCommand(f.context, async () => ({
      kind: "confirmed-mutation", output: secret, containsSecret: true,
      failureText: (phase) => `Invitation creation confirmed, but local ${phase} failed.`,
    }), { signalEmitter: f.signals });
    await result.catch((error: unknown) => {
      expect(error).toBeInstanceOf(PublicDiagnosticError);
      expect(formatError(error)).toContain("Invitation creation confirmed");
      const causes: unknown[] = [];
      const walk = (value: unknown) => {
        if (!(value instanceof Error)) return;
        causes.push(value.message);
        if (value instanceof AggregateError) value.errors.forEach(walk);
        walk(value.cause);
      };
      walk(error);
      expect(JSON.stringify(causes)).not.toContain(secret);
      expect(causes).toContain("Sensitive failure details withheld.");
    });
    expectReleased(f.signals);
  });
  it("keeps a fully validated POST confirmed when cancellation arrives before callback completion", async () => {
    const f = await fixture();
    let session: ServerSession | undefined;
    f.context.stdoutBytes.mockImplementation(async (_chunk, signal) => { expect(signal.aborted).toBe(false); });
    await runServerCommand(f.context, async (current) => {
      session = current;
      expect(await current.api.postTaskThreadMessage(projectId, taskId, { body })).toEqual(message);
      f.signals.emit("SIGINT");
      return confirmed();
    }, { signalEmitter: f.signals, fetch: f.fetch });
    expect(f.context.stdoutBytes).toHaveBeenCalledExactlyOnceWith(Buffer.from(receipt), expect.any(AbortSignal));
    expect(f.context.stdoutBytes.mock.calls[0]![1].aborted).toBe(true);
    expect(f.context.stdout).not.toHaveBeenCalled();
    expect(f.context.stderr).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(session!.operation.signal.aborted).toBe(true);
    expectReleased(f.signals);
    expect(f.context.closeStdoutBytes).toHaveBeenCalledOnce();
  });

  it("still checks cancellation for an ordinary string callback result", async () => {
    const f = await fixture();
    await expect(runServerCommand(f.context, async () => {
      f.signals.emit("SIGTERM");
      return "ordinary output\n";
    }, { signalEmitter: f.signals })).rejects.toBeInstanceOf(OperationError);
    expect(f.context.stdout).not.toHaveBeenCalled();
    expectReleased(f.signals);
  });

  it("exposes a local stdout failure with the confirmed message Id and original cause", async () => {
    const f = await fixture();
    const failure = new Error("private stdout error");
    f.context.stdoutBytes.mockRejectedValue(failure);
    const result = runServerCommand(f.context, async ({ api }) => {
      await api.postTaskThreadMessage(projectId, taskId, { body });
      return confirmed();
    }, { signalEmitter: f.signals, fetch: f.fetch });
    await expect(result).rejects.toMatchObject({ exitCode: 1, cause: failure });
    await result.catch((error: unknown) => {
      expect(error).toBeInstanceOf(PublicDiagnosticError);
      expect(formatError(error)).toContain(`Message posted. Id: ${messageId}`);
      expect(formatError(error)).toContain("local output failed");
      expect(formatError(error)).not.toMatch(/unknown|retry|private stdout error/i);
    });
    expectReleased(f.signals);
    expect(f.context.closeStdoutBytes).toHaveBeenCalledOnce();
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("captures a Writable callback failure and its following error event without an unhandled error", async () => {
    const f = await fixture();
    const failure = new Error("private asynchronous stdout error");
    const output = new Writable({ write(_chunk, _encoding, callback) { queueMicrotask(() => callback(failure)); } });
    f.context.stdoutBytes.mockImplementation((chunk, signal) => writeOutputBytes(output, chunk, signal));
    const result = runServerCommand(f.context, async ({ api }) => {
      await api.postTaskThreadMessage(projectId, taskId, { body });
      return confirmed();
    }, { signalEmitter: f.signals, fetch: f.fetch });
    await expect(result).rejects.toMatchObject({ exitCode: 1, cause: failure });
    await result.catch((error: unknown) => {
      expect(error).toBeInstanceOf(PublicDiagnosticError);
      expect(formatError(error)).toContain(`Message posted. Id: ${messageId}`);
      expect(formatError(error)).toContain("local output failed");
      expect(formatError(error)).not.toMatch(/unknown|retry|private asynchronous stdout error/i);
    });
    expect(f.context.stdout).not.toHaveBeenCalled();
    expect(output.listenerCount("error")).toBe(0);
    expect(output.listenerCount("close")).toBe(0);
    expectReleased(f.signals);
    expect(f.context.closeStdoutBytes).toHaveBeenCalledOnce();
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("exposes cleanup failure after confirmation without changing the remote outcome", async () => {
    const f = await fixture();
    const failure = new Error("private cleanup error");
    f.context.closeStdoutBytes.mockRejectedValue(failure);
    const result = runServerCommand(f.context, async ({ api }) => {
      await api.postTaskThreadMessage(projectId, taskId, { body });
      return confirmed();
    }, { signalEmitter: f.signals, fetch: f.fetch });
    await expect(result).rejects.toBeInstanceOf(PublicDiagnosticError);
    await result.catch((error: unknown) => {
      expect(error).toMatchObject({ exitCode: 1 });
      expect(formatError(error)).toContain(`Message posted. Id: ${messageId}`);
      expect(formatError(error)).toContain("local cleanup failed");
      expect(formatError(error)).not.toMatch(/unknown|retry|private cleanup error/i);
      expect((error as Error).cause).toBeInstanceOf(AggregateError);
      expect(((error as Error).cause as AggregateError).errors).toContain(failure);
    });
    expect(f.context.stdoutBytes).toHaveBeenCalledExactlyOnceWith(Buffer.from(receipt), expect.any(AbortSignal));
    expect(f.context.stdout).not.toHaveBeenCalled();
    expectReleased(f.signals);
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("captures service origin and PAT once despite configuration edits during the invocation", async () => {
    const f = await fixture();
    await runServerCommand(f.context, async ({ api, serverUrl }) => {
      expect(serverUrl).toBe("http://127.0.0.1:8787");
      await writeFile(f.config, "serverUrl: http://127.0.0.1:9999\nserverToken: changed-token\n");
      await api.postTaskThreadMessage(projectId, taskId, { body });
      return confirmed();
    }, { signalEmitter: f.signals, fetch: f.fetch });
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(String(f.fetch.mock.calls[0]![0])).toBe(`http://127.0.0.1:8787/api/v1/projects/${projectId}/tasks/${taskId}/thread/messages`);
    expect(f.fetch.mock.calls[0]![1]!.headers).toMatchObject({ Authorization: "Bearer fixture-token" });
    expect(f.context.stdoutBytes).toHaveBeenCalledExactlyOnceWith(Buffer.from(receipt), expect.any(AbortSignal));
    expect(f.context.stdout).not.toHaveBeenCalled();
    expectReleased(f.signals);
  });

  it("does not manufacture a confirmed result when the POST resource is invalid", async () => {
    const f = await fixture();
    f.fetch.mockImplementation(async () => new Response(JSON.stringify({ ...message, author: { ...message.author, userId: taskId } }), { status: 201, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } }));
    await expect(runServerCommand(f.context, async ({ api }) => {
      await api.postTaskThreadMessage(projectId, taskId, { body });
      return confirmed();
    }, { signalEmitter: f.signals, fetch: f.fetch })).rejects.toMatchObject({ outcomeUnconfirmed: true });
    expect(f.context.stdout).not.toHaveBeenCalled();
    expect(f.context.stdoutBytes).not.toHaveBeenCalled();
    expectReleased(f.signals);
    expect(f.fetch).toHaveBeenCalledOnce();
  });
});
