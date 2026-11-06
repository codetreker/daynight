import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient, createOperation, stringifyApiJson } from "../../../src/api/index.js";
import type { Project } from "../../../src/api/index.js";
import { runCli } from "../../../src/cli/application.js";
import type { CliContext } from "../../../src/cli/context.js";
import { runTaskCommand } from "../../../src/commands/task/command.js";
import type { TaskCommandDependencies } from "../../../src/commands/task/command.js";

const projectId = "aaaaaaaa-1111-4111-8111-111111111111";
const taskId = "bbbbbbbb-2222-4222-8222-222222222222";
const userId = "cccccccc-3333-4333-8333-333333333333";
const time = "2026-11-03T10:11:12Z";
const project: Project = { id: projectId, name: "Project", repoUrl: "git@example.test:org/repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId: userId, version: 1n }, createdAt: time, updatedAt: time };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const fixture = (status: number, code: string) => {
  const operation = createOperation(); cleanups.push(() => operation.dispose());
  const context = { version: "0", packageDirectory: "unused", homeDirectory: () => { throw new Error("Unexpected config read"); }, workingDirectory: () => { throw new Error("Unexpected repository read"); }, stdout: vi.fn<(text: string) => void>(), stderr: vi.fn<(text: string) => void>(), stdoutBytes: vi.fn(async (_bytes: Uint8Array) => {}) } satisfies CliContext;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(String(input));
    const value = url.pathname === `/api/v1/projects/${projectId}` ? project : { error: { code, message: "private failure body", requestId: "fixture-request" } };
    return new Response(stringifyApiJson(value), { status: value === project ? 200 : status, headers: { "content-type": "application/json", "Daynight-User-ID": userId, "X-Request-ID": "fixture-request" } });
  });
  const api = createApiClient({ serverUrl: "http://localhost:8787", serverToken: "fixture-token", operation, fetch });
  const dependencies = {
    resolveProject: vi.fn<TaskCommandDependencies["resolveProject"]>(),
    runServerCommand: vi.fn<TaskCommandDependencies["runServerCommand"]>(async (current, command) => {
      const output = await command({ api, operation, serverUrl: "http://localhost:8787", serverConfiguration: { serverUrl: "http://localhost:8787" } });
      operation.check();
      if (typeof output === "string") current.stdout(output); else if (output !== undefined) current.stdout(output.output);
    }),
  };
  const run = (args: string[]) => runCli(["task", ...args], context, [{ name: "task", description: "Manage tasks", load: async () => ({ run: (rest, current) => runTaskCommand(rest, current, dependencies) }) }]);
  return { context, fetch, run };
};

it.each([{ status: 503, code: "clock_not_advanced", unknown: false }, { status: 500, code: "internal_error", unknown: true }])("retains Thread $code status and request correlation without replay or private diagnostics", async ({ status, code, unknown }) => {
  const f = fixture(status, code);
  expect(await f.run(["thread", "post", taskId, "--body", "private message", "--project", projectId])).toBe(1);
  expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.context.stdoutBytes).not.toHaveBeenCalled();
  const diagnostic = f.context.stderr.mock.calls.map(([text]) => text).join("");
  expect(diagnostic).toContain(`status=${status}`); expect(diagnostic).toContain(`code=${code}`); expect(diagnostic).toContain("requestId=fixture-request");
  expect(diagnostic.includes("outcome is unknown")).toBe(unknown);
  expect(diagnostic).not.toMatch(/private|fixture-token|Bearer |Caused by:|\{"error"/);
  expect(f.fetch).toHaveBeenCalledOnce(); expect(f.fetch.mock.calls[0]![1]!.method).toBe("POST");
});

it.each([{ action: "read", status: 404, code: "not_found" }, { action: "remove", status: 404, code: "not_found" }, { action: "read", status: 500, code: "internal_error" }, { action: "put", status: 409, code: "path_conflict" }])("reports attachment $action $code with request correlation and no replay", async ({ action, status, code }) => {
  const f = fixture(status, code);
  let args: string[];
  if (action === "put") {
    const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp/attachment-refusal"); await mkdir(scratch, { recursive: true });
    const directory = await mkdtemp(path.join(scratch, "source-")); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const source = path.join(directory, "source.bin"); await writeFile(source, Buffer.from([0, 255]));
    args = ["attachment", "put", taskId, source, "--path", "assets"];
  } else args = ["attachment", action, taskId, "assets/data.bin"];
  expect(await f.run([...args, "--project", projectId])).toBe(1);
  expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.context.stdoutBytes).not.toHaveBeenCalled();
  const diagnostic = f.context.stderr.mock.calls.map(([text]) => text).join("");
  expect(diagnostic).toContain(code); expect(diagnostic).toContain("requestId=fixture-request");
  expect(f.fetch.mock.calls.map(([, options]) => options!.method)).toEqual(["GET", action === "put" ? "PUT" : action === "remove" ? "DELETE" : "GET"]);
  expect(f.fetch.mock.calls.every(([, options]) => new Headers(options!.headers).get("Authorization") === "Bearer fixture-token")).toBe(true);
});

it("does not skip an unseen message after receiving a later post receipt", async () => {
  const operation = createOperation(); cleanups.push(() => operation.dispose());
  const anchor = "dddddddd-1111-4111-8111-111111111111", unseen = "eeeeeeee-2222-4222-8222-222222222222", posted = "ffffffff-3333-4333-8333-333333333333";
  const message = (id: string, body: string) => ({ id, author: { userId, displayName: null, Agent: false }, createdAt: "2026-11-03T10:11:12.123Z", body });
  const fetch = vi.fn<typeof globalThis.fetch>(async (_input, options) => {
    const value = options!.method === "POST" ? message(posted, "My later post") : { items: [message(unseen, "Previously unseen"), message(posted, "My later post")], hasMoreBefore: true, hasMoreAfter: false };
    return new Response(stringifyApiJson(value), { status: options!.method === "POST" ? 201 : 200, headers: { "content-type": "application/json", "Daynight-User-ID": userId } });
  });
  const api = createApiClient({ serverUrl: "http://localhost:8787", operation, fetch });
  const context = { version: "0", packageDirectory: "unused", homeDirectory: () => { throw new Error("Unexpected config read"); }, workingDirectory: () => { throw new Error("Unexpected repository read"); }, stdout: vi.fn<(text: string) => void>(), stderr: vi.fn<(text: string) => void>(), stdoutBytes: vi.fn(async (_bytes: Uint8Array) => {}) } satisfies CliContext;
  const dependencies = {
    resolveProject: vi.fn<TaskCommandDependencies["resolveProject"]>(),
    runServerCommand: vi.fn<TaskCommandDependencies["runServerCommand"]>(async (current, command) => {
      const output = await command({ api, operation, serverUrl: "http://localhost:8787", serverConfiguration: { serverUrl: "http://localhost:8787" } });
      operation.check(); if (typeof output === "string") current.stdout(output); else if (output !== undefined) current.stdout(output.output);
    }),
  };
  await runTaskCommand(["thread", "post", taskId, "--body", "My later post", "--project", projectId], context, dependencies);
  expect(context.stdout).toHaveBeenCalledExactlyOnceWith(`Message posted.\nId: ${posted}\n`);
  await runTaskCommand(["thread", "read", taskId, "--after-id", anchor, "--project", projectId], context, dependencies);
  expect(fetch.mock.calls.map(([, options]) => options!.method)).toEqual(["POST", "GET"]);
  expect(new URL(String(fetch.mock.calls[1]![0])).searchParams.get("afterId")).toBe(anchor);
  expect(context.stdoutBytes).toHaveBeenCalledOnce();
  const output = Buffer.from(context.stdoutBytes.mock.calls[0]![0]).toString("utf8");
  expect(output.indexOf(`Id: ${unseen}\n`)).toBeGreaterThanOrEqual(0);
  expect(output.indexOf(`Id: ${posted}\n`)).toBeGreaterThan(output.indexOf(`Id: ${unseen}\n`));
});

it("rejects an invalid Thread count as usage before any request", async () => {
  const f = fixture(500, "internal_error");
  expect(await f.run(["thread", "read", taskId, "--count", "0", "--project", projectId])).toBe(2);
  expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.context.stdoutBytes).not.toHaveBeenCalled();
  expect(f.context.stderr).toHaveBeenCalledOnce(); expect(f.fetch).not.toHaveBeenCalled();
});

it("prints every paginated attachment in JSON, text and tree with duplicate basenames", async () => {
  const operation = createOperation(); cleanups.push(() => operation.dispose());
  const metadata = (value: string) => ({ path: value, contentType: "text/plain", sizeBytes: 2, createdAt: time, updatedAt: time });
  const items = [metadata("other/design.md"), metadata("文档 space/设计 ?# %2F/design.md")];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(String(input));
    const value = url.pathname === `/api/v1/projects/${projectId}` ? project : url.searchParams.has("cursor") ? { items: [items[1]], nextCursor: null } : { items: [items[0]], nextCursor: "next +/=" };
    return new Response(stringifyApiJson(value), { headers: { "content-type": "application/json" } });
  });
  const api = createApiClient({ serverUrl: "http://localhost:8787", operation, fetch });
  const context = { version: "0", packageDirectory: "unused", homeDirectory: () => { throw new Error("Unexpected config read"); }, workingDirectory: () => { throw new Error("Unexpected repository read"); }, stdout: vi.fn<(text: string) => void>(), stderr: vi.fn<(text: string) => void>(), stdoutBytes: vi.fn(async (_bytes: Uint8Array) => {}) } satisfies CliContext;
  const dependencies = {
    resolveProject: vi.fn<TaskCommandDependencies["resolveProject"]>(),
    runServerCommand: vi.fn<TaskCommandDependencies["runServerCommand"]>(async (current, command) => {
      const output = await command({ api, operation, serverUrl: "http://localhost:8787", serverConfiguration: { serverUrl: "http://localhost:8787" } });
      operation.check(); if (typeof output === "string") current.stdout(output); else if (output !== undefined) current.stdout(output.output);
    }),
  };
  for (const flag of ["--json", "--tree", "text"] as const) {
    const before = fetch.mock.calls.length;
    await runTaskCommand(["attachment", "list", taskId, ...(flag === "text" ? [] : [flag]), "--project", projectId], context, dependencies);
    const pageRequests = fetch.mock.calls.slice(before).map(([input]) => new URL(String(input))).filter(url => url.pathname.endsWith("/attachments"));
    expect(pageRequests).toHaveLength(2); expect(pageRequests[1]!.searchParams.get("cursor")).toBe("next +/=");
  }
  expect(JSON.parse(context.stdout.mock.calls[0]![0])).toEqual(items);
  const tree = context.stdout.mock.calls[1]![0];
  expect(tree).toContain("文档 space/"); expect(tree).toContain("设计 ?# %2F/"); expect(tree.match(/design\.md/g)).toHaveLength(2);
  const text = context.stdout.mock.calls[2]![0];
  for (const item of items) expect(text.split(`Path: ${item.path}\n`)).toHaveLength(2);
});
