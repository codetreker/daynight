import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, ApiError } from "../../../src/api/index.js";
import type { Project } from "../../../src/api/types.js";
import { runCli } from "../../../src/cli/application.js";
import type { CliContext } from "../../../src/cli/context.js";
import { PublicDiagnosticError, formatError } from "../../../src/platform/diagnostics.js";
import { runTaskCommand } from "../../../src/commands/task/command.js";
import type { TaskCommandDependencies } from "../../../src/commands/task/command.js";
import { ThreadCommandError } from "../../../src/commands/task/thread-diagnostics.js";

const projectId = "aaaaaaaa-1111-4111-8111-111111111111";
const taskId = "bbbbbbbb-2222-4222-8222-222222222222";
const userId = "cccccccc-3333-4333-8333-333333333333";
const messageId = "dddddddd-4444-4444-8444-444444444444";
const replyTo = "eeeeeeee-5555-4555-8555-555555555555";
const message = { id: messageId, author: { userId, displayName: "Alice", Agent: false }, body: "  body\n\t ", createdAt: "2026-11-03T10:20:30.000Z" };
const disposals: (() => void)[] = [];
afterEach(() => { disposals.splice(0).forEach((dispose) => dispose()); });
const fixture = () => {
  const operation = createOperation(); disposals.push(() => operation.dispose());
  const stdout = vi.fn<(text: string) => void>();
  const context = {
    version: "0.0.0", packageDirectory: "unused", homeDirectory: vi.fn(() => { throw new Error("Unexpected config read"); }), workingDirectory: vi.fn(() => "caller"),
    stdout, stderr: vi.fn<(text: string) => void>(), stdoutBytes: vi.fn(async (chunk: Uint8Array) => { stdout(Buffer.from(chunk).toString("utf8")); }),
  } satisfies CliContext;
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ items: [message], hasMoreBefore: true, hasMoreAfter: false }), { headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } }));
  const api = createApiClient({ serverUrl: "http://localhost:8787", operation, fetch });
  const dependencies = {
    resolveProject: vi.fn<TaskCommandDependencies["resolveProject"]>().mockResolvedValue({ id: projectId } as Project),
    runServerCommand: vi.fn<TaskCommandDependencies["runServerCommand"]>(async (current, command) => {
      const output = await command({ api, operation, serverUrl: "http://localhost:8787" });
      if (typeof output === "string") { operation.check(); current.stdout(output); }
      else if (output !== undefined) current.stdout(output.output);
    }),
  };
  return { context, dependencies, fetch, operation };
};

describe("Thread command boundaries", () => {
  it.each([["thread"], ["thread", "--help"], ["thread", "read", "--help"], ["thread", "post", "--help"]].map((args) => ({ args })))("discovers $args without I/O", async ({ args }) => {
    const f = fixture();
    await runTaskCommand(args, f.context, f.dependencies);
    expect(f.context.stdout).toHaveBeenCalledOnce();
    expect(f.context.stdout.mock.calls[0]![0]).toContain("Usage: daynight task thread");
    expect(f.dependencies.runServerCommand).not.toHaveBeenCalled();
    expect(f.context.homeDirectory).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["read", "invalid"], ["read", taskId, "--project=bad"], ["read", taskId, "--before-id=bad"],
    ["read", taskId, `--before-id=${messageId}`, `--after-id=${replyTo}`],
    ...["0", "101", "-1", "1.1", "1e1", " 2", "NaN", "Infinity", "999999999999999999999999999"].map((count) => ["read", taskId, `--count=${count}`]),
    ["post", taskId, "--body= \n\t"], ["post", taskId, "--body=\0"], ["post", taskId, "--body=\ud800"], ["post", taskId, `--body=${"x".repeat(65537)}`],
    ["post", taskId, "--body=body", "--reply-to=bad"], ["post", taskId, "--body=body", "--claim-id=bad"],
  ].map((args) => ({ args })))("rejects semantic input before all business I/O %#", async ({ args }) => {
    const f = fixture();
    await expect(runTaskCommand(["thread", ...args], f.context, f.dependencies)).rejects.toMatchObject({ exitCode: 2 });
    expect(f.dependencies.runServerCommand).not.toHaveBeenCalled(); expect(f.dependencies.resolveProject).not.toHaveBeenCalled();
    expect(f.context.homeDirectory).not.toHaveBeenCalled(); expect(f.context.workingDirectory).not.toHaveBeenCalled();
    expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown-Markdown-secret"], ["read", taskId, "--json"], ["read", taskId, "--details=false"],
    ["read", taskId, "--count=2", "--count=3"], ["read", taskId, "secret-Markdown"], ["post", taskId], ["post", taskId, "--body=body", "--operation-id=secret-Markdown"],
  ].map((args) => ({ args })))("sanitizes actual Thread grammar errors at the application exit %#", async ({ args }) => {
    const f = fixture();
    const code = await runCli(["task", "thread", ...args], f.context);
    expect(code).toBe(2); expect(f.context.stdout).not.toHaveBeenCalled();
    expect(f.context.stderr.mock.calls[0]![0]).toMatch(/^Invalid Thread command arguments\./);
    expect(f.context.stderr.mock.calls[0]![0]).not.toMatch(/secret|Markdown/);
    expect(f.context.homeDirectory).not.toHaveBeenCalled();
  });

  it("preserves grammar diagnostics outside Thread even when an argument says thread", async () => {
    const f = fixture();
    expect(await runCli(["task", "list", "--thread-Markdown"], f.context)).toBe(2);
    expect(f.context.stderr.mock.calls[0]![0]).toContain("--thread-Markdown");
    expect(f.context.stderr.mock.calls[0]![0]).not.toContain("Invalid Thread command arguments");
  });

  it("uses one explicit-project GET with default count20 and no discovery", async () => {
    const f = fixture();
    await runTaskCommand(["thread", "read", taskId.toUpperCase(), `--project=${projectId.toUpperCase()}`], f.context, f.dependencies);
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(String(f.fetch.mock.calls[0]![0])).toBe(`http://localhost:8787/api/v1/projects/${projectId}/tasks/${taskId}/thread/messages?count=20&details=false`);
    expect(f.dependencies.resolveProject).not.toHaveBeenCalled(); expect(f.context.workingDirectory).not.toHaveBeenCalled();
    expect(f.context.stdout.mock.calls[0]![0]).toContain(`Id: ${messageId}`);
    expect(f.context.stdout.mock.calls[0]![0]).toContain("... Has more messages before");
  });

  it("uses the existing binding for implicit projects and sends details/count/boundary", async () => {
    const f = fixture();
    await runTaskCommand(["thread", "read", taskId, `--after-id=${replyTo.toUpperCase()}`, "--count=100", "--details"], f.context, f.dependencies);
    expect(f.dependencies.resolveProject).toHaveBeenCalledOnce(); expect(f.context.workingDirectory).toHaveBeenCalledOnce();
    const url = new URL(String(f.fetch.mock.calls[0]![0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({ afterId: replyTo, count: "100", details: "true" });
  });

  it("posts raw whitespace and explicit claim/reply before the done-only claim guard", async () => {
    const f = fixture();
    f.fetch.mockResolvedValue(new Response(JSON.stringify({ ...message, replyTo, author: { ...message.author, Agent: true } }), { status: 201, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } }));
    await runTaskCommand(["thread", "post", taskId, `--project=${projectId}`, `--body=${message.body}`, `--reply-to=${replyTo}`, `--claim-id=${replyTo}`], f.context, f.dependencies);
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(f.fetch.mock.calls[0]![1]!.body as string)).toEqual({ body: message.body, replyTo, claimId: replyTo });
    expect(f.context.stdout).toHaveBeenCalledExactlyOnceWith(`Message posted.\nId: ${messageId}\nReplyTo: ${replyTo}\n`);
    expect(f.context.stdout.mock.calls[0]![0]).not.toContain(message.body);
  });

  it("contains untrusted server message and nested cleanup causes behind safe diagnostics", async () => {
    const api = new ApiError({ operation: "task.thread.post", projectId, taskId }, "request", { cause: new Error("secret Markdown body"), outcomeUnconfirmed: true });
    const original = new AggregateError([api, new Error("secret cleanup")], "secret aggregate");
    const error = new ThreadCommandError(original, "post", "request", projectId, taskId);
    expect(error.cause).toBe(original);
    expect(formatError(error)).toContain("The posting outcome is unknown.");
    expect(formatError(error)).not.toContain("secret");
  });

  it("awaits read output failures without exposing stream diagnostics or marking a page consumed", async () => {
    const f = fixture(), failure = new Error("private asynchronous output failure");
    f.context.stdoutBytes.mockRejectedValue(failure);
    const error = await runTaskCommand(["thread", "read", taskId, `--project=${projectId}`], f.context, f.dependencies).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PublicDiagnosticError);
    expect((error as Error).cause).toBe(failure);
    expect(formatError(error)).toContain("phase=output");
    expect(formatError(error)).not.toContain("private");
    expect(f.context.stdout).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("keeps preparation diagnostics safe while preserving the original cause", async () => {
    const f = fixture(), original = new Error("secret configuration/PAT/body");
    f.dependencies.runServerCommand.mockRejectedValue(original);
    const error = await runTaskCommand(["thread", "post", taskId, `--project=${projectId}`, "--body=body"], f.context, f.dependencies).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PublicDiagnosticError); expect((error as Error).cause).toBe(original);
    expect(formatError(error)).not.toContain("secret"); expect(f.context.stdout).not.toHaveBeenCalled();
  });
});
