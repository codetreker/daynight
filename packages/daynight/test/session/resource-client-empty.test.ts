import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { createSessionResourceClient } from "../../src/session/resource-client.js";
import {
  parseImageReadChunk,
  parsePreparedImageChunk,
} from "../../src/session/image-values.js";

const id = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
const emptySha = createHash("sha256").update(new Uint8Array()).digest("hex");
const descriptor = {
  resourceId: id,
  status: "available" as const,
  name: "legacy-empty.txt",
  mediaType: "text/plain",
  byteLength: "0",
  sha256: emptySha,
  error: null,
};
const chunk = {
  resourceId: id,
  byteLength: "0",
  sha256: emptySha,
  offset: "0",
  data: "",
  eof: true,
};

// A controlled product API proves real HTTP consumption without a Go/DB dependency.
const fixture = async (
  reply: { status?: number; actor?: string; body?: unknown } = {},
) => {
  const requests: { method: string | undefined; path: string | undefined; revision: string | undefined; authorized: boolean }[] = [];
  let principalMismatches = 0;
  const server = createServer((request, response) => {
    const authorized = request.headers.authorization === "Bearer controlled-reader";
    requests.push({
      method: request.method,
      path: request.url,
      revision: request.headers["daynight-session-content-revision"] as string | undefined,
      authorized,
    });
    response.writeHead(authorized ? (reply.status ?? 200) : 401, {
      "Content-Type": "application/json",
      "Daynight-User-ID": reply.actor ?? id,
    });
    response.end(JSON.stringify(reply.body ?? chunk));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address.");
  const origin = `http://127.0.0.1:${address.port}`;
  const api = createSessionResourceClient({
    scope: {
      serverOrigin: origin,
      actorUserId: id,
      fence: { sessionId: id, claimId: id, executionGeneration: "1" },
      authorizationGeneration: "1",
    },
    baseUrl: `${origin}/api/v1/test-sessions/${id}`,
    isCurrent: () => true,
    onPrincipalMismatch: () => { principalMismatches++; },
    transport: (url, signal, init) => fetch(url, {
      ...init,
      signal,
      headers: { ...init.headers, Authorization: "Bearer controlled-reader" },
    }),
  });
  return {
    api,
    requests,
    get principalMismatches() { return principalMismatches; },
    async close() {
      await api.close();
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
};

it.each(["text/plain", "image/png", "IMAGE/PNG"])("reads an empty legacy %s original over authorized HTTP before verifying its digest", async mediaType => {
  const f = await fixture();
  const digest = vi.spyOn(crypto.subtle, "digest");
  try {
    expect(await f.api.readResource({ ...descriptor, mediaType }, AbortSignal.timeout(5_000))).toEqual(new Uint8Array());
    expect(f.requests).toEqual([{
      method: "GET",
      path: `/api/v1/test-sessions/${id}/resources/${id}/content?offset=0&limit=524288`,
      revision: "2",
      authorized: true,
    }]);
    expect(digest).toHaveBeenCalledExactlyOnceWith("SHA-256", new Uint8Array());
  } finally {
    digest.mockRestore();
    await f.close();
  }
});

it.each([
  ["missing stored original", { status: 404 }, "HTTP 404"],
  ["different principal", { actor: otherId }, "principal mismatch|aborted"],
  ["different original", { body: { ...chunk, resourceId: otherId } }, "identity mismatch"],
  ["different digest", { body: { ...chunk, sha256: "a".repeat(64) } }, "identity mismatch"],
  ["nonempty content", { body: { ...chunk, data: "YQ==" } }, "Invalid"],
  ["unfinished empty content", { body: { ...chunk, eof: false } }, "Invalid"],
])("refuses an empty legacy read with %s", async (name, reply, error) => {
  const f = await fixture(reply);
  try {
    await expect(f.api.readResource(descriptor, AbortSignal.timeout(5_000))).rejects.toThrow(new RegExp(error));
    expect(f.requests).toHaveLength(1);
    expect(f.principalMismatches).toBe(name === "different principal" ? 1 : 0);
  } finally {
    await f.close();
  }
});

it("checks the actual empty digest after a matching HTTP response", async () => {
  const sha256 = "a".repeat(64);
  const f = await fixture({ body: { ...chunk, sha256 } });
  try {
    await expect(f.api.readResource({ ...descriptor, sha256 }, AbortSignal.timeout(5_000))).rejects.toThrow("corrupt");
    expect(f.requests).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it("keeps new image resources with empty originals unavailable", async () => {
  const f = await fixture();
  try {
    await expect(f.api.readResource({ ...descriptor, mediaType: "image/png", revision: "1", width: 1, height: 1, frameCount: 1 }, AbortSignal.timeout(5_000))).rejects.toThrow();
    expect(f.requests).toHaveLength(0);
  } finally {
    await f.close();
  }
});

it("accepts an empty generic read chunk while retaining positive prepared image lengths", () => {
  expect(parseImageReadChunk(chunk)).toEqual(chunk);
  const { resourceId, ...prepared } = chunk;
  expect(() => parsePreparedImageChunk({ preparationId: resourceId, ...prepared })).toThrow();
  const nonempty = { preparationId: resourceId, ...prepared, byteLength: "1", data: "YQ==" };
  expect(parsePreparedImageChunk(nonempty)).toEqual(nonempty);
});
