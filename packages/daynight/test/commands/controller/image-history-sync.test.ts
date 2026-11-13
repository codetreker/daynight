import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import type { TimelineEntry } from "../../../src/session/protocol.js";
import { assertImageHistoryAvailable, syncControllerImageHistory } from "../../../src/commands/controller/media/history-sync.js";
import { createControllerCaptureBridge } from "../../../src/commands/controller/media/capture.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async (count = 1, text = "durable history") => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/image-history-tests"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); roots.push(home);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "original", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  await writeFile(ticket.credentialFile, JSON.stringify({ token: "controller-grant-only", expiresAt: new Date(Date.now() + 900000).toISOString(), sessionId: ticket.sessionId, claimId: ticket.claimId, executionGeneration: ticket.executionGeneration, controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId }), { mode: 0o600 });
  const file = path.join(home, "journal.sqlite"), journal = openControllerLifecycleStore(file, ticket, { contentOwnedLocally: true });
  journal.recordRelayHistory("opaque-current-history");
  for (let i = 0; i < count; i++) journal.projectTimeline({ entryId: randomUUID(), revision: "1", kind: "assistant_message", content: [{ type: "text", text }] });
  journal.acknowledgeEvents(journal.getLastSourceSequence());
  const fence = { sessionId: ticket.sessionId, claimId: ticket.claimId!, executionGeneration: ticket.executionGeneration, connectionEpoch: "1" };
  return { file, journal, ticket, fence, currentFence: () => fence };
};
const receiver = (failOnce = false) => {
  const rows = new Map<string, { bytes: Buffer; length: string; sha256: string }>(), calls: { id: string; method: string; offset: number }[] = [];
  let fail = failOnce;
  const reply = (id: string, row: { bytes: Buffer; length: string; sha256: string }) => ({ syncId: id, state: row.bytes.length === Number(row.length) ? "complete" : "receiving", acceptedOffset: String(row.bytes.length), byteLength: row.length, sha256: row.sha256, timelineRevision: row.bytes.length === Number(row.length) ? "1" : null, error: null });
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init!.method!, id = url.pathname.split("/").filter(Boolean).at(-1) === "status" ? url.pathname.split("/").at(-2)! : url.pathname.split("/").at(-1)!, offset = Number(url.searchParams.get("offset")); calls.push({ id, method, offset });
    const headers = new Headers(init!.headers); expect(headers.get("Authorization")).toBe("Bearer controller-grant-only"); expect(JSON.parse(headers.get("Daynight-Controller-Fence")!)).toHaveProperty("connectionEpoch", "1");
    if (method === "GET") return rows.has(id) ? Response.json(reply(id, rows.get(id)!)) : new Response(null, { status: 404 });
    const chunk = Buffer.from(init!.body as Uint8Array); expect(chunk.length).toBeLessThanOrEqual(1048576); expect(headers.get("Daynight-Chunk-SHA256")).toBe(createHash("sha256").update(chunk).digest("hex"));
    const row = rows.get(id) ?? { bytes: Buffer.alloc(0), length: headers.get("Daynight-File-Byte-Length")!, sha256: headers.get("Daynight-File-SHA256")! }; expect(offset).toBe(row.bytes.length); row.bytes = Buffer.concat([row.bytes, chunk]); rows.set(id, row);
    if (row.bytes.length === Number(row.length)) expect(createHash("sha256").update(row.bytes).digest("hex")).toBe(row.sha256);
    if (fail) { fail = false; throw new Error("Lost committed chunk response"); }
    return Response.json(reply(id, row));
  };
  return { request, rows, calls };
};

test("active history uses the original grant and exact current SQL history in one MiB chunks", async () => {
  const text = "x".repeat(1048576), f = await fixture(2, text), server = receiver();
  try {
    await syncControllerImageHistory({ ...f, request: server.request });
    expect(server.rows.size).toBe(1); const row = [...server.rows.values()][0]!;
    expect(JSON.parse(row.bytes.toString()).entries.map((entry: { content: unknown }) => entry.content)).toEqual([[{ type: "text", text }], [{ type: "text", text }]]);
    expect(server.calls.filter(call => call.method === "PUT")).toHaveLength(3);
    expect(f.journal.prepareImageHistorySync()).toBeNull();
  } finally { f.journal.close(); }
});

test("active history includes exactly the referenced resource descriptors and rejects a missing descriptor", async () => {
  const f = await fixture(), server = receiver(), resourceId = randomUUID();
  const resource = { resourceId, revision: "1", status: "pending", name: "original.png", mediaType: null, byteLength: null, sha256: null, error: null, width: null, height: null, frameCount: null };
  try {
    f.journal.appendEvent({ kind: "resource", payload: resource }); f.journal.acknowledgeEvents(f.journal.getLastSourceSequence());
    await syncControllerImageHistory({ ...f, request: server.request });
    expect(JSON.parse([...server.rows.values()][0]!.bytes.toString()).resources).toEqual([]);
    f.journal.projectTimeline({ entryId: randomUUID(), revision: "1", kind: "assistant_message", content: [{ type: "resource", resourceId, label: "original.png" }] });
    f.journal.acknowledgeEvents(f.journal.getLastSourceSequence());
    await syncControllerImageHistory({ ...f, request: server.request });
    expect(JSON.parse([...server.rows.values()][1]!.bytes.toString()).resources).toEqual([resource]);
    f.journal.projectTimeline({ entryId: randomUUID(), revision: "1", kind: "assistant_message", content: [{ type: "resource", resourceId: randomUUID(), label: "missing.png" }] });
    f.journal.acknowledgeEvents(f.journal.getLastSourceSequence());
    expect(() => f.journal.prepareImageHistorySync()).toThrow("missing resource descriptor");
  } finally { f.journal.close(); }
});

test("lost chunk receipt survives journal reopen and resumes only the original sync ID and frozen body", async () => {
  const f = await fixture(2, "x".repeat(1048576)), server = receiver(true);
  await expect(syncControllerImageHistory({ ...f, request: server.request })).rejects.toThrow("Lost committed");
  const intent = f.journal.prepareImageHistorySync()!, bytes = await readFile(intent.filename); expect((await stat(intent.filename)).mode & 0o222).toBe(0);
  const first = (JSON.parse(bytes.toString()) as { entries: TimelineEntry[] }).entries[0]!;
  f.journal.projectTimeline({ ...first, revision: "2", kind: "assistant_message", content: [{ type: "text", text: "later committed SQL revision" }] });
  f.journal.acknowledgeEvents(f.journal.getLastSourceSequence());
  f.journal.close(); const journal = openControllerLifecycleStore(f.file, f.ticket, { contentOwnedLocally: true });
  try {
    expect(journal.prepareImageHistorySync()).toEqual(intent);
    await syncControllerImageHistory({ ...f, journal, request: server.request });
    expect(new Set(server.calls.map(call => call.id))).toEqual(new Set([intent.syncId]));
    expect([...server.rows.values()][0]!.bytes.equals(bytes)).toBe(true);
    expect(server.calls.filter(call => call.method === "PUT").map(call => call.offset)).toEqual([0, 1048576, 2097152]);
    await expect(readFile(intent.filename)).rejects.toMatchObject({ code: "ENOENT" });
    const next = journal.prepareImageHistorySync()!;
    expect(next.syncId).not.toBe(intent.syncId);
    expect(BigInt(next.sourceThrough)).toBeGreaterThan(BigInt(intent.sourceThrough));
    expect((JSON.parse((await readFile(next.filename)).toString()) as { entries: TimelineEntry[] }).entries[0]).toMatchObject({ revision: "2", content: [{ type: "text", text: "later committed SQL revision" }] });
  } finally { journal.close(); }
});

test("unacknowledged source waits, while a later source or connection requires a fresh complete checkpoint", async () => {
  const f = await fixture(), server = receiver();
  try {
    await syncControllerImageHistory({ ...f, request: server.request });
    f.journal.projectTimeline({ entryId: randomUUID(), revision: "1", kind: "assistant_message", content: [{ type: "text", text: "later source" }] });
    expect(f.journal.prepareImageHistorySync()).toBeNull(); f.journal.acknowledgeEvents(f.journal.getLastSourceSequence());
    await syncControllerImageHistory({ ...f, request: server.request }); expect(server.rows.size).toBe(2);
    f.journal.recordRelayHistory("a-reconnected-history"); await syncControllerImageHistory({ ...f, request: server.request }); expect(server.rows.size).toBe(3);
  } finally { f.journal.close(); }
});

test("a failed original synchronization can be retired but a conflicting receipt keeps its intent", async () => {
  const f = await fixture();
  try {
    const intent = f.journal.prepareImageHistorySync()!;
    const request: typeof fetch = async () => Response.json({ syncId: intent.syncId, state: "failed", acceptedOffset: "0", byteLength: intent.byteLength, sha256: "b".repeat(64), timelineRevision: null, error: { code: "source_changed", message: "Source changed" } });
    await expect(syncControllerImageHistory({ ...f, request })).rejects.toThrow("original synchronization intent");
    expect(f.journal.prepareImageHistorySync()).toEqual(intent);
    await expect(syncControllerImageHistory({ ...f, request: async () => Response.json({ syncId: intent.syncId, state: "failed", acceptedOffset: "0", byteLength: intent.byteLength, sha256: intent.sha256, timelineRevision: null, error: { code: "source_changed", message: "Source changed" } }) })).rejects.toMatchObject({ name: "ImageHistorySyncFailedError", imageError: { code: "source_changed", message: "Source changed" } });
    const db = new Database(f.file, { readonly: true }); try { expect(db.prepare("SELECT value FROM image_runtime_state WHERE key='active_history_sync'").get()).toBeUndefined(); } finally { db.close(); }
    expect(f.journal.getImageHistorySyncFailure()).toEqual({ code: "source_changed", message: "Source changed" });
    expect(f.journal.prepareImageHistorySync()!.syncId).not.toBe(intent.syncId);
  } finally { f.journal.close(); }
});

test("connection changes and cancellation retain the original frozen identity", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    await expect(syncControllerImageHistory({ ...f, currentFence: () => ({ ...f.fence, connectionEpoch: "2" }), request: async () => { calls++; throw new Error("Unexpected request"); } })).rejects.toThrow("connection changed");
    expect(calls).toBe(0); const intent = f.journal.prepareImageHistorySync()!;
    const abort = new AbortController(); let started!: () => void; const sending = new Promise<void>(resolve => { started = resolve; }); let joined = false;
    const request: typeof fetch = async (_input, init) => {
      if (init!.method === "GET") return new Response(null, { status: 404 });
      started();
      try { await new Promise<never>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true })); }
      finally { joined = true; }
      throw new Error("Unreachable");
    };
    const pending = syncControllerImageHistory({ ...f, signal: abort.signal, request });
    const rejected = expect(pending).rejects.toThrow("Stopped by caller"); await sending; abort.abort(new Error("Stopped by caller")); await rejected;
    expect(joined).toBe(true); expect(f.journal.prepareImageHistorySync()).toEqual(intent); expect(await readFile(intent.filename)).not.toHaveLength(0);
  } finally { f.journal.close(); }
});


test("a confirmed failed history reaches captures even when background synchronization observes it first", async () => {
  const f = await fixture(), entryId = randomUUID(), imageId = randomUUID();
  const occurrence = { imageId, entryId, container: "content" as const, partId: null, sourceRevision: null, sourceTextSha256: null, callId: null, sourceKey: "original-native-part" };
  f.journal.projectTimeline({ entryId, kind: "assistant_message", revision: "1", content: [{ type: "text", text: "image location" }] });
  f.journal.registerImageOccurrence(occurrence, null); f.journal.acknowledgeEvents(f.journal.getLastSourceSequence());
  const request = { captureId: randomUUID(), attemptId: randomUUID(), occurrence, nativeSource: null, locator: { kind: "local" as const, path: "/original.png", contextId: randomUUID() } };
  let puts = 0, gets = 0;
  const intent = f.journal.prepareImageHistorySync()!;
  const requestHistory: typeof fetch = async (_url, init) => {
    if (init!.method === "PUT") { puts++; return Response.json({ error: { code: "quota_exceeded", message: "Session content capacity is exhausted.", requestId: randomUUID() } }, { status: 409 }); }
    gets++;
    if (gets === 1) return new Response(null, { status: 404 });
    return Response.json({ syncId: intent.syncId, state: "failed", acceptedOffset: intent.byteLength, byteLength: intent.byteLength, sha256: intent.sha256, timelineRevision: null, error: { code: "quota_exceeded", message: "Session content capacity is exhausted." } });
  };
  try {
    await expect(syncControllerImageHistory({ ...f, request: requestHistory })).rejects.toMatchObject({ name: "ImageHistorySyncFailedError", imageError: { code: "quota_exceeded" } });
    expect(puts).toBe(1); expect(gets).toBe(2);
    expect(f.journal.getImageHistorySyncFailure()).toEqual({ code: "quota_exceeded", message: "Session content capacity is exhausted." });
    // A later ACK cannot erase a failure that the capture has not yet observed.
    f.journal.projectTimeline({ entryId: randomUUID(), kind: "assistant_message", revision: "1", content: [{ type: "text", text: "later source" }] });
    f.journal.acknowledgeEvents(f.journal.getLastSourceSequence());
    f.journal.close();
    const journal = openControllerLifecycleStore(f.file, f.ticket, { contentOwnedLocally: true });
    try {
      let registrations = 0;
      const capture = async () => { registrations++; return { captureId: request.captureId, attemptId: request.attemptId, revision: "1", occurrence, state: "reserved" as const, resourceId: randomUUID(), resource: null, error: null }; };
      const bridge = createControllerCaptureBridge({ journal, capture, beforeCapture: async () => { assertImageHistoryAvailable(journal); }, provider: () => null, writable: () => true });
      await expect(bridge.providerOptions.registerImageCapture!(request)).rejects.toMatchObject({ name: "ImageCapturePrerequisiteError", code: "quota_exceeded" });
      expect(registrations).toBe(0); expect(journal.getImageCaptureRequest(request.captureId)).toEqual(request);
      // A new successful complete checkpoint is the only event that clears it.
      await syncControllerImageHistory({ ...f, journal, request: receiver().request });
      expect(journal.getImageHistorySyncFailure()).toBeNull();
      await bridge.providerOptions.registerImageCapture!(request);
      expect(registrations).toBe(1);
    } finally { journal.close(); }
  } finally { try { f.journal.close(); } catch { /* already closed for reopen */ } }
});

test("failed status observation keeps the frozen original and does not invent a refusal", async () => {
  const f = await fixture();
  try {
    const intent = f.journal.prepareImageHistorySync()!; let gets = 0;
    const request: typeof fetch = async (_url, init) => {
      if (init!.method === "PUT") return new Response(null, { status: 409 });
      gets++; return new Response(null, { status: gets === 1 ? 404 : 503 });
    };
    await expect(syncControllerImageHistory({ ...f, request })).rejects.toThrow("original status observation failed");
    expect(f.journal.prepareImageHistorySync()).toEqual(intent);
    expect(f.journal.getImageHistorySyncFailure()).toBeNull();
    expect(await readFile(intent.filename)).not.toHaveLength(0);
  } finally { f.journal.close(); }
});
