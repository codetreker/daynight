import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { ProviderOptions } from "../../../src/commands/controller/providers/types.js";
import type { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import snapshotFixture from "../../session/fixtures/snapshot.json" with { type: "json" };

const fixture = vi.hoisted(() => ({ journal: null as ReturnType<typeof openControllerLifecycleStore> | null, options: null as ProviderOptions | null }));
vi.mock("node:net", async importOriginal => {
  const net = await importOriginal<typeof import("node:net")>();
  const relative = (endpoint: string) => process.platform === "win32" ? endpoint : path.relative(process.cwd(), endpoint);
  return { ...net, createServer: (handler: (socket: import("node:net").Socket) => void) => {
    const server = net.createServer(handler), listen = server.listen.bind(server);
    server.listen = ((endpoint: string, callback: () => void) => listen(relative(endpoint), callback)) as typeof server.listen;
    return server;
  } };
});
vi.mock("../../../src/commands/controller/process-proof.js", () => ({ captureControllerProcessProof: async () => ({ pid: 1, parentPid: 0, processGroupId: 1, startedAt: "fixture", commandHash: "fixture" }) }));
vi.mock("../../../src/commands/controller/lifecycle-store.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../../src/commands/controller/lifecycle-store.js")>();
  return { ...original, openControllerLifecycleStore: (...args: Parameters<typeof original.openControllerLifecycleStore>) => fixture.journal = original.openControllerLifecycleStore(...args) };
});
vi.mock("../../../src/commands/controller/providers/codex.js", () => ({ openCodexProvider: async (options: ProviderOptions) => {
  fixture.options = options;
  options.onState({ nativeSessionId: randomUUID(), activity: "idle", currentTurnId: null, capabilities: { send: true, steer: false, cancel: false, respond: false } });
  options.onTimeline({ entryId: randomUUID(), revision: "1", kind: "assistant_message", content: [{ type: "text", text: "history for media checkpoint" }] });
  return { nativeSessionId: randomUUID(), close: async () => {} };
} }));
import { runController } from "../../../src/commands/controller/runtime.js";
import { writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { RELAY_LIMITS, parseControllerMessage } from "../../../src/session/controller-protocol.js";

test("media prepare deadline releases blocks while the real history round retries and finishes", async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "history-media-"));
  const release = Promise.withResolvers<void>();
  const requests: { method: string; id: string; offset: string | null; fence: string | undefined; hash?: string }[] = [];
  const errors: unknown[] = [];
  let row: { bytes: Buffer; length: string; sha256: string } | undefined, first = true;
  const http = createServer((req, res) => {
    void (async () => {
      res.setHeader("Daynight-Task-Body-History-Version", "1");
      const url = new URL(req.url!, "http://fixture"), parts = url.pathname.split("/");
      const id = parts.at(-1) === "status" ? parts.at(-2)! : parts.at(-1)!;
      if (!url.pathname.includes("/image-history-ledger/")) throw new Error(`Unexpected HTTP request ${url.pathname}`);
      requests.push({ method: req.method!, id, offset: url.searchParams.get("offset"), fence: req.headers["daynight-controller-fence"] as string | undefined, ...(typeof req.headers["daynight-file-sha256"] === "string" ? { hash: req.headers["daynight-file-sha256"] } : {}) });
      if (req.method === "GET" && first) {
        first = false; await release.promise;
        res.writeHead(429, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: "resource_busy", message: "busy" } })); return;
      }
      if (req.method === "GET" && !row) { res.writeHead(404); res.end(); return; }
      if (req.method === "PUT") {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks), sha256 = String(req.headers["daynight-file-sha256"]), length = String(req.headers["daynight-file-byte-length"]);
        expect(url.searchParams.get("offset")).toBe("0"); expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
        row = { bytes, sha256, length };
      }
      if (!row) throw new Error("Missing uploaded history");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ syncId: id, state: "complete", acceptedOffset: String(row.bytes.length), byteLength: row.length, sha256: row.sha256, timelineRevision: "1", error: null }));
    })().catch(error => { errors.push(error); res.writeHead(500); res.end(); });
  });
  const ws = new WebSocketServer({ server: http });
  ws.on("headers", headers => headers.push("Daynight-Task-Body-History-Version: 1"));
  let running: Promise<void> | undefined;
  const deadlines: { handle: NodeJS.Timeout; fire: () => void; delay: number }[] = [];
  const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
  let restoreTimers = () => {};
  try {
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  const address = http.address(); if (!address || typeof address === "string") throw new Error("Missing test address");
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: `http://127.0.0.1:${address.port}`, projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: process.cwd(), nativeHome: path.join(home, "native"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "fixture", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: process.platform === "win32" ? String.raw`\\.\pipe\daynight-history-${randomUUID()}` : path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  await writeFile(ticket.credentialFile, JSON.stringify({ token: "fixture-token", expiresAt: new Date(Date.now() + 60_000).toISOString(), sessionId: ticket.sessionId, claimId: ticket.claimId, executionGeneration: ticket.executionGeneration, controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId }), { mode: 0o600 });
  await writeLaunchTicket(home, ticket);
  const fence = { protocol: "daynight.session.v1", sessionId: ticket.sessionId, claimId: ticket.claimId, executionGeneration: "1", connectionEpoch: "1" };
  const frames: ReturnType<typeof parseControllerMessage>[] = []; let socket: WebSocket | undefined;
  ws.on("connection", client => {
    socket = client;
    client.on("message", raw => {
      try {
        const message = parseControllerMessage(JSON.parse(raw.toString())); frames.push(message);
        if (message.type === "hello") {
          const session = { ...snapshotFixture, ...fence, contentRevision: 2, historyEpoch: randomUUID(), identity: { ...snapshotFixture.identity, projectId: ticket.projectId, taskId: ticket.taskId, workerId: ticket.workerId, worktreeId: ticket.worktreeId, controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId }, imageBudget: { revision: "1", maxBytes: "0", committedBytes: "0", reservedBytes: "0", maxResources: 0, committedResources: 0, reservedResources: 0 }, capabilities: { ...snapshotFixture.capabilities, images: { revision: "1", providerRevision: "1", expectedNativeSessionId: null, modelId: null, controlsRevision: null, send: "unsupported", steer: "unsupported", reasonCode: "profile_disabled", inputMediaTypes: [], maxImageBytes: "0", maxMessageImageBytes: "0", maxImagesPerMessage: 0, geometry: { version: 1, known: false, maxWidth: 0, maxHeight: 0, maxPixels: 0, maxFrames: 0 } } } };
          client.send(JSON.stringify({ type: "welcome", protocol: fence.protocol, connectionEpoch: "1", session, lastAckedSourceSeq: "0", limits: RELAY_LIMITS }));
        } else if (message.type === "reconcile") client.send(JSON.stringify({ ...fence, type: "reconcile_result", operations: [] }));
        else if (message.type === "events") client.send(JSON.stringify({ ...fence, type: "events_ack", sourceEpoch: message.sourceEpoch, batchId: message.batchId, lastAckedSourceSeq: message.events.at(-1)!.sourceSeq, lastEventSeq: message.events.at(-1)!.sourceSeq }));
      } catch (error) { errors.push(error); }
    });
  });
  running = runController({ homeDirectory: home, provider: "codex", launchId: ticket.launchId });
  void running.catch(error => errors.push(error));
    await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 10_000 });
    const journal = fixture.journal!; expect(journal).not.toBeNull();
    const media = journal.media(), prepare = vi.spyOn(media, "prepare");
    const ids = [randomUUID(), randomUUID()];
    // Keep socket, retry and polling timers real. Only hold the named history
    // deadline callback; the two registrations follow WebSocket request order.
    // Fix the clock briefly so each registered delay proves the full deadline.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const timerSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      const handle = realSetTimeout(callback, delay, ...args);
      if (String(callback).includes("Image capture history checkpoint was not ready before the deadline.")) {
        deadlines.push({ handle, delay: delay!, fire: () => callback(...args) });
      }
      return handle;
    }) as typeof setTimeout);
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    restoreTimers = () => { nowSpy.mockRestore(); timerSpy.mockRestore(); clearSpy.mockRestore(); deadlines.forEach(deadline => realClearTimeout(deadline.handle)); restoreTimers = () => {}; };
    for (const requestId of ids) {
      const spec = { uploadId: randomUUID(), imageId: randomUUID(), target: { serverOrigin: ticket.serverOrigin, actorUserId: ticket.userId, fence: { sessionId: ticket.sessionId, claimId: ticket.claimId, executionGeneration: ticket.executionGeneration }, expectedNativeSessionId: null }, name: "original.png", mediaType: "image/png", byteLength: "1", sha256: "a".repeat(64) };
      socket!.send(JSON.stringify({ ...fence, type: "image_request", requestId, action: "prepare", body: spec }));
    }
    await vi.waitFor(() => { const lease = media.tryAcquireMediaBlock(); lease?.close(); expect(lease).toBeNull(); });
    await vi.waitFor(() => expect(deadlines).toHaveLength(2));
    expect(deadlines.map(deadline => deadline.delay)).toEqual([10_000, 10_000]);
    expect(new Set(deadlines.map(deadline => deadline.handle)).size).toBe(2);
    expect(deadlines.every(deadline => !clearSpy.mock.calls.some(([handle]) => handle === deadline.handle))).toBe(true);
    expect(frames.filter(frame => frame.type === "image_response")).toHaveLength(0);
    expect(prepare).not.toHaveBeenCalled();
    realClearTimeout(deadlines[0]!.handle); deadlines[0]!.fire();
    await vi.waitFor(() => expect(frames.filter(frame => frame.type === "image_response")).toHaveLength(1));
    expect(frames.filter(frame => frame.type === "image_response")[0]).toMatchObject({ requestId: ids[0], error: { code: "image_unavailable" } });
    expect(prepare).not.toHaveBeenCalled();
    expect(clearSpy.mock.calls.some(([handle]) => handle === deadlines[1]!.handle)).toBe(false);
    realClearTimeout(deadlines[1]!.handle); deadlines[1]!.fire();
    await vi.waitFor(() => expect(frames.filter(frame => frame.type === "image_response").length).toBe(2));
    expect(deadlines.every(deadline => clearSpy.mock.calls.some(([handle]) => handle === deadline.handle))).toBe(true);
    restoreTimers();
    const responses = frames.filter(frame => frame.type === "image_response");
    expect(new Set(responses.map(frame => frame.requestId))).toEqual(new Set(ids));
    expect(responses.every(frame => frame.error?.code === "image_unavailable")).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
    const leases = [media.tryAcquireMediaBlock(), media.tryAcquireMediaBlock()];
    try { expect(leases.every(Boolean)).toBe(true); } finally { leases.forEach(lease => lease?.close()); }
    expect(requests).toHaveLength(1);
    release.resolve();
    await vi.waitFor(() => expect(journal.hasImageHistoryCheckpoint(journal.getLastSourceSequence())).toBe(true), { timeout: 5000 });
    expect(requests.map(request => request.method)).toEqual(["GET", "GET", "PUT"]);
    expect(new Set(requests.map(request => request.id)).size).toBe(1);
    expect(requests.map(request => JSON.parse(request.fence!))).toEqual(Array(3).fill({ sessionId: ticket.sessionId, claimId: ticket.claimId, executionGeneration: "1", connectionEpoch: "1" }));
    expect(requests.at(-1)!.hash).toBe(row!.sha256);
    expect(prepare).not.toHaveBeenCalled(); expect(frames.filter(frame => frame.type === "image_response")).toHaveLength(2); expect(errors).toEqual([]);
  } finally {
    restoreTimers();
    release.resolve(); if (running) { process.emit("SIGTERM", "SIGTERM"); await running.catch(() => {}); }
    for (const client of ws.clients) client.terminate();
    await new Promise<void>(resolve => ws.close(() => resolve()));
    if (http.listening) await new Promise<void>(resolve => http.close(() => resolve()));
    fixture.journal = null; fixture.options = null; await rm(home, { recursive: true, force: true });
  }
}, 45_000);
