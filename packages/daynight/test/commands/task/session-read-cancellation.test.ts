import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runCli } from "../../../src/cli/application.js";
import type { CliContext } from "../../../src/cli/context.js";
import { runServerCommand } from "../../../src/commands/server/runtime.js";
import type { ServerCommandOptions } from "../../../src/commands/server/runtime.js";
import { runTaskCommand } from "../../../src/commands/task/command.js";
import { taskDefinition } from "../../../src/commands/task/definition.js";
import { actorId, projectId, sessionId, taskId } from "../../fixtures/task-observation.js";

let directory: string;
beforeAll(async () => {
  const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp");
  await mkdir(temporary, { recursive: true });
  directory = await mkdtemp(path.join(temporary, "session-read-cancellation-"));
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

const fixture = async (operationLimits: ServerCommandOptions["operationLimits"] = { totalMs: 2000, requestMs: 1000 }) => {
  const home = await mkdtemp(path.join(directory, "home-"));
  await mkdir(path.join(home, ".daynight"));
  await writeFile(path.join(home, ".daynight", "config.yml"), "serverUrl: http://127.0.0.1:8787\nserverToken: fixture-token\n");
  const signals = new EventEmitter(), waiting = Promise.withResolvers<void>();
  const existing = vi.fn(); signals.on("SIGINT", existing);
  const cancelledBody = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"sessionId":')); },
    pull() { waiting.resolve(); },
    cancel: cancelledBody,
  });
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(stream, {
    status: 200, headers: { "content-type": "application/json", "Daynight-User-ID": actorId },
  }));
  const context = {
    version: "0.0.0", packageDirectory: "unused", homeDirectory: () => home,
    workingDirectory: () => { throw new Error("An explicit project must not discover Git."); },
    stdout: vi.fn<CliContext["stdout"]>(), stderr: vi.fn<CliContext["stderr"]>(),
    stdoutBytes: vi.fn<CliContext["stdoutBytes"]>(async () => {}), closeStdoutBytes: vi.fn(async () => {}),
  } satisfies CliContext;
  const run = (args: readonly string[]) => runCli(["task", "session", ...args, "--project", projectId, "--json"], context, [{
    ...taskDefinition, load: async () => ({ run: (values, current) => runTaskCommand(values, current, {
      resolveProject: async () => { throw new Error("An explicit project must not discover Git."); },
      runServerCommand: (current, command) => runServerCommand(current, command, { signalEmitter: signals, platform: "linux", fetch, operationLimits }),
    }) }),
  }]);
  const expectReleased = () => {
    expect(signals.listeners("SIGINT")).toEqual([existing]);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(context.closeStdoutBytes).toHaveBeenCalledOnce();
    expect(cancelledBody).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
    expect(fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  };
  return { run, context, signals, existing, fetch, waiting: waiting.promise, expectReleased };
};

describe("Task Session read cancellation", () => {
  it.each([
    ["current", taskId], ["list", taskId], ["show", taskId, sessionId],
    ["read", taskId, sessionId], ["entry", taskId, sessionId, "--cursor", "entry-start"],
  ].map(args => ({ args }))) ("returns 130 after SIGINT while reading $args", async ({ args }) => {
    const f = await fixture(), pending = f.run(args);
    await Promise.race([f.waiting, pending.then(code => { throw new Error(`Command exited before response-body read: ${code}`); })]);
    f.signals.emit("SIGINT");
    expect(await pending).toBe(130);
    expect(f.context.stdout).not.toHaveBeenCalled();
    expect(f.context.stdoutBytes).not.toHaveBeenCalled();
    expect(f.context.stderr.mock.calls.flat().join("")).toContain("Session read cancelled. Received SIGINT.");
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.existing).toHaveBeenCalledOnce();
    f.expectReleased();
  });

  it("retains cancellation through an aggregate cleanup failure", async () => {
    const f = await fixture();
    f.context.closeStdoutBytes.mockRejectedValue(new Error("Output helper cleanup failed."));
    const pending = f.run(["read", taskId, sessionId]);
    await Promise.race([f.waiting, pending.then(code => { throw new Error(`Command exited before response-body read: ${code}`); })]);
    f.signals.emit("SIGINT");
    expect(await pending).toBe(130);
    expect(f.context.stdoutBytes).not.toHaveBeenCalled();
    expect(f.context.stderr.mock.calls.flat().join("")).toContain("Session read cancelled.");
    expect(f.fetch).toHaveBeenCalledOnce();
    f.expectReleased();
  });

  it("keeps request timeout as exit 1 instead of treating it as a user signal", async () => {
    const f = await fixture({ totalMs: 2000, requestMs: 25 });
    expect(await f.run(["read", taskId, sessionId])).toBe(1);
    expect(f.context.stderr.mock.calls.flat().join("")).not.toContain("cancelled");
    expect(f.context.stdout).not.toHaveBeenCalled();
    expect(f.context.stdoutBytes).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.existing).not.toHaveBeenCalled();
    f.expectReleased();
  });
});
