import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient, createOperation, stringifyApiJson } from "../../../src/api/index.js";
import { runCli } from "../../../src/cli/application.js";
import type { CliContext } from "../../../src/cli/context.js";
import { runTaskCommand } from "../../../src/commands/task/command.js";
import type { TaskCommandDependencies } from "../../../src/commands/task/command.js";
import { THREAD_OUTPUT_BYTES } from "../../../src/commands/task/thread-rendering.js";

const projectId = "aaaaaaaa-1111-4111-8111-111111111111";
const taskId = "bbbbbbbb-2222-4222-8222-222222222222";
const userId = "cccccccc-3333-4333-8333-333333333333";
const otherId = "dddddddd-4444-4444-8444-444444444444";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const message = (n: number, body = `message ${n}`) => ({ id: id(n), author: { userId, displayName: null, Agent: false }, createdAt: "2026-11-03T10:11:12.123Z", body });
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

type Request = { method: string; url: URL; body: string; authorization: string | undefined };
const fixture = async (respond: (request: Request, response: ServerResponse) => void) => {
  const requests: Request[] = [];
  const server: Server = createServer((request, response) => {
    let body = ""; request.setEncoding("utf8"); request.on("data", (part: string) => { body += part; });
    request.on("end", () => { const captured = { method: request.method!, url: new URL(request.url!, "http://localhost"), body, authorization: request.headers.authorization }; requests.push(captured); respond(captured, response); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  cleanups.push(async () => { server.closeAllConnections(); if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error))); });
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing HTTP listener.");
  const serverUrl = `http://127.0.0.1:${address.port}`;
  const operation = createOperation({ limits: { totalMs: 5_000, requestMs: 3_000 } }); cleanups.push(() => operation.dispose());
  const api = createApiClient({ serverUrl, serverToken: "fixture-token", expectedUserId: userId, operation });
  const chunks: Buffer[] = [];
  const context = { version: "0", packageDirectory: "unused", homeDirectory: () => { throw new Error("Unexpected config read"); }, workingDirectory: () => { throw new Error("Unexpected repository read"); }, stdout: vi.fn<(text: string) => void>(), stderr: vi.fn<(text: string) => void>(), stdoutBytes: vi.fn(async (value: Uint8Array) => { chunks.push(Buffer.from(value)); }) } satisfies CliContext;
  const dependencies = {
    resolveProject: vi.fn<TaskCommandDependencies["resolveProject"]>(),
    runServerCommand: vi.fn<TaskCommandDependencies["runServerCommand"]>(async (current, command) => {
      const output = await command({ api, operation, serverUrl, serverConfiguration: { serverUrl } });
      operation.check(); if (typeof output === "string") current.stdout(output); else if (output !== undefined) current.stdout(output.output);
    }),
  };
  const run = (args: string[]) => runCli(["task", "thread", ...args, "--project", projectId], context, [{ name: "task", description: "Manage tasks", load: async () => ({ run: (rest, current) => runTaskCommand(rest, current, dependencies) }) }]);
  return { requests, chunks, context, run };
};
const json = (response: ServerResponse, value: unknown, principal = userId, status = 200) => {
  response.writeHead(status, { "Content-Type": "application/json", "Daynight-User-ID": principal }); response.end(stringifyApiJson(value));
};
const ids = (output: Buffer) => [...output.toString("utf8").matchAll(/^Id: (.+)$/gm)].map((match) => match[1]);

it("uses explicit boundaries for successive forward and backward reads without dropping or repeating messages", async () => {
  const f = await fixture((request, response) => {
    const after = request.url.searchParams.get("afterId"), before = request.url.searchParams.get("beforeId");
    const items = after === id(1) ? [message(2), message(3)] : after === id(3) ? [message(4), message(5)] : before === id(5) ? [message(3), message(4)] : before === id(3) ? [message(1), message(2)] : [];
    json(response, { items, hasMoreBefore: before === id(5), hasMoreAfter: after === id(1) });
  });
  for (const [direction, boundary] of [["after", 1], ["after", 3], ["before", 5], ["before", 3]] as const) {
    expect(await f.run(["read", taskId, `--${direction}-id`, id(boundary), "--count", "2"])).toBe(0);
  }
  expect(f.chunks.map(ids)).toEqual([[id(2), id(3)], [id(4), id(5)], [id(3), id(4)], [id(1), id(2)]]);
  expect(f.requests).toHaveLength(4);
  expect(f.requests.every(({ method, url, authorization }) => method === "GET" && url.searchParams.get("count") === "2" && authorization === "Bearer fixture-token")).toBe(true);
  expect(f.requests.map(({ url }) => url.searchParams.get("afterId") ?? url.searchParams.get("beforeId"))).toEqual([id(1), id(3), id(5), id(3)]);
  expect(f.context.stderr).not.toHaveBeenCalled();
});

it("retrieves messages omitted by the rendered byte budget using the first displayed boundary", async () => {
  const large = [message(1, "\u007f".repeat(30_000)), message(2, "\u007f".repeat(30_000)), message(3, "\u007f".repeat(30_000))];
  const f = await fixture((request, response) => {
    const before = request.url.searchParams.get("beforeId");
    json(response, before === id(2) ? { items: [large[0]], hasMoreBefore: false, hasMoreAfter: true } : { items: large, hasMoreBefore: false, hasMoreAfter: false });
  });
  expect(await f.run(["read", taskId, "--count", "100"])).toBe(0);
  expect(ids(f.chunks[0]!)).toEqual([id(2), id(3)]);
  expect(f.chunks[0]!.byteLength).toBeLessThanOrEqual(THREAD_OUTPUT_BYTES);
  expect(f.chunks[0]!.toString("utf8")).toMatch(/^\.\.\. Has more messages before/);
  expect(await f.run(["read", taskId, "--before-id", id(2), "--count", "100"])).toBe(0);
  expect(ids(f.chunks[1]!)).toEqual([id(1)]);
  expect(f.chunks[1]!.byteLength).toBeLessThanOrEqual(THREAD_OUTPUT_BYTES);
  expect(f.requests).toHaveLength(2); expect(f.requests[1]!.url.searchParams.get("beforeId")).toBe(id(2));
  expect(f.context.stderr).not.toHaveBeenCalled();
});

it("reports a lost HTTP POST response as unknown without replay or private output", async () => {
  const f = await fixture((_request, response) => { response.socket!.destroy(); });
  expect(await f.run(["post", taskId, "--body", "private message"])).toBe(1);
  expect(f.requests).toHaveLength(1); expect(f.requests[0]!.method).toBe("POST");
  expect(JSON.parse(f.requests[0]!.body)).toEqual({ body: "private message" });
  expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.chunks).toHaveLength(0);
  const diagnostic = f.context.stderr.mock.calls.map(([text]) => text).join("");
  expect(diagnostic).toContain("The posting outcome is unknown."); expect(diagnostic).not.toMatch(/private message|fixture-token|Caused by:/);
});

it("rejects a successful POST receipt from another principal without output or replay", async () => {
  const f = await fixture((_request, response) => json(response, message(1, "private message"), otherId, 201));
  expect(await f.run(["post", taskId, "--body", "private message"])).toBe(1);
  expect(f.requests).toHaveLength(1); expect(f.requests[0]!.method).toBe("POST");
  expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.chunks).toHaveLength(0);
  const diagnostic = f.context.stderr.mock.calls.map(([text]) => text).join("");
  expect(diagnostic).toContain("The posting outcome is unknown."); expect(diagnostic).not.toMatch(/private message|fixture-token/);
});
