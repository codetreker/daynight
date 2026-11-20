import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { AssistantTaskApiError } from "../../../src/api/assistant-task.js";
import type { AssistantTaskClient } from "../../../src/api/assistant-task.js";
import type { ApiClient } from "../../../src/api/client.js";
import { runCli } from "../../../src/cli/application.js";
import { commands } from "../../../src/cli/commands.js";
import { runAssistantTaskCommand, type AssistantTaskCommandDependencies } from "../../../src/commands/assistant-task/command.js";
import { assistantTaskDefinition } from "../../../src/commands/assistant-task/definition.js";
import { assistantTaskJson } from "../../../src/commands/assistant-task/api.js";
import type { CliContext } from "../../../src/cli/context.js";

const owner = "11111111-1111-4111-8111-111111111111";
const task = "22222222-2222-4222-8222-222222222222";
const bot = "33333333-3333-4333-8333-333333333333";
const resource = "44444444-4444-4444-8444-444444444444";
const op = "55555555-5555-4555-8555-555555555555";
const target = "66666666-6666-4666-8666-666666666666";
const version = "9007199254740993";
const credential = { claimToken: "PRIVATE-TOKEN", claimGeneration: "2" };
const result = { id: resource, taskId: task, text: "Complete\u001b[31m record", version };
afterEach(() => vi.restoreAllMocks());

const fixture = (methods: Partial<AssistantTaskClient> = {}, environment: NodeJS.ProcessEnv = {}) => {
  let out = "", err = "";
  const context: CliContext = { version: "test", packageDirectory: "unused", homeDirectory: () => "/home/test", workingDirectory: () => { throw new Error("Project discovery is forbidden"); }, stdout: text => { out += text; }, stdoutBytes: async bytes => { out += Buffer.from(bytes).toString(); }, stderr: text => { err += text; } };
  const client = new Proxy(methods, { get: (object, key) => {
    if (key in object) return object[key as keyof AssistantTaskClient];
    throw new Error(`Unexpected client method ${String(key)}`);
  } }) as AssistantTaskClient;
  const createClient = vi.fn((_options: Parameters<AssistantTaskCommandDependencies["createClient"]>[0]) => client);
  const readClaimCredential = vi.fn(async () => credential);
  const runClaimOperation = vi.fn(async () => result) as unknown as AssistantTaskCommandDependencies["runClaimOperation"];
  const recoverClaimOperation = vi.fn(async () => result) as unknown as AssistantTaskCommandDependencies["recoverClaimOperation"];
  const runServerCommand: AssistantTaskCommandDependencies["runServerCommand"] = vi.fn(async (ctx, callback) => {
    const operation = createOperation();
    try {
      const output = await callback({ api: { getCurrentUser: vi.fn(async () => ({ id: owner })) } as unknown as ApiClient, operation, serverUrl: "https://daynight.test", serverConfiguration: { serverUrl: "https://daynight.test", serverToken: "PRIVATE-PAT" } });
      if (typeof output === "string") ctx.stdout(output);
      else if (output !== undefined) await ctx.stdoutBytes(Buffer.from(output.output), operation.signal);
    } finally { operation.dispose(); }
  });
  const deps = { createClient, readClaimCredential, runClaimOperation, recoverClaimOperation, runServerCommand, environment };
  const run = async (args: string[]) => {
    const registry = [{ ...assistantTaskDefinition, load: async () => ({ run: (input: readonly string[], ctx: CliContext) => runAssistantTaskCommand(input, ctx, deps) }) }];
    const exit = await runCli(["assistant-task", ...args], context, registry);
    return { exit, out, err };
  };
  return { run, ...deps };
};

describe("assistant-task command grammar and identity", () => {
  it("registers the command without loading service configuration", async () => {
    expect(commands.find(value => value.name === "assistant-task")).toBeDefined();
    const f = fixture();
    const response = await f.run(["claim", "--help"]);
    expect(response.exit).toBe(0);
    expect(response.out).toContain("--expected-generation");
    expect(f.runServerCommand).not.toHaveBeenCalled();
  });
  it.each([
    ["claim", task, "--if-version", "1", "--expected-generation", "0"],
    ["bind", task, "--expected-generation", "1"],
    ["renew", task],
    ["ask", task, "--question", "Can you inspect this?"],
    ["record", "add", task, "--kind", "note", "--text", "Observation"],
    ["events", "ack", task, resource],
  ])("rejects Bot work without identity before service access: %j", async (...args) => {
    const f = fixture();
    const response = await f.run(args);
    expect(response.exit).toBe(2);
    expect(response.err).toContain("DAYNIGHT_BOT_ID");
    expect(f.runServerCommand).not.toHaveBeenCalled();
  });
  it.each([
    ["pause", task, "--if-version", "1"],
    ["delete", task, "--if-version", "1"],
    ["proposal", "decide", task, resource, "--if-version", "1", "--decision", "approved"],
  ])("rejects user decisions with Bot identity: %j", async (...args) => {
    const f = fixture({}, { DAYNIGHT_BOT_ID: bot });
    expect((await f.run(args)).exit).toBe(2);
    expect(f.runServerCommand).not.toHaveBeenCalled();
  });
  it.each([
    ["show", "INVALID"],
    ["metrics", "INVALID"],
    ["list", "--limit", "201"],
    ["list", "--limit", "01"],
    ["pause", task, "--if-version", "01"],
    ["pause", task, "--if-version", "9223372036854775808"],
    ["update", task, "--if-version", "1"],
    ["update", task, "--if-version", "1", "--trigger", "{bad}"],
    ["record", "add", task, "--kind", "note", "--text", "Observation", "--refs", "null"],
    ["release", task, "--expected-generation", "0"],
  ])("refuses malformed or incomplete decisions before network: %j", async (...args) => {
    const f = fixture();
    expect((await f.run(args)).exit).toBe(2);
    expect(f.runServerCommand).not.toHaveBeenCalled();
  });
  it("rejects malformed Bot environment instead of silently adopting user identity", async () => {
    const f = fixture({}, { DAYNIGHT_BOT_ID: "" });
    expect((await f.run(["list"])).exit).toBe(2);
    expect(f.runServerCommand).not.toHaveBeenCalled();
  });
  it("rejects lossy JSON integers before dispatch", () => {
    expect(() => assistantTaskJson('{"number":9007199254740993}')).toThrow();
    expect(assistantTaskJson('{"number":1.25}')).toEqual({ number: 1.25 });
  });
});

describe("assistant-task command reads and user writes", () => {
  it("preserves a page cursor, filters and complete JSON data", async () => {
    const page = { items: [result], nextCursor: "opaque+cursor", observedAt: "2026-11-13T10:00:00Z" };
    const listTasks = vi.fn(async () => page) as unknown as AssistantTaskClient["listTasks"];
    const f = fixture({ listTasks }, { DAYNIGHT_BOT_ID: bot });
    const response = await f.run(["list", "--limit", "200", "--cursor", "previous+cursor", "--state", "paused", "--target-bot", target, "--json"]);
    expect(response.exit).toBe(0);
    expect(JSON.parse(response.out)).toEqual(page);
    expect(listTasks).toHaveBeenCalledExactlyOnceWith({ limit: 200, cursor: "previous+cursor", state: "paused", targetBotId: target });
    expect(f.createClient.mock.calls[0]![0]).toMatchObject({ expectedUserId: owner, botId: bot, serverUrl: "https://daynight.test" });
    expect(response.out + response.err).not.toContain("PRIVATE-");
  });
  it.each([
    { args: ["manual", "show", task, "--version", version], method: "getManual", expected: [task, version] },
    { args: ["manual", "list", task], method: "listManuals", expected: [task, {}] },
    { args: ["appendix", "list", task], method: "listAppendix", expected: [task, {}] },
    { args: ["proposal", "list", task], method: "listProposals", expected: [task, {}] },
    { args: ["item", "show", task, resource], method: "getItem", expected: [task, resource] },
    { args: ["metrics", task], method: "getMetrics", expected: [task] },
    { args: ["record", "list", task, "--item", resource], method: "listRecords", expected: [task, { itemId: resource }] },
    { args: ["inquiry", "list", task, "--state", "open"], method: "listInquiries", expected: [task, { state: "open" }] },
    { args: ["events", "pull", "--target-bot", bot], method: "listEvents", expected: [undefined, { targetBotId: bot }] },
  ])("routes $method to the correct task resource", async ({ args, method, expected }) => {
    const call = vi.fn(async () => result);
    const f = fixture({ [method]: call });
    const response = await f.run([...args, "--json"]);
    expect(response.exit).toBe(0);
    expect(call).toHaveBeenCalledExactlyOnceWith(...expected);
    expect(JSON.parse(response.out)).toEqual(result);
  });
  it("creates with a preselected task ID and complete manual without inventing a Project", async () => {
    const createTask = vi.fn(async () => result) as unknown as AssistantTaskClient["createTask"];
    const f = fixture({ createTask });
    expect((await f.run(["create", "--name", "守护", "--purpose=", "--scope", "Tasks", "--body", "Read before acting.", "--operation-id", op, "--json"])).exit).toBe(0);
    expect(createTask).toHaveBeenCalledExactlyOnceWith({ id: op, name: "守护", purpose: "", scope: "Tasks", kind: "continuous", takeover: "manual", manual: { body: "Read before acting.", rules: {} } });
  });
  it("preserves exact supplied versions and explicit empty fields on update", async () => {
    const updateTask = vi.fn(async () => result) as unknown as AssistantTaskClient["updateTask"];
    const f = fixture({ updateTask });
    expect((await f.run(["update", task, "--if-version", version, "--purpose=", "--trigger", "null", "--json"])).exit).toBe(0);
    expect(updateTask).toHaveBeenCalledExactlyOnceWith(task, { ifVersion: version, purpose: "", trigger: null });
  });
  it.each([false, true])("preserves appendix references unless explicitly clearing them (%s)", async clear => {
    const updateAppendix = vi.fn(async () => result) as unknown as AssistantTaskClient["updateAppendix"];
    const f = fixture({ updateAppendix });
    const response = await f.run(["appendix", "update", task, resource, "--if-version", version, "--text", "Replacement", ...(clear ? ["--clear-source-records"] : [])]);
    expect(response.exit).toBe(0);
    expect(updateAppendix).toHaveBeenCalledExactlyOnceWith(task, resource, { ifVersion: version, text: "Replacement", ...(clear ? { sourceRecords: [] } : {}) });
  });
  it.each([
    [[], {}],
    [["--scope-category", "build", "--scope-category", "deploy"], { scope: { projectIds: [], eventTypes: [], itemCategories: ["build", "deploy"] } }],
    [["--clear-scope"], { scope: { projectIds: [], eventTypes: [], itemCategories: [] } }],
  ] as const)("replaces the appendix scope only when declared: %j", async (args, expected) => {
    const updateAppendix = vi.fn(async () => result) as unknown as AssistantTaskClient["updateAppendix"];
    const f = fixture({ updateAppendix });
    expect((await f.run(["appendix", "update", task, resource, "--if-version", version, "--text", "Replacement", ...args])).exit).toBe(0);
    expect(updateAppendix).toHaveBeenCalledExactlyOnceWith(task, resource, { ifVersion: version, text: "Replacement", ...expected });
  });
  it.each([
    ["update", task, resource, "--if-version", version, "--text", "Replacement", "--scope-category", "build", "--clear-scope"],
    ["update", task, resource, "--if-version", version, "--text", "Replacement", "--scope-project", "NOT-A-UUID"],
    ["add", task, "--text", "Text", "--clear-scope"],
  ])("refuses an inconsistent appendix scope before network: %j", async (...args) => {
    const f = fixture();
    expect((await f.run(["appendix", ...args])).exit).toBe(2);
    expect(f.runServerCommand).not.toHaveBeenCalled();
  });
  it("shows appendix scope and validation counts in list output", async () => {
    const page = { items: [{ ...result, scope: { projectIds: [], eventTypes: ["report"], itemCategories: [] }, validation: { successCount: "3", failureCount: "1", lastValidatedAt: "2026-11-13T10:00:00Z" } }], nextCursor: null, observedAt: "2026-11-13T10:00:00Z" };
    const listAppendix = vi.fn(async () => page) as unknown as AssistantTaskClient["listAppendix"];
    const response = await fixture({ listAppendix }).run(["appendix", "list", task]);
    expect(response.exit).toBe(0);
    for (const text of ['"eventTypes": [', '"report"', '"successCount": "3"', '"failureCount": "1"']) expect(response.out).toContain(text);
  });
  it("submits edited proposal text and rules only with the explicit decision", async () => {
    const decide = vi.fn(async () => result) as unknown as AssistantTaskClient["decide"];
    const f = fixture({ decide });
    expect((await f.run(["proposal", "decide", task, resource, "--if-version", version, "--decision", "edited", "--body", "Revised", "--rules", "{}", "--json"])).exit).toBe(0);
    expect(decide).toHaveBeenCalledExactlyOnceWith(task, resource, { ifVersion: version, decision: "edited", body: "Revised", rules: {} });
  });
  it("escapes terminal controls in text resources", async () => {
    const getTask = vi.fn(async () => result) as unknown as AssistantTaskClient["getTask"];
    const response = await fixture({ getTask }).run(["show", task]);
    expect(response.exit).toBe(0);
    expect(response.out).not.toContain("\u001b");
    expect(response.out).toContain("Complete");
  });
});

describe("assistant-task Bot work and recovery", () => {
  const env = { DAYNIGHT_BOT_ID: bot, DAYNIGHT_BOT_STATE_DIR: "/private/bot" };
  it("passes the observed claim decision and original identity to durable claim handling", async () => {
    const f = fixture({}, env);
    expect((await f.run(["claim", task, "--if-version", version, "--expected-generation", "0", "--operation-id", op, "--json"])).exit).toBe(0);
    expect(f.runClaimOperation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ serverOrigin: "https://daynight.test", ownerUserId: owner, botId: bot, stateDirectory: "/private/bot", taskId: task, kind: "claim", operationId: op, ifVersion: version, expectedGeneration: "0" }));
  });
  it("reads the original claim operation without sending a new mutation", async () => {
    const f = fixture({}, env);
    expect((await f.run(["claim-operation", "show", task, op, "--json"])).exit).toBe(0);
    expect(f.recoverClaimOperation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ taskId: task, operationId: op }));
    expect(f.runClaimOperation).not.toHaveBeenCalled();
  });
  it("loads private credentials for appendices and preserves repeated evidence references", async () => {
    const addAppendix = vi.fn(async () => result) as unknown as AssistantTaskClient["addAppendix"];
    const f = fixture({ addAppendix }, env);
    const response = await f.run(["appendix", "add", task, "--text", "Read the original operation.", "--source-record", resource, "--source-record", target, "--operation-id", op, "--json"]);
    expect(response.exit).toBe(0);
    expect(addAppendix).toHaveBeenCalledExactlyOnceWith(task, { ...credential, id: op, text: "Read the original operation.", sourceRecords: [resource, target] });
    expect(f.readClaimCredential).toHaveBeenCalledOnce();
    expect(response.out + response.err).not.toContain(credential.claimToken);
  });
  it("sends a declared appendix scope with the addition", async () => {
    const addAppendix = vi.fn(async () => result) as unknown as AssistantTaskClient["addAppendix"];
    const f = fixture({ addAppendix }, env);
    expect((await f.run(["appendix", "add", task, "--text", "Restart", "--scope-project", target, "--scope-event-type", "report", "--scope-event-type", "escalation", "--operation-id", op])).exit).toBe(0);
    expect(addAppendix).toHaveBeenCalledExactlyOnceWith(task, { ...credential, id: op, text: "Restart", sourceRecords: [], scope: { projectIds: [target], eventTypes: ["report", "escalation"], itemCategories: [] } });
  });
  it("validates an appendix with an outcome record under the holder credential", async () => {
    const validated = { ...result, validation: { successCount: "1", failureCount: "0", lastValidatedAt: "2026-11-13T10:00:00Z" } };
    const validateAppendix = vi.fn(async () => validated) as unknown as AssistantTaskClient["validateAppendix"];
    const f = fixture({ validateAppendix }, env);
    const response = await f.run(["appendix", "validate", task, resource, "--outcome-record", target, "--operation-id", op, "--json"]);
    expect(response.exit).toBe(0);
    expect(validateAppendix).toHaveBeenCalledExactlyOnceWith(task, resource, { ...credential, outcomeRecordId: target });
    expect(JSON.parse(response.out)).toEqual(validated);
    expect(response.out + response.err).not.toContain(credential.claimToken);
  });
  it("refuses appendix validation without Bot identity or a canonical outcome record", async () => {
    for (const [args, environment] of [[["--outcome-record", target], {}], [["--outcome-record", "bad"], env], [[], env]] as const) {
      const f = fixture({}, environment);
      expect((await f.run(["appendix", "validate", task, resource, ...args])).exit).toBe(2);
      expect(f.runServerCommand).not.toHaveBeenCalled();
    }
  });
  it("reports a refused duplicate validation without retrying", async () => {
    const validateAppendix = vi.fn(async () => { throw new AssistantTaskApiError(false, "operation_conflict", 409, true); }) as unknown as AssistantTaskClient["validateAppendix"];
    const f = fixture({ validateAppendix }, env);
    const response = await f.run(["appendix", "validate", task, resource, "--outcome-record", target, "--operation-id", op, "--json"]);
    expect(response.exit).toBe(1);
    expect(JSON.parse(response.err).error).toMatchObject({ code: "operation_conflict", status: 409, outcomeUnconfirmed: false });
    expect(validateAppendix).toHaveBeenCalledOnce();
  });
  it("allows another Bot to append a note without stealing the holder credential", async () => {
    const getTask = vi.fn(async () => ({ holderBotId: target })) as unknown as AssistantTaskClient["getTask"];
    const addRecord = vi.fn(async () => result) as unknown as AssistantTaskClient["addRecord"];
    const f = fixture({ getTask, addRecord }, env);
    expect((await f.run(["record", "add", task, "--kind", "note", "--text", "I observed this", "--operation-id", op])).exit).toBe(0);
    expect(addRecord).toHaveBeenCalledExactlyOnceWith(task, { id: op, kind: "note", text: "I observed this" });
    expect(f.readClaimCredential).not.toHaveBeenCalled();
  });
  it("appends an outcome record with its evaluated action under the holder credential", async () => {
    const getTask = vi.fn(async () => ({ holderBotId: bot })) as unknown as AssistantTaskClient["getTask"];
    const stored = { id: op, taskId: task, kind: "outcome", text: "Retry cleared it", outcome: "inconclusive", actionRecordId: resource };
    const addRecord = vi.fn(async () => stored) as unknown as AssistantTaskClient["addRecord"];
    const f = fixture({ getTask, addRecord }, env);
    const response = await f.run(["record", "add", task, "--kind", "outcome", "--outcome", "inconclusive", "--action-record", resource, "--text", "Retry cleared it", "--refs", `{"recordIds":["${target}"]}`, "--operation-id", op, "--json"]);
    expect(response.exit).toBe(0);
    expect(addRecord).toHaveBeenCalledExactlyOnceWith(task, { ...credential, id: op, kind: "outcome", text: "Retry cleared it", outcome: "inconclusive", actionRecordId: resource, refs: { recordIds: [target] } });
    expect(JSON.parse(response.out)).toEqual(stored);
  });
  it("does not let another Bot append an outcome record", async () => {
    const getTask = vi.fn(async () => ({ holderBotId: target })) as unknown as AssistantTaskClient["getTask"];
    const addRecord = vi.fn(async () => result) as unknown as AssistantTaskClient["addRecord"];
    const f = fixture({ getTask, addRecord }, env);
    const response = await f.run(["record", "add", task, "--kind", "outcome", "--outcome", "effective", "--action-record", resource, "--text", "Done", "--operation-id", op, "--json"]);
    expect(response.exit).toBe(1);
    expect(JSON.parse(response.err).error.message).toContain("Only the responsible Bot");
    expect(addRecord).not.toHaveBeenCalled();
  });
  it.each([
    ["--kind", "outcome", "--text", "Done"],
    ["--kind", "outcome", "--outcome", "effective", "--text", "Done"],
    ["--kind", "outcome", "--action-record", resource, "--text", "Done"],
    ["--kind", "outcome", "--outcome", "resolved", "--action-record", resource, "--text", "Done"],
    ["--kind", "outcome", "--outcome", "effective", "--action-record", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", "--text", "Done"],
    ["--kind", "action", "--outcome", "effective", "--text", "Done"],
    ["--kind", "note", "--action-record", resource, "--text", "Done"],
  ])("refuses an inconsistent outcome evaluation before network: %j", async (...args) => {
    const f = fixture({}, env);
    expect((await f.run(["record", "add", task, ...args])).exit).toBe(2);
    expect(f.runServerCommand).not.toHaveBeenCalled();
  });
  it("shows outcome evaluations in record text output", async () => {
    const page = { items: [{ id: op, taskId: task, kind: "outcome", text: "Retry cleared it", outcome: "effective", actionRecordId: resource }], nextCursor: null, observedAt: "2026-11-13T10:00:00Z" };
    const listRecords = vi.fn(async () => page) as unknown as AssistantTaskClient["listRecords"];
    const response = await fixture({ listRecords }, env).run(["record", "list", task]);
    expect(response.exit).toBe(0);
    expect(response.out).toContain('"outcome": "effective"');
    expect(response.out).toContain(`"actionRecordId": "${resource}"`);
  });
  it("uses holder credentials even for a note", async () => {
    const getTask = vi.fn(async () => ({ holderBotId: bot })) as unknown as AssistantTaskClient["getTask"];
    const addRecord = vi.fn(async () => result) as unknown as AssistantTaskClient["addRecord"];
    const f = fixture({ getTask, addRecord }, env);
    expect((await f.run(["record", "add", task, "--kind", "note", "--text", "Observation", "--operation-id", op])).exit).toBe(0);
    expect(addRecord).toHaveBeenCalledWith(task, expect.objectContaining(credential));
  });
  it("asks without needing the target Bot's private credential", async () => {
    const ask = vi.fn(async () => result) as unknown as AssistantTaskClient["ask"];
    const f = fixture({ ask }, env);
    expect((await f.run(["ask", task, "--item", resource, "--question", "What is the status?", "--operation-id", op])).exit).toBe(0);
    expect(ask).toHaveBeenCalledExactlyOnceWith(task, { id: op, itemId: resource, question: "What is the status?" });
    expect(f.readClaimCredential).not.toHaveBeenCalled();
  });
  it("retains the original operation ID after an unknown write and never retries", async () => {
    const ask = vi.fn(async () => { throw new AssistantTaskApiError(true, "write_outcome_unknown", 503); });
    const f = fixture({ ask }, env);
    const response = await f.run(["ask", task, "--question", "Status?", "--operation-id", op, "--json"]);
    expect(response.exit).toBe(1);
    expect(response.out).toBe("");
    expect(JSON.parse(response.err).error).toMatchObject({ taskId: task, operationId: op, code: "write_outcome_unknown", outcomeUnconfirmed: true, reconcile: `daynight assistant-task show ${task} --json` });
    expect(ask).toHaveBeenCalledOnce();
  });
  it("does not leak request-body secrets from an unexpected dependency failure", async () => {
    const ask = vi.fn(async () => { throw new Error("PRIVATE-PAT PRIVATE-TOKEN"); });
    const f = fixture({ ask }, env);
    const response = await f.run(["ask", task, "--question", "Status?", "--json"]);
    expect(response.exit).toBe(1);
    expect(response.out + response.err).not.toContain("PRIVATE-");
    expect(ask).toHaveBeenCalledOnce();
  });
});
