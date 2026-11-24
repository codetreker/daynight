import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { statfsSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import type { TimelineEntry } from "../../../src/session/protocol.js";
import { assertImageHistoryAvailable, syncControllerImageHistory } from "../../../src/commands/controller/media/history-sync.js";
import { createControllerCaptureBridge } from "../../../src/commands/controller/media/capture.js";
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(), statfsSync: vi.fn(() => ({ bavail: 0n, bsize: 4096n })) }));
const roots: string[] = [];
afterEach(async () => { vi.mocked(statfsSync).mockClear(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async (count = 1, text = "durable history", historyPolicy: "legacy" | "task_body" = "legacy") => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/image-history-tests"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); roots.push(home);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "original", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  await writeFile(ticket.credentialFile, JSON.stringify({ token: "controller-grant-only", expiresAt: new Date(Date.now() + 900000).toISOString(), sessionId: ticket.sessionId, claimId: ticket.claimId, executionGeneration: ticket.executionGeneration, controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId }), { mode: 0o600 });
  const file = path.join(home, "journal.sqlite"), journal = openControllerLifecycleStore(file, ticket, { contentOwnedLocally: true, historyPolicy });
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

const taskBodyResponse = async (server: ReturnType<typeof receiver>, input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
  expect(new Headers(init?.headers).get("Daynight-Task-Body-History-Version")).toBe("1");
  const response = await server.request(input, init);
  response.headers.set("Daynight-Task-Body-History-Version", "1");
  return response;
};

test("Task body history excludes tool content and resources while acknowledging the entire source checkpoint", async () => {
  const f = await fixture(1, "body answer", "task_body"), server = receiver();
  const bodyResource = randomUUID(), toolResource = randomUUID();
  try {
    for (const resourceId of [bodyResource, toolResource]) f.journal.appendEvent({ kind: "resource", payload: { resourceId, revision: "1", status: "pending", name: "original.png", mediaType: null, byteLength: null, sha256: null, error: null, width: null, height: null, frameCount: null } });
    f.journal.projectTimeline({ entryId: randomUUID(), revision: "1", kind: "assistant_message", content: [{ type: "resource", resourceId: bodyResource, label: "body image" }] });
    const toolId = randomUUID();
    f.journal.projectTimeline({ entryId: toolId, revision: "1", kind: "tool_call", callId: "call-1", name: "shell", input: "private command", output: [{ type: "text", text: "tool-exclusive-marker" }, { type: "resource", resourceId: toolResource, label: "tool image" }], status: "completed", truncated: false });
    expect(f.journal.prepareImageHistorySync()).toBeNull();
    const sourceThrough = f.journal.getLastSourceSequence(); f.journal.acknowledgeEvents(sourceThrough);
    await syncControllerImageHistory({ ...f, request: (input, init) => taskBodyResponse(server, input, init) });
    const bytes = [...server.rows.values()][0]!.bytes.toString(), body = JSON.parse(bytes);
    expect(body).toMatchObject({ contentPolicy: "task_body", sourceThrough });
    expect(body.entries.map((entry: TimelineEntry) => entry.kind)).toEqual(["assistant_message", "assistant_message"]);
    expect(body.resources.map((resource: { resourceId: string }) => resource.resourceId)).toEqual([bodyResource]);
    expect(bytes).not.toContain("tool-exclusive-marker"); expect(bytes).not.toContain(toolResource);
    expect(f.journal.hasImageHistoryCheckpoint(sourceThrough)).toBe(true);
    expect(f.journal.getTimelineEntry(toolId)).toMatchObject({ kind: "tool_call" });
  } finally { f.journal.close(); }
});

test("Task body synchronization refuses an unsupported service before any upload", async () => {
  const f = await fixture(1, "body", "task_body"), server = receiver();
  try {
    const intent = f.journal.prepareImageHistorySync()!;
    await expect(syncControllerImageHistory({ ...f, request: server.request })).rejects.toThrow("upgrade_required");
    expect(server.calls.map(call => call.method)).toEqual(["GET"]); expect(server.rows.size).toBe(0);
    expect(f.journal.prepareImageHistorySync()).toEqual(intent);
  } finally { f.journal.close(); }
});

test("Task body frozen synchronization survives unknown results and journal reopen with its original identity", async () => {
  const f = await fixture(1, "original body", "task_body"), server = receiver();
  const intent = f.journal.prepareImageHistorySync()!, bytes = await readFile(intent.filename);
  let committed = false;
  const request: typeof fetch = async (input, init) => {
    if (committed) throw new Error("status unavailable after unknown write");
    const response = await taskBodyResponse(server, input, init);
    if (init?.method === "PUT") { committed = true; throw new Error("lost committed response"); }
    return response;
  };
  await expect(syncControllerImageHistory({ ...f, request })).rejects.toThrow("original status observation failed");
  f.journal.projectTimeline({ entryId: randomUUID(), revision: "1", kind: "assistant_message", content: [{ type: "text", text: "later body" }] });
  f.journal.acknowledgeEvents(f.journal.getLastSourceSequence()); f.journal.close();
  const journal = openControllerLifecycleStore(f.file, f.ticket, { contentOwnedLocally: true });
  try {
    expect(journal.prepareImageHistorySync()).toEqual(intent);
    await syncControllerImageHistory({ ...f, journal, request: (input, init) => taskBodyResponse(server, input, init) });
    expect(new Set(server.calls.map(call => call.id))).toEqual(new Set([intent.syncId]));
    expect([...server.rows.values()][0]!.bytes).toEqual(bytes);
    expect(journal.prepareImageHistorySync()?.syncId).not.toBe(intent.syncId);
  } finally { journal.close(); }
});

test("active history uses the original grant and exact SQL history without predicting disk growth", async () => {
  const text = "x".repeat(1048576), f = await fixture(2, text), server = receiver();
  try {
    await syncControllerImageHistory({ ...f, request: server.request });
    expect(server.rows.size).toBe(1); const row = [...server.rows.values()][0]!;
    expect(JSON.parse(row.bytes.toString()).entries.map((entry: { content: unknown }) => entry.content)).toEqual([[{ type: "text", text }], [{ type: "text", text }]]);
    expect(server.calls.filter(call => call.method === "PUT")).toHaveLength(3);
    expect(f.journal.prepareImageHistorySync()).toBeNull();
    expect(statfsSync).not.toHaveBeenCalled();
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

test("capture preparation cannot mistake an unacknowledged tail for a completed history upload", async () => {
  const f = await fixture(), server = receiver(), entryId = randomUUID(), imageId = randomUUID();
  const occurrence = { imageId, entryId, container: "content" as const, partId: null, sourceRevision: null, sourceTextSha256: null, callId: null, sourceKey: "original-native-part" };
  f.journal.projectTimeline({ entryId, kind: "assistant_message", revision: "1", imageProjectionError: null, content: [{ type: "image_unavailable", imageId, label: "Native image", error: { code: "capture_pending", message: "Saving original image." } }] });
  f.journal.registerImageOccurrence(occurrence, null); f.journal.acknowledgeEvents(f.journal.getLastSourceSequence());
  f.journal.projectTimeline({ entryId: randomUUID(), kind: "assistant_message", revision: "1", content: [{ type: "text", text: "later native turn state" }] });
  const requiredSourceThrough = f.journal.getLastSourceSequence();
  const request = { captureId: randomUUID(), attemptId: randomUUID(), occurrence, nativeSource: null, locator: { kind: "local" as const, path: "/original.png", contextId: randomUUID() } };
  const capture = vi.fn();
  const bridge = createControllerCaptureBridge({ journal: f.journal, capture, beforeCapture: () => syncControllerImageHistory({ ...f, requiredSourceThrough, request: server.request }), provider: () => null, writable: () => true });
  try {
    await expect(bridge.providerOptions.prepareImageCapture!(request)).rejects.toMatchObject({ name: "ImageCaptureNotDispatchedError" });
    expect(server.rows.size).toBe(0); expect(capture).not.toHaveBeenCalled();
    expect(f.journal.hasImageHistoryCheckpoint(requiredSourceThrough)).toBe(false);
    f.journal.acknowledgeEvents(requiredSourceThrough);
    await bridge.providerOptions.prepareImageCapture!(request);
    expect(server.rows.size).toBe(1); expect(capture).not.toHaveBeenCalled();
    expect(f.journal.hasImageHistoryCheckpoint(requiredSourceThrough)).toBe(true);
    expect(JSON.parse([...server.rows.values()][0]!.bytes.toString()).entries).toEqual(expect.arrayContaining([expect.objectContaining({ entryId, content: [expect.objectContaining({ imageId })] })]));
  } finally { f.journal.close(); }
});

test("a required history checkpoint completes an older frozen upload before uploading the new image position", async () => {
  const f = await fixture(), server = receiver();
  const original = f.journal.prepareImageHistorySync()!, originalBytes = await readFile(original.filename);
  const entryId = randomUUID(), imageId = randomUUID();
  f.journal.projectTimeline({ entryId, kind: "assistant_message", revision: "1", imageProjectionError: null, content: [{ type: "image_unavailable", imageId, label: "Native image", error: { code: "capture_pending", message: "Saving original image." } }] });
  f.journal.acknowledgeEvents(f.journal.getLastSourceSequence());
  const requiredSourceThrough = f.journal.getLastSourceSequence();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let latestStarted = false, completed = false;
  const request: typeof fetch = async (url, init) => {
    if (init!.method === "PUT" && !String(url).includes(original.syncId)) { latestStarted = true; await barrier; }
    return server.request(url, init);
  };
  const work = syncControllerImageHistory({ ...f, requiredSourceThrough, request }).then(() => { completed = true; });
  try {
    await vi.waitFor(() => expect(latestStarted).toBe(true));
    expect(completed).toBe(false); expect(f.journal.hasImageHistoryCheckpoint(requiredSourceThrough)).toBe(false);
    expect(server.rows.get(original.syncId)!.bytes).toEqual(originalBytes);
    release(); await work;
    expect(server.rows.size).toBe(2); expect(f.journal.hasImageHistoryCheckpoint(requiredSourceThrough)).toBe(true);
    expect(JSON.parse([...server.rows.values()][1]!.bytes.toString()).entries).toEqual(expect.arrayContaining([expect.objectContaining({ entryId })]));
    f.journal.recordRelayHistory("next-history-epoch");
    expect(f.journal.hasImageHistoryCheckpoint(requiredSourceThrough)).toBe(false);
    await syncControllerImageHistory({ ...f, requiredSourceThrough, request: server.request });
    expect(f.journal.hasImageHistoryCheckpoint(requiredSourceThrough)).toBe(true); expect(server.rows.size).toBe(3);
  } finally { release(); await work; f.journal.close(); }
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

test("capacity retry replays the same ledger chunk and accepts an early Task body refusal", async () => {
  const f = await fixture(1, "body", "task_body"), server = receiver();
  const attempts: { url: string; headers: Headers; body: Buffer }[] = [], delays: number[] = [];
  let now = 0;
  const request: typeof fetch = async (input, init) => {
    if (init!.method === "PUT") {
      attempts.push({ url: String(input), headers: new Headers(init!.headers), body: Buffer.from(init!.body as Uint8Array) });
      if (attempts.length === 1) return Response.json({ error: { code: "resource_busy" } }, { status: 429 });
    }
    return taskBodyResponse(server, input, init);
  };
  try {
    await syncControllerImageHistory({ ...f, request, retryRuntime: { now: () => now, random: () => 0.5, wait: async ms => { delays.push(ms); now += ms; } } });
    expect(delays).toEqual([1000]); expect(attempts).toHaveLength(2);
    expect(attempts[1]!.url).toBe(attempts[0]!.url);
    expect(attempts[1]!.body).toEqual(attempts[0]!.body);
    for (const header of ["Daynight-Controller-Fence", "Daynight-File-SHA256", "Daynight-Chunk-SHA256", "Daynight-File-Byte-Length"]) expect(attempts[1]!.headers.get(header)).toBe(attempts[0]!.headers.get(header));
    expect(f.journal.hasImageHistoryCheckpoint(f.journal.getLastSourceSequence())).toBe(true);
  } finally { f.journal.close(); }
});

test("checkpoint advancement shares the retry budget while each request resets its delay", async () => {
  const f = await fixture(), server = receiver();
  const first = f.journal.prepareImageHistorySync()!;
  f.journal.projectTimeline({ entryId: randomUUID(), revision: "1", kind: "assistant_message", content: [{ type: "text", text: "later" }] });
  f.journal.acknowledgeEvents(f.journal.getLastSourceSequence());
  const delays: number[] = [], attempts = new Map<string, number>(); let now = 0;
  const request: typeof fetch = async (input, init) => {
    if (init!.method === "PUT") {
      const id = new URL(String(input)).pathname.split("/").at(-1)!;
      const count = (attempts.get(id) ?? 0) + 1; attempts.set(id, count);
      if (id === first.syncId ? count <= 3 : true) return Response.json({ error: { code: "resource_busy" } }, { status: 429 });
    }
    return server.request(input, init);
  };
  try {
    await expect(syncControllerImageHistory({ ...f, requiredSourceThrough: f.journal.getLastSourceSequence(), request, retryRuntime: { now: () => now, random: () => 0.5, wait: async ms => { delays.push(ms); now += ms; } } })).rejects.toThrow();
    expect(delays).toEqual([1000, 2000, 4000, 1000]);
    expect(attempts.get(first.syncId)).toBe(4);
    expect([...attempts.values()]).toEqual([4, 2]);
  } finally { f.journal.close(); }
});

test("cancellation or a changed fence after a capacity wait prevents another send", async () => {
  for (const mode of ["cancel", "fence"] as const) {
    const f = await fixture(), abort = new AbortController(); let calls = 0, current = f.fence;
    try {
      await expect(syncControllerImageHistory({ ...f, currentFence: () => current, signal: abort.signal,
        request: async () => { calls++; return Response.json({ error: { code: "resource_busy" } }, { status: 429 }); },
        retryRuntime: { now: () => 0, random: () => 0.5, wait: async () => { if (mode === "cancel") abort.abort(new Error("cancelled")); else current = { ...current, connectionEpoch: "2" }; } },
      })).rejects.toThrow(mode === "cancel" ? "cancelled" : "connection changed");
      expect(calls).toBe(1);
    } finally { f.journal.close(); }
  }
});

test("status capacity retry obeys the first-refusal deadline and emits safe diagnostics", async () => {
  const f = await fixture(); let now = 100, calls = 0;
  const events: unknown[] = [];
  try {
    await expect(syncControllerImageHistory({ ...f, request: async () => { calls++; return Response.json({ error: { code: "resource_busy", message: "secret" } }, { status: 429, headers: { "X-Request-ID": "secret with spaces" } }); },
      retryRuntime: { now: () => now, random: () => 0.5, wait: async () => { now += 30_000; } }, onRetry: event => events.push(event),
    })).rejects.toMatchObject({ status: 429, code: "resource_busy" });
    expect(calls).toBe(1);
    expect(events).toEqual([{ phase: "waiting", retry: 1, delayMs: 1000, classification: "resource_busy", requestId: null, sessionId: f.ticket.sessionId }, { phase: "exhausted", retry: 1, delayMs: null, classification: "resource_busy", requestId: null, sessionId: f.ticket.sessionId }]);
    expect(JSON.stringify(events)).not.toContain("secret");
  } finally { f.journal.close(); }
});

test("real HTTP ledger requests preserve their frozen identity after a capacity refusal", async () => {
  const f = await fixture(), receiverState = receiver(), puts: { url: string; hash: string | undefined; bytes: Buffer }[] = [];
  const http = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks), url = `http://127.0.0.1${req.url}`;
      if (req.method === "PUT") {
        puts.push({ url, hash: req.headers["daynight-chunk-sha256"] as string | undefined, bytes });
        if (puts.length === 1) { res.writeHead(429, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { code: "resource_busy" } })); return; }
      }
      const headers = new Headers(); for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(key, value);
      const response = await receiverState.request(url, { method: req.method!, headers, ...(req.method === "PUT" ? { body: bytes } : {}) });
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    })().catch(error => { res.writeHead(500); res.end(String(error)); });
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address(); if (!address || typeof address === "string") throw new Error("Missing test server address");
  try {
    await syncControllerImageHistory({ ...f, ticket: { ...f.ticket, serverOrigin: `http://127.0.0.1:${address.port}` }, retryRuntime: { now: () => 0, random: () => 0.5, wait: async () => {} } });
    expect(puts).toHaveLength(2); expect(puts[1]).toEqual(puts[0]);
    expect(f.journal.hasImageHistoryCheckpoint(f.journal.getLastSourceSequence())).toBe(true);
  } finally { await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())); f.journal.close(); }
});

test("an unknown PUT at the retry deadline still observes the original committed receipt", async () => {
  const f = await fixture(), server = receiver(); let now = 0, first = true;
  const request: typeof fetch = async (input, init) => {
    if (init!.method === "GET" && first) { first = false; return Response.json({ error: { code: "resource_busy" } }, { status: 429 }); }
    const response = await server.request(input, init);
    if (init!.method === "PUT") { now = 31_000; throw new Error("lost committed response"); }
    return response;
  };
  try {
    await syncControllerImageHistory({ ...f, request, retryRuntime: { now: () => now, random: () => 0.5, wait: async () => {} } });
    expect(server.calls.map(call => call.method)).toEqual(["GET", "PUT", "GET"]);
    expect(new Set(server.calls.map(call => call.id)).size).toBe(1);
    expect(f.journal.hasImageHistoryCheckpoint(f.journal.getLastSourceSequence())).toBe(true);
  } finally { f.journal.close(); }
});

test("a connection change while reading a receipt cannot publish an old checkpoint", async () => {
  const f = await fixture(), server = receiver(); let current = f.fence, release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const request: typeof fetch = async (input, init) => {
    const response = await server.request(input, init);
    if (init!.method === "PUT") {
      const original = response.json.bind(response);
      Object.defineProperty(response, "json", { value: async () => { entered(); await gate; return original(); } });
    }
    return response;
  };
  try {
    const pending = syncControllerImageHistory({ ...f, currentFence: () => current, request });
    const rejected = expect(pending).rejects.toThrow("original status observation failed");
    await waiting; current = { ...current, connectionEpoch: "2" }; release(); await rejected;
    expect(f.journal.hasImageHistoryCheckpoint(f.journal.getLastSourceSequence())).toBe(false);
  } finally { release(); f.journal.close(); }
});

test.each(["GET", "PUT"] as const)("history %s failure preserves safe diagnostics and the frozen intent without another submission", async method => {
  const f = await fixture(), calls: string[] = [];
  try {
    const intent = f.journal.prepareImageHistorySync()!;
    const request: typeof fetch = async (_input, init) => {
      calls.push(init!.method!);
      if (init!.method === "GET" && method === "PUT") return calls.length === 1 ? new Response(null, { status: 404 }) : Response.json({ syncId: intent.syncId, state: "receiving", acceptedOffset: "0", byteLength: intent.byteLength, sha256: intent.sha256, timelineRevision: null, error: null });
      return Response.json({ error: { code: "archive_conflict", requestId: "REQ_123-abc", message: "private-response-canary" } }, { status: 409 });
    };
    await expect(syncControllerImageHistory({ ...f, request })).rejects.toMatchObject({ status: 409, message: `Controller history synchronization ${method === "GET" ? "GET status" : "PUT chunk"} failed (409; code=archive_conflict; requestId=REQ_123-abc).` });
    expect(calls).toEqual(method === "GET" ? ["GET"] : ["GET", "PUT", "GET"]);
    expect(f.journal.prepareImageHistorySync()).toEqual(intent);
    expect(await readFile(intent.filename)).not.toHaveLength(0);
  } finally { f.journal.close(); }
});

test("history HTTP failure body shares caller cancellation without retrying its request", async () => {
  const f = await fixture(), abort = new AbortController(), reading = Promise.withResolvers<void>(); let calls = 0, canceled = 0;
  try {
    const request: typeof fetch = async (_input, init) => {
      calls++; expect(init!.signal).toBeInstanceOf(AbortSignal);
      return new Response(new ReadableStream<Uint8Array>({ pull() { reading.resolve(); }, cancel() { canceled++; } }), { status: 409 });
    };
    const pending = syncControllerImageHistory({ ...f, signal: abort.signal, request });
    const reason = new Error("Original caller cancelled.");
    const rejected = expect(pending).rejects.toBe(reason);
    await reading.promise; abort.abort(reason); await rejected;
    expect(calls).toBe(1); expect(canceled).toBe(1); expect(f.journal.prepareImageHistorySync()).not.toBeNull();
  } finally { f.journal.close(); }
});
