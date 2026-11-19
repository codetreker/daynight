import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageError } from "../../../src/cli/context.js";
import type { CliContext } from "../../../src/cli/context.js";
import { runTaskCommand } from "../../../src/commands/task/command.js";
import { runServerCommand } from "../../../src/commands/server/runtime.js";

const projectId = "abcdefab-1111-4111-8111-111111111111";
const taskId = "abcdefab-2222-4222-8222-222222222222";
const botId = "abcdefab-4444-4444-8444-444444444444";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

// A confirmed refusal ends each command after its single request, so every
// case observes exactly the headers the command sent.
const refusal = (): Response => new Response(JSON.stringify({ error: { code: "conflict", message: "The request failed.", requestId: "bot-request" } }), { status: 409, headers: { "Content-Type": "application/json" } });

const fixture = async (environment: NodeJS.ProcessEnv) => {
  const temporary = fileURLToPath(new URL("../../../../../.tmp/task-bot-identity/", import.meta.url));
  await mkdir(temporary, { recursive: true });
  const home = await mkdtemp(path.join(temporary, "home-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, ".daynight"));
  await writeFile(path.join(home, ".daynight", "config.yml"), "serverUrl: http://127.0.0.1:8787\nserverToken: fixture-token\n");
  const context: CliContext = {
    version: "0.0.0", packageDirectory: "unused", homeDirectory: () => home,
    workingDirectory: () => { throw new Error("Explicit project must not query cwd"); },
    stdout: vi.fn(), stdoutBytes: vi.fn(async () => {}), stderr: vi.fn(),
  };
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => refusal());
  const signals = new EventEmitter();
  const dependencies = {
    runServerCommand: ((current, command, options = {}) => runServerCommand(current, command, { ...options, signalEmitter: signals, fetch })) as typeof runServerCommand,
    resolveProject: vi.fn(async (): Promise<never> => { throw new Error("Explicit project must not resolve repository"); }),
    environment,
  };
  const run = (args: readonly string[]) => runTaskCommand([...args, `--project=${projectId}`], context, dependencies);
  const headers = () => fetch.mock.calls.map(([, init]) => init!.headers as Record<string, string>);
  return { fetch, run, headers };
};

describe("task commands in an assistant environment", () => {
  it("declares DAYNIGHT_BOT_ID on Thread writes", async () => {
    const f = await fixture({ DAYNIGHT_BOT_ID: botId });
    await expect(f.run(["thread", "post", taskId, "--body=Body"])).rejects.toThrow();
    expect(f.headers()).toHaveLength(1);
    expect(f.headers()[0]).toMatchObject({ "X-Daynight-Bot-Id": botId, Authorization: "Bearer fixture-token" });
  });

  it("never declares DAYNIGHT_BOT_ID on reads", async () => {
    const f = await fixture({ DAYNIGHT_BOT_ID: botId });
    await expect(f.run(["thread", "read", taskId])).rejects.toThrow();
    expect(f.headers()).toHaveLength(1);
    expect(f.headers()[0]).not.toHaveProperty("X-Daynight-Bot-Id");
  });

  it("sends no Bot declaration outside an assistant environment", async () => {
    const f = await fixture({});
    await expect(f.run(["thread", "post", taskId, "--body=Body"])).rejects.toThrow();
    expect(f.headers()).toHaveLength(1);
    expect(f.headers()[0]).not.toHaveProperty("X-Daynight-Bot-Id");
  });

  it.each([botId.toUpperCase(), "00000000-0000-0000-0000-000000000000", "", "not-a-uuid"])("rejects DAYNIGHT_BOT_ID %j before any request", async (value) => {
    for (const args of [["thread", "post", taskId, "--body=Body"], ["thread", "read", taskId]]) {
      const f = await fixture({ DAYNIGHT_BOT_ID: value });
      const failure = await f.run(args).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(UsageError);
      expect((failure as Error).message).toContain("DAYNIGHT_BOT_ID must be a nonzero canonical lowercase UUID");
      expect(f.fetch).not.toHaveBeenCalled();
    }
  });
});
