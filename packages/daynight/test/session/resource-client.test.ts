import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createSessionResourceClient } from "../../src/session/resource-client.js";
const id = "00000000-0000-4000-8000-000000000001";
const scope = {
  serverOrigin: "https://daynight.cc",
  actorUserId: id,
  fence: { sessionId: id, claimId: id, executionGeneration: "1" },
  authorizationGeneration: "1",
};
it("uses explicit occurrence eligibility and keeps retry bound to the original image", async () => {
  const calls: string[] = [];
  const api = createSessionResourceClient({ scope, baseUrl: `https://daynight.cc/api/v1/test-sessions/${id}`, isCurrent: () => true,
    transport: async (url, _signal, init) => {
      calls.push(url);
      if (init.method === "POST") {
        expect(init.body).toBe("{}");
        return Response.json({ capture: { captureId: id, attemptId: id, revision: "1", occurrence: { imageId: id, entryId: id, container: "content", partId: null, sourceRevision: null, sourceTextSha256: null, callId: null, sourceKey: "original-source" }, state: "reserved", resourceId: id, resource: null, error: null } }, { headers: { "Daynight-User-ID": id } });
      }
      return Response.json({ imageId: id, revision: "1", state: "failed", resourceId: null, action: "retry_source", error: { code: "source_unavailable", message: "observe" } }, { headers: { "Daynight-User-ID": id } });
    } });
  try {
    expect((await api.getOccurrence(id, new AbortController().signal)).action).toBe("retry_source");
    expect((await api.retryOccurrence(id, new AbortController().signal)).captureId).toBe(id);
    expect(calls.map(url => new URL(url).pathname)).toEqual([`/api/v1/test-sessions/${id}/image-occurrences/${id}`, `/api/v1/test-sessions/${id}/image-occurrences/${id}/retry`]);
  } finally { await api.close(); }
});
it("reads and verifies a resource above the former online limit with bounded chunks", async () => {
  const bytes = Buffer.alloc(8_388_609, Buffer.from(Array.from({ length: 256 }, (_, i) => i))),
    sha256 = createHash("sha256").update(bytes).digest("hex");
  const descriptor = {
    resourceId: id,
    status: "available" as const,
    name: "sample",
    mediaType: "application/octet-stream",
    byteLength: String(bytes.length),
    sha256,
    error: null,
  };
  let calls = 0;
  const api = createSessionResourceClient({
    scope,
    baseUrl: `https://daynight.cc/api/v1/test-sessions/${id}`,
    isCurrent: () => true,
    transport: async (url) => {
      const u = new URL(url),
        offset = Number(u.searchParams.get("offset")),
        limit = Number(u.searchParams.get("limit"));
      calls++;
      expect(limit).toBeLessThanOrEqual(524288);
      return Response.json(
        {
          resourceId: id,
          byteLength: String(bytes.length),
          sha256,
          offset: String(offset),
          data: bytes.subarray(offset, offset + limit).toString("base64"),
          eof: offset + limit >= bytes.length,
        },
        { headers: { "Daynight-User-ID": id } },
      );
    },
  });
  expect(Buffer.from(await api.readResource(descriptor, new AbortController().signal)).equals(bytes)).toBe(true);
  expect(calls).toBe(17);
  await api.close();
});
it("invalidates owner access before publishing a late read", async () => {
  let current = true;
  const api = createSessionResourceClient({
    scope,
    baseUrl: `https://daynight.cc/api/v1/test-sessions/${id}`,
    isCurrent: () => current,
    transport: async () => {
      current = false;
      return Response.json({}, { headers: { "Daynight-User-ID": id } });
    },
  });
  await expect(
    api.readResource(
      {
        resourceId: id,
        status: "available",
        name: "sample",
        mediaType: "image/png",
        byteLength: "1",
        sha256: "a".repeat(64),
        error: null,
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  await api.close();
});


it("reports the original principal mismatch while invalidating the resource client", async () => {
  const mismatch = vi.fn(), cancelled = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
  const api = createSessionResourceClient({
    scope, baseUrl: `https://daynight.cc/api/v1/test-sessions/${id}`, isCurrent: () => true,
    onPrincipalMismatch: mismatch,
    transport: async () => new Response(body, { headers: { "Daynight-User-ID": "00000000-0000-4000-8000-000000000002" } }),
  });
  try {
    await expect(api.capabilities(new AbortController().signal)).rejects.toThrow("Session resource principal mismatch.");
    expect(mismatch).toHaveBeenCalledOnce();
    expect(cancelled).toHaveBeenCalledOnce();
    await expect(api.capabilities(new AbortController().signal)).rejects.toMatchObject({ name: "AbortError" });
  } finally { await api.close(); }
});

it("preserves caller cancellation when it occurs during mismatch cleanup", async () => {
  let cleanupStarted!: () => void, failCleanup!: (error: Error) => void;
  const cleaning = new Promise<void>(resolve => { cleanupStarted = resolve; });
  const controller = new AbortController(), reason = new Error("caller cancelled");
  const body = new ReadableStream<Uint8Array>({ cancel() {
    cleanupStarted();
    return new Promise<void>((_resolve, reject) => { failCleanup = reject; });
  } });
  const api = createSessionResourceClient({
    scope, baseUrl: `https://daynight.cc/api/v1/test-sessions/${id}`, isCurrent: () => true,
    transport: async () => new Response(body, { headers: { "Daynight-User-ID": "00000000-0000-4000-8000-000000000002" } }),
  });
  try {
    const pending = api.capabilities(controller.signal);
    await cleaning;
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    failCleanup(new Error("late cleanup failure"));
    await Promise.resolve();
  } finally { await api.close(); }
});


it("gives an already cancelled network lifetime priority over a mismatch", async () => {
  const network = new AbortController(), reason = new Error("network cancelled"), mismatch = vi.fn();
  const api = createSessionResourceClient({
    scope, baseUrl: `https://daynight.cc/api/v1/test-sessions/${id}`, isCurrent: () => true,
    onPrincipalMismatch: mismatch,
    transport: async () => new Response(null, { headers: { "Daynight-User-ID": "00000000-0000-4000-8000-000000000002" } }),
    responseSignal: (_response, signal) => { network.abort(reason); return AbortSignal.any([signal, network.signal]); },
  });
  try {
    await expect(api.capabilities(new AbortController().signal)).rejects.toBe(reason);
    expect(mismatch).not.toHaveBeenCalled();
  } finally { await api.close(); }
});


it("preserves principal mismatch when reading a resource", async () => {
  const mismatch = vi.fn();
  const api = createSessionResourceClient({
    scope, baseUrl: `https://daynight.cc/api/v1/test-sessions/${id}`, isCurrent: () => true,
    onPrincipalMismatch: mismatch,
    transport: async () => Response.json({}, { headers: { "Daynight-User-ID": "00000000-0000-4000-8000-000000000002" } }),
  });
  try {
    await expect(api.readResource({ resourceId: id, status: "available", name: "sample", mediaType: "image/png", byteLength: "1", sha256: "a".repeat(64), error: null }, new AbortController().signal))
      .rejects.toThrow("Session resource principal mismatch.");
    expect(mismatch).toHaveBeenCalledOnce();
  } finally { await api.close(); }
});


it.each(["network", "caller"] as const)("preserves the first %s cancellation when both signals abort", async first => {
  const network = new AbortController(), caller = new AbortController();
  const networkReason = new Error("network cancelled"), callerReason = new Error("caller cancelled");
  let started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const body = new ReadableStream<Uint8Array>({ pull() { started(); } }, { highWaterMark: 0 });
  const api = createSessionResourceClient({
    scope, baseUrl: `https://daynight.cc/api/v1/test-sessions/${id}`, isCurrent: () => true,
    transport: async () => new Response(body, { headers: { "Daynight-User-ID": id } }),
    responseSignal: (_response, signal) => AbortSignal.any([signal, network.signal]),
  });
  try {
    const pending = api.capabilities(caller.signal);
    await reading;
    if (first === "network") { network.abort(networkReason); caller.abort(callerReason); }
    else { caller.abort(callerReason); network.abort(networkReason); }
    await expect(pending).rejects.toBe(first === "network" ? networkReason : callerReason);
  } finally { await api.close(); }
});
