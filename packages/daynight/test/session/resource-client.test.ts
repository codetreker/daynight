import { createHash } from "node:crypto";
import { expect, it } from "vitest";
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
  const bytes = Buffer.alloc(8_388_609, 42),
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
