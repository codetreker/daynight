import { expect, it, vi } from "vitest";
import { createApiClient, createOperation, parseApiJson, stringifyApiJson } from "../../../src/api/index.js";
import { runCli } from "../../../src/cli/application.js";
import type { CliContext } from "../../../src/cli/context.js";
import { runTaskCommand, type TaskCommandDependencies } from "../../../src/commands/task/command.js";

const projectId = "aaaaaaaa-1111-4111-8111-111111111111";
const taskId = "bbbbbbbb-2222-4222-8222-222222222222";
const userId = "cccccccc-3333-4333-8333-333333333333";
const claimId = "dddddddd-4444-4444-8444-444444444444";
const workerId = "eeeeeeee-5555-4555-8555-555555555555";
const messageId = "ffffffff-6666-4666-8666-666666666666";
const taskPath = `/api/v1/projects/${projectId}/tasks/${taskId}`;
const time = "2026-11-03T10:11:12.123Z";

const fixture = (fetch: typeof globalThis.fetch) => {
  const operation = createOperation();
  const api = createApiClient({ serverUrl: "http://localhost:8787", serverToken: "fixture-token", expectedUserId: userId, operation, fetch });
  const context = { version: "0", packageDirectory: "unused", homeDirectory: () => { throw new Error("Unexpected config read"); }, workingDirectory: () => { throw new Error("Unexpected repository read"); }, stdout: vi.fn<(text: string) => void>(), stderr: vi.fn<(text: string) => void>(), stdoutBytes: vi.fn(async (_value: Uint8Array) => {}) } satisfies CliContext;
  const dependencies: TaskCommandDependencies = {
    resolveProject: vi.fn(),
    runServerCommand: async (current, command) => {
      const output = await command({ api, operation, serverUrl: "http://localhost:8787", serverConfiguration: { serverUrl: "http://localhost:8787" } });
      operation.check();
      if (typeof output === "string") current.stdout(output); else if (output !== undefined) await current.stdoutBytes(Buffer.from(output.output), operation.signal);
    },
  };
  const run = (args: string[]) => runCli(["task", "thread", ...args, "--project", projectId], context, [{ name: "task", description: "Manage tasks", load: async () => ({ run: (rest, current) => runTaskCommand(rest, current, dependencies) }) }]);
  return { api, context, operation, run };
};

it.each([
  { code: "claim_conflict", status: 409, args: ["post", taskId, "--body", "private message", "--claim-id", claimId], method: "POST" },
  { code: "payload_too_large", status: 413, args: ["post", taskId, "--body", "private message"], method: "POST" },
  { code: "message_not_found", status: 404, args: ["read", taskId, "--after-id", messageId], method: "GET" },
  { code: "message_not_found", status: 404, args: ["post", taskId, "--body", "private message", "--reply-to", messageId], method: "POST" },
  ...["read", "post"].flatMap(action => ["forbidden", "task_deleted"].map(code => ({ code, status: code === "forbidden" ? 403 : 410, args: action === "read" ? ["read", taskId] : ["post", taskId, "--body", "private message"], method: action === "read" ? "GET" : "POST" }))),
])("reports $method $code without replay or private diagnostics", async ({ code, status, args, method }) => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(stringifyApiJson({ error: { code, message: "private failure body", requestId: "fixture-refusal" } }), { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } }));
  const f = fixture(fetch);
  try {
    expect(await f.run(args)).toBe(1);
    expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.context.stdoutBytes).not.toHaveBeenCalled();
    const diagnostic = f.context.stderr.mock.calls.map(([text]) => text).join("");
    expect(diagnostic).toContain(`code=${code}`); expect(diagnostic).toContain("requestId=fixture-refusal");
    expect(diagnostic).not.toMatch(/private|fixture-token|Bearer |Caused by:|\{"error"/);
    expect(fetch).toHaveBeenCalledOnce();
    expect(new URL(String(fetch.mock.calls[0]![0])).pathname).toBe(`${taskPath}/thread/messages`);
    expect(fetch.mock.calls[0]![1]!.method).toBe(method);
  } finally { f.operation.dispose(); }
});

it.each(["0", "101", "1.5"])("rejects Thread count %s without a cause or request", async count => {
  const fetch = vi.fn<typeof globalThis.fetch>(); const f = fixture(fetch);
  try {
    expect(await f.run(["read", taskId, `--count=${count}`])).toBe(2);
    expect(fetch).not.toHaveBeenCalled(); expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.context.stdoutBytes).not.toHaveBeenCalled();
    expect(f.context.stderr).toHaveBeenCalledOnce();
    const diagnostic = f.context.stderr.mock.calls.map(([text]) => text).join("");
    expect(diagnostic).toContain("--count must be a decimal integer from 1 to 100.");
    expect(diagnostic).not.toContain("Caused by:");
  } finally { f.operation.dispose(); }
});

it("preserves returned message execution details after releasing its claim", async () => {
  const execution = { claimId, workerId, provider: "codex" };
  const page = { items: [{ id: messageId, author: { userId, displayName: null, Agent: true, execution }, createdAt: time, body: "Agent message" }], hasMoreBefore: false, hasMoreAfter: false };
  const released = { type: "task", parentId: null, id: taskId, projectId, title: "Task", description: "", tags: [], properties: {}, status: "todo", ready: true, allowAgents: true, assignedTo: null, requiredPlatform: null, version: 2n, startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time, dependsOn: [], externalDependsOn: [], blockedBy: [] };
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const value = url.pathname.endsWith("/worker-claim/release") ? released : page;
    return new Response(stringifyApiJson(value), { headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } });
  });
  const f = fixture(fetch);
  try {
    expect(await f.run(["read", taskId, "--details"])).toBe(0);
    await expect(f.api.releaseWorkerClaim(projectId, taskId, { version: 1n, claimId, stoppedConfirmed: true })).resolves.toEqual(released);
    expect(await f.run(["read", taskId, "--details"])).toBe(0);
    const outputs = f.context.stdoutBytes.mock.calls.map(([bytes]) => Buffer.from(bytes).toString("utf8"));
    expect(outputs).toHaveLength(2); expect(outputs[1]).toBe(outputs[0]);
    for (const output of outputs) for (const value of [`Id: ${messageId}\n`, `Execution ClaimId: ${claimId}\n`, `Execution WorkerId: ${workerId}\n`, "Execution Provider: codex\n"]) expect(output).toContain(value);
    expect(fetch.mock.calls.map(([input, init]) => [init!.method, new URL(String(input)).pathname])).toEqual([
      ["GET", `${taskPath}/thread/messages`], ["POST", `${taskPath}/worker-claim/release`], ["GET", `${taskPath}/thread/messages`],
    ]);
    expect(parseApiJson(String(fetch.mock.calls[1]![1]!.body))).toEqual({ version: 1n, claimId, stoppedConfirmed: true });
    expect(fetch.mock.calls.filter(([input]) => new URL(String(input)).pathname.endsWith("/thread/messages")).every(([input]) => new URL(String(input)).searchParams.get("details") === "true")).toBe(true);
    expect(f.context.stderr).not.toHaveBeenCalled();
  } finally { f.operation.dispose(); }
});
