import { describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { AssistantTaskApiError, type AssistantTaskClient } from "../../../src/api/assistant-task.js";
import type { ApiClient } from "../../../src/api/client.js";
import { runCli } from "../../../src/cli/application.js";
import type { CliContext } from "../../../src/cli/context.js";
import { runAssistantTaskCommand, type AssistantTaskCommandDependencies } from "../../../src/commands/assistant-task/command.js";
import { assistantTaskDefinition } from "../../../src/commands/assistant-task/definition.js";

const owner = "11111111-1111-4111-8111-111111111111", task = "22222222-2222-4222-8222-222222222222", bot = "33333333-3333-4333-8333-333333333333", op = "55555555-5555-4555-8555-555555555555";
const token = "dnib_PRIVATE";
const receipt = { operation: { operationId: op, kind: "inbox_enable", taskId: task }, inbox: { enabled: true }, token };

const fixture = (methods: Partial<AssistantTaskClient>, environment: NodeJS.ProcessEnv = {}) => {
  let out = "", err = "";
  const context: CliContext = { version: "test", packageDirectory: "unused", homeDirectory: () => "/home/test", workingDirectory: () => { throw new Error("Project discovery is forbidden"); }, stdout: text => { out += text; }, stdoutBytes: async bytes => { out += Buffer.from(bytes).toString(); }, stderr: text => { err += text; } };
  const client = new Proxy(methods, { get: (object, key) => {
    if (key in object) return object[key as keyof AssistantTaskClient];
    throw new Error(`Unexpected client method ${String(key)}`);
  } }) as AssistantTaskClient;
  const runServerCommand: AssistantTaskCommandDependencies["runServerCommand"] = vi.fn(async (ctx, callback) => {
    const operation = createOperation();
    try {
      const output = await callback({ api: { getCurrentUser: vi.fn(async () => ({ id: owner })) } as unknown as ApiClient, operation, serverUrl: "https://daynight.test", serverConfiguration: { serverUrl: "https://daynight.test" } });
      if (typeof output === "string") ctx.stdout(output);
      else if (output !== undefined) await ctx.stdoutBytes(Buffer.from(output.output), operation.signal);
    } finally { operation.dispose(); }
  });
  const deps = { createClient: vi.fn(() => client), runServerCommand, environment };
  const run = async (args: string[]) => {
    const registry = [{ ...assistantTaskDefinition, load: async () => ({ run: (input: readonly string[], ctx: CliContext) => runAssistantTaskCommand(input, ctx, deps) }) }];
    const exit = await runCli(["assistant-task", ...args], context, registry);
    return { exit, out, err };
  };
  return { run, ...deps };
};

describe("assistant-task inbox commands", () => {
  it("passes exact management inputs and prints the generated token once", async () => {
    const enableInbox = vi.fn(async () => receipt), rotateInbox = vi.fn(async () => receipt), disableInbox = vi.fn(async () => receipt);
    const getInbox = vi.fn(async () => receipt.inbox), getInboxOperation = vi.fn(async () => receipt);
    const f = fixture({ enableInbox, rotateInbox, disableInbox, getInbox, getInboxOperation } as unknown as Partial<AssistantTaskClient>);
    const enabled = await f.run(["inbox", "enable", task, "--if-version", "7", "--operation-id", op, "--json"]);
    expect(enabled.exit).toBe(0);
    expect(JSON.parse(enabled.out)).toEqual(receipt);
    expect(enableInbox).toHaveBeenCalledWith(task, { operationId: op, ifVersion: "7" });
    expect((await f.run(["inbox", "rotate", task, "--if-version", "8", "--mode", "overlap", "--operation-id", op])).exit).toBe(0);
    expect(rotateInbox).toHaveBeenCalledWith(task, { operationId: op, ifVersion: "8", mode: "overlap" });
    expect((await f.run(["inbox", "disable", task, "--if-version", "9", "--operation-id", op])).exit).toBe(0);
    expect(disableInbox).toHaveBeenCalledWith(task, { operationId: op, ifVersion: "9" });
    expect((await f.run(["inbox", "show", task])).exit).toBe(0);
    expect(getInbox).toHaveBeenCalledWith(task);
    expect((await f.run(["inbox", "operation", task, op])).exit).toBe(0);
    expect(getInboxOperation).toHaveBeenCalledWith(task, op);
  });
  it("lets a Bot read the inbox state but refuses management before service access", async () => {
    const getInbox = vi.fn(async () => receipt.inbox);
    const f = fixture({ getInbox } as unknown as Partial<AssistantTaskClient>, { DAYNIGHT_BOT_ID: bot });
    expect((await f.run(["inbox", "show", task])).exit).toBe(0);
    for (const args of [["inbox", "enable", task, "--if-version", "1"], ["inbox", "rotate", task, "--if-version", "1", "--mode", "immediate"], ["inbox", "disable", task, "--if-version", "1"], ["inbox", "operation", task, op]]) {
      const response = await fixture({}, { DAYNIGHT_BOT_ID: bot }).run(args);
      expect(response.exit).toBe(2);
      expect(response.err).toContain("user-only operation");
    }
  });
  it("requires a rotation mode and an exact version before service access", async () => {
    const f = fixture({});
    for (const args of [["inbox", "rotate", task, "--if-version", "1"], ["inbox", "rotate", task, "--if-version", "1", "--mode", "later"], ["inbox", "enable", task], ["inbox", "enable", task, "--if-version", "01"]]) {
      expect((await f.run(args)).exit).toBe(2);
    }
    expect(f.runServerCommand).not.toHaveBeenCalled();
  });
  it("directs an unknown write outcome to the original inbox operation", async () => {
    const f = fixture({ enableInbox: vi.fn(async () => { throw new AssistantTaskApiError(true, "write_outcome_unknown", 503); }) });
    const response = await f.run(["inbox", "enable", task, "--if-version", "1", "--operation-id", op, "--json"]);
    expect(response.exit).toBe(1);
    const failure = JSON.parse(response.err) as { error: { outcomeUnconfirmed: boolean; reconcile: string } };
    expect(failure.error).toMatchObject({ outcomeUnconfirmed: true, reconcile: `daynight assistant-task inbox operation ${task} ${op} --json` });
  });
});
