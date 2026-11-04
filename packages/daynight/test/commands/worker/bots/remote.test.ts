import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createBotRemote } from "../../../../src/commands/worker/bots/remote.js";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const ownerUserId = id(1), workerId = id(2);
const bot = (value = 3) => ({
  id: id(value), ownerUserId, workerId, version: "9007199254740993", deletion: null, name: "Assistant", creationOrder: "9007199254740994",
  requestedOverrides: {}, resolvedConfiguration: { workerId, cwd: "/ordinary", provider: "codex", model: null, args: [] },
  roleConfiguration: null, sessionId: null, testExecutionId: null, startupResult: { state: "pending", code: null },
  createdAt: "2026-11-04T00:00:00Z", updatedAt: "2026-11-04T00:00:00Z",
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const listen = async (handler: (request: IncomingMessage, response: ServerResponse) => void) => {
  const server = createServer((request, response) => {
    response.setHeader("Daynight-User-ID", ownerUserId);
    response.setHeader("Content-Type", "application/json");
    handler(request, response);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  }));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing fixture port.");
  const serverOrigin = `http://127.0.0.1:${address.port}`;
  return createBotRemote({ owner: { serverOrigin, ownerUserId, workerId }, serverToken: "fixture-token" });
};
const signal = () => new AbortController().signal;

describe("Bot inventory remote", () => {
  it("reads every page with the original worker and preserves decimal versions and duplicates for reconciliation", async () => {
    const requests: string[] = [];
    const remote = await listen((request, response) => {
      expect(request.headers.authorization).toBe("Bearer fixture-token");
      requests.push(request.url!);
      response.end(JSON.stringify(requests.length === 1 ? { items: [bot()], nextCursor: "opaque+/=" } : { items: [bot(), bot(4)], nextCursor: null }));
    });
    const result = await remote.list(signal());
    expect(result.map(item => item.id)).toEqual([id(3), id(3), id(4)]);
    expect(result[0]!.version).toBe("9007199254740993");
    expect(requests).toEqual([`/api/v1/me/workers/${workerId}/bots?limit=100`, `/api/v1/me/workers/${workerId}/bots?limit=100&cursor=opaque%2B%2F%3D`]);
  });

  it("rejects a failed later page and a repeated cursor instead of exposing a partial inventory", async () => {
    let page = 0;
    const remote = await listen((_request, response) => {
      page++;
      if (page === 2) { response.statusCode = 503; response.end(JSON.stringify({ error: "unavailable" })); }
      else response.end(JSON.stringify({ items: [bot()], nextCursor: "again" }));
    });
    await expect(remote.list(signal())).rejects.toThrow();
    await expect(remote.list(signal())).rejects.toThrow(/cursor/i);
  });

  it("accepts deletion projections without inventing their omitted definition", async () => {
    const deletion = { id: id(3), workerId, version: "4", deletion: { deletionId: id(9), requestedVersion: "3", workerCleanup: { state: "pending", code: null }, serverCleanup: { state: "pending", code: null } } };
    const remote = await listen((request, response) => {
      expect(request.url).toBe(`/api/v1/me/bots/${id(3)}`);
      response.end(JSON.stringify(deletion));
    });
    expect(await remote.read(id(3), signal())).toEqual(deletion);
  });

  it("only treats an authenticated not_found response as absent", async () => {
    let reads = 0;
    const remote = await listen((_request, response) => {
      reads++;
      response.statusCode = 404;
      if (reads === 2) response.removeHeader("Daynight-User-ID");
      response.end(JSON.stringify({ error: { code: "not_found", message: "Bot was not found.", requestId: "fixture" } }));
    });
    await expect(remote.read(id(3), signal())).resolves.toBeNull();
    await expect(remote.read(id(3), signal())).rejects.toThrow(/identity|principal|user/i);
  });

  it("rejects another authenticated owner, worker or single-resource identity", async () => {
    let reads = 0;
    const remote = await listen((_request, response) => {
      reads++;
      if (reads === 1) response.setHeader("Daynight-User-ID", id(99));
      response.end(JSON.stringify(reads === 2 ? { ...bot(), workerId: id(99) } : reads === 3 ? bot(4) : bot()));
    });
    for (let i = 0; i < 3; i++) await expect(remote.read(id(3), signal())).rejects.toThrow();
  });

  it("does not mistake a null success body or an unrelated 404 for confirmed absence", async () => {
    let requests = 0;
    const remote = await listen((_request, response) => {
      requests++;
      if (requests === 1) response.end("null");
      else { response.statusCode = 404; response.end(JSON.stringify({ error: { code: "route_not_found", message: "Unknown route.", requestId: "fixture" } })); }
    });
    await expect(remote.read(id(3), signal())).rejects.toThrow();
    await expect(remote.read(id(3), signal())).rejects.toThrow();
  });

  it("limits response bytes and refuses redirects before following another endpoint", async () => {
    let requests = 0;
    const remote = await listen((_request, response) => {
      requests++;
      if (requests === 1) response.end(JSON.stringify("x".repeat(16 * 1024 * 1024)));
      else { response.statusCode = 302; response.setHeader("Location", "/another"); response.end("{}"); }
    });
    await expect(remote.list(signal())).rejects.toThrow(/byte limit/);
    await expect(remote.list(signal())).rejects.toThrow();
    expect(requests).toBe(2);
  });

  it("rejects cancellation before any request and refuses malformed JSON", async () => {
    let requests = 0;
    const remote = await listen((_request, response) => { requests++; response.end("{broken"); });
    await expect(remote.list(AbortSignal.abort())).rejects.toThrow();
    expect(requests).toBe(0);
    await expect(remote.list(signal())).rejects.toThrow();
  });
});
