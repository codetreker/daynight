import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { readPublishedBotHistoryPage, type PublishedBotHistory } from "../../../src/commands/controller/bot-history-relay.js";
import { type ControllerLaunchTicket, isBotHistoryTicket, parseLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import type { ControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import { createControllerRelay } from "../../../src/commands/controller/relay.js";
import { sessionWireBytes } from "../../../src/commands/controller/wire-display.js";
import { botHistoryWindowEntryDigest, parseBotHistoryCheckpoint, type BotHistoryCheckpoint, type BotHistoryWindowBoundary, type BotHistoryWindowEntry } from "../../../src/session/bot-history-window.js";
import { parseControllerMessage, RELAY_LIMITS, type ContentResponse } from "../../../src/session/controller-protocol.js";
import { HISTORY_RESPONSE_BYTES } from "../../../src/session/history.js";
import { SESSION_PROTOCOL } from "../../../src/session/protocol.js";
import snapshotFixture from "../../session/fixtures/snapshot.json" with { type: "json" };

const preview = (seq: string, text = `Preview ${seq}`): BotHistoryWindowEntry => ({
  entryId: randomUUID(), entrySeq: seq, revision: "1", kind: "assistant_message", preview: text,
  previewBytes: String(Buffer.byteLength(text)), originalBytes: String(Buffer.byteLength(text)), truncated: false,
  omissionReason: null, omittedEntryCount: 0, resourceIds: [], tool: null,
});

const cursor = (boundary: BotHistoryWindowBoundary, mode: "before" | "changes", seq: string): string => Buffer.from(JSON.stringify([
  "bot_history_window", boundary.sessionId, boundary.testExecutionId, boundary.executionGeneration, boundary.connectionEpoch,
  boundary.historyEpoch, boundary.windowRevision, mode, seq, boundary.throughSeq ?? "0",
])).toString("base64url");

it("keeps the requested suffix or prefix within the Go wire budget and detects evicted cursors", () => {
  const entries = Array.from({ length: 10 }, (_, index) => preview(String(index + 3), "\u2028".repeat(9000)));
  const boundary: BotHistoryWindowBoundary = {
    sessionId: randomUUID(), testExecutionId: randomUUID(), executionGeneration: "2", connectionEpoch: "3", historyEpoch: randomUUID(),
    botHistoryWindowVersion: 1, windowRevision: "2", retainedFromSeq: "3", throughSeq: "12", earlierHistoryUnavailable: true,
  };
  const window: PublishedBotHistory = { boundary, sourceThrough: "8", entries, checkpointEntries: [] };
  const request = { kind: "bot_history_window" as const, historyEpoch: boundary.historyEpoch, limit: 50, responseOverhead: 4096 };
  const tail = readPublishedBotHistoryPage(window, { ...request, mode: "tail", cursor: null });
  expect(tail.items.map(entry => entry.entrySeq)).toEqual(["9", "10", "11", "12"]);
  expect(sessionWireBytes(tail) + request.responseOverhead).toBeLessThanOrEqual(HISTORY_RESPONSE_BYTES);
  const before = readPublishedBotHistoryPage(window, { ...request, mode: "before", cursor: cursor(boundary, "before", "9") });
  expect(before.items.map(entry => entry.entrySeq)).toEqual(["5", "6", "7", "8"]);
  const changes = readPublishedBotHistoryPage(window, { ...request, mode: "changes", cursor: cursor({ ...boundary, windowRevision: "1" }, "changes", "0") });
  expect(changes.items.map(entry => entry.entrySeq)).toEqual(["3", "4", "5", "6"]);
  expect(readPublishedBotHistoryPage(window, { ...request, mode: "changes", cursor: cursor(boundary, "changes", "0") }).items).toEqual([]);
  expect(() => readPublishedBotHistoryPage(window, { ...request, mode: "before", cursor: cursor(boundary, "before", "3") })).toThrowError(expect.objectContaining({ code: "reset_required" }));
  expect(() => readPublishedBotHistoryPage(window, { ...request, mode: "changes", cursor: cursor({ ...boundary, windowRevision: "1" }, "changes", "7") })).toThrowError(expect.objectContaining({ code: "reset_required" }));
});

it.each(["negotiated", "unsupported"] as const)("fences Bot history reads and checkpoint publication over the %s service", async mode => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/controller-tests");
  await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "bot-history-relay-"));
  const http = createServer(), ws = new WebSocketServer({ server: http });
  const errors: unknown[] = [];
  const checkpoints: BotHistoryCheckpoint[] = [], responses: ContentResponse[] = [];
  let relay: ReturnType<typeof createControllerRelay> | undefined;
  let socket: WebSocket | undefined;
  const retirement = vi.fn();
  try {
    http.listen(0, "127.0.0.1");
    await once(http, "listening", { signal: AbortSignal.timeout(3000) });
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("Missing test relay address.");
    const executionId = randomUUID();
    const ticket: ControllerLaunchTicket = {
      schemaVersion: 1, launchId: randomUUID(), executionId, testExecutionId: executionId, botId: randomUUID(), ownerUserId: randomUUID(),
      controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1",
      serverOrigin: `http://127.0.0.1:${address.port}`, provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"),
      configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 },
      initialInput: "none", initialOperationId: randomUUID(), initialPrompt: "", resumeNativeSessionId: null,
      credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString(),
    };
    expect(isBotHistoryTicket(parseLaunchTicket(ticket))).toBe(true);
    expect(() => parseLaunchTicket({ ...ticket, usageScope: "standalone_test" })).toThrow("Controller usage scope is invalid.");
    expect(() => parseLaunchTicket({ ...ticket, codexBotRecovery: { botId: randomUUID(), directory: home } })).toThrow("Codex recovery belongs to another Bot.");
    await writeFile(ticket.credentialFile, JSON.stringify({ token: "local-test-token", expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sessionId: ticket.sessionId, testExecutionId: executionId, executionGeneration: ticket.executionGeneration, controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId }), { mode: 0o600 });
    const historyEpoch = randomUUID();
    const withResource = (sequence: string): BotHistoryWindowEntry => ({ ...preview(sequence), resourceIds: [randomUUID()] });
    const first = withResource("1"), second = withResource("2"), third = withResource("3");
    const entries = [first, second, third];
    const { claimId: _claimId, identity: _identity, ...baseSnapshot } = snapshotFixture;
    const fence = { protocol: SESSION_PROTOCOL, sessionId: ticket.sessionId, testExecutionId: executionId, executionGeneration: "1", connectionEpoch: "1" };
    const session = { ...baseSnapshot, ...fence, historyEpoch, lastEventSeq: "0", lastTimelineSeq: "0", initialInputState: "not_required",
      identity: { ownerUserId: ticket.ownerUserId, controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId, agentControlMode: "web", provider: "codex", nativeSessionId: "native-test" } };
    let ack = "0", localSequence = "0", sentReconciliation = false, firstReceiptSent = false;
    const releaseFirstReceipt = Promise.withResolvers<void>();
    const localEntry = () => entries[Number(localSequence)]!;
    const journal = {
      getLastAcknowledgedSequence: () => ack, getLastSourceSequence: () => localSequence, acknowledgeEvents: (value: string) => { ack = value; },
      listUnacknowledgedOperations: () => [], getSnapshot: () => ({ ...session, nativeSessionId: "native-test" }),
      pendingInteractions: () => [], drainProjectionGap: () => {}, bindSourceWire: (event: unknown) => event,
      pendingEvents: () => {
        if (ack === localSequence) return [];
        const { entryId, entrySeq, revision, kind, preview } = localEntry();
        return [{ sequence: localSequence, payload: { kind: "timeline_upsert", payload: { entryId, entrySeq, revision, kind, content: [{ type: "text", text: preview }] } } }];
      },
      getBotHistoryWindowRevision: () => localEntry().entrySeq,
      readBotHistoryWindow: () => ({ windowRevision: localEntry().entrySeq, retainedFromSeq: localEntry().entrySeq,
        throughSeq: localEntry().entrySeq, earlierHistoryUnavailable: localSequence !== "0", entries: [{ entry: localEntry(), imageOccurrences: [] }] }),
      retireBotHistoryResources: retirement,
    } as unknown as ControllerLifecycleStore;
    http.on("request", (request, response) => void (async () => {
      expect(request.url).toBe(`/api/v1/test-sessions/${ticket.sessionId}/bot-history-window/checkpoint`);
      expect(request.method).toBe("PUT");
      expect(request.headers.authorization).toBe("Bearer local-test-token");
      expect(request.headers["daynight-session-protocol"]).toBe(SESSION_PROTOCOL);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const checkpoint = parseBotHistoryCheckpoint(JSON.parse(Buffer.concat(chunks).toString()));
      expect(checkpoint.sourceEpoch).toBe(executionId);
      expect(checkpoint.sourceThrough).toBe(ack);
      expect(checkpoint.historyEpoch).toBe(historyEpoch);
      expect(checkpoint.entries[0]!.sha256).toBe(await botHistoryWindowEntryDigest(entries[Number(checkpoint.sourceThrough)]!));
      checkpoints.push(checkpoint);
      const { entries: _entries, ...boundary } = checkpoint;
      if (checkpoint.sourceThrough === "0") { await releaseFirstReceipt.promise; firstReceiptSent = true; }
      response.writeHead(200, { "Content-Type": "application/json", "Daynight-Bot-History-Window-Version": "1" });
      response.end(JSON.stringify({ ...boundary, cleanupPending: false }));
    })().catch(error => { errors.push(error); response.destroy(); }));
    ws.on("connection", connection => {
      socket = connection;
      connection.on("message", raw => {
        try {
          const message = parseControllerMessage(JSON.parse(raw.toString()));
          switch (message.type) {
            case "hello":
              expect(message.botHistoryWindowVersion).toBe(1);
              connection.send(JSON.stringify({ type: "welcome", protocol: SESSION_PROTOCOL, connectionEpoch: "1", session, lastAckedSourceSeq: ack,
                limits: RELAY_LIMITS, requiresLiveSync: true, ...(mode === "negotiated" ? { botHistoryWindowVersion: 1 } : {}) }));
              break;
            case "reconcile": sentReconciliation = true; connection.send(JSON.stringify({ ...fence, type: "reconcile_result", operations: [] })); break;
            case "sync_state": connection.send(JSON.stringify({ ...fence, type: "sync_ack" })); break;
            case "events":
              expect(firstReceiptSent).toBe(true);
              if (message.events.at(-1)!.sourceSeq === "1") localSequence = "2";
              connection.send(JSON.stringify({ ...fence, type: "events_ack", sourceEpoch: message.sourceEpoch, batchId: message.batchId,
                lastAckedSourceSeq: message.events.at(-1)!.sourceSeq, lastEventSeq: message.events.at(-1)!.sourceSeq })); break;
            case "content_response": responses.push(message); break;
          }
        } catch (error) { errors.push(error); }
      });
    });
    relay = createControllerRelay(ticket, journal, { onConnection() {}, onCommand: async () => { throw new Error("Unexpected native dispatch."); }, onError: error => errors.push(error) });
    if (mode === "unsupported") {
      await vi.waitFor(() => expect(errors.map(String)).toEqual([expect.stringContaining("upgrade_required")]));
      expect(relay.connected()).toBe(false);
      expect(sentReconciliation).toBe(false);
      expect(checkpoints).toEqual([]);
      return;
    }
    await vi.waitFor(() => expect(checkpoints).toHaveLength(1));
    const sendRead = (query: Record<string, unknown>) => {
      const requestId = randomUUID();
      socket!.send(JSON.stringify({ ...fence, type: "content_request", requestId, historyEpoch, limit: 50, ...query }));
      return requestId;
    };
    const oldPage = sendRead({ kind: "bot_history_window", mode: "tail", cursor: null, responseOverhead: 4096 });
    localSequence = "1";
    expect(retirement).not.toHaveBeenCalled();
    releaseFirstReceipt.resolve();
    await vi.waitFor(() => expect(responses.find(response => response.requestId === oldPage)).toMatchObject({ sourceThrough: "0", result: { windowRevision: "1", items: [first] } }));
    await vi.waitFor(() => expect(retirement).toHaveBeenCalledTimes(3), { timeout: 3000 });
    expect(checkpoints.map(checkpoint => [checkpoint.sourceThrough, checkpoint.retainedFromSeq])).toEqual([["0", "1"], ["1", "2"], ["2", "3"]]);
    expect(retirement.mock.calls.map(([references]) => references)).toEqual(entries.map(entry => new Set(entry.resourceIds)));
    const stale = sendRead({ kind: "bot_history_window", mode: "changes", cursor: cursor(checkpoints[0]!, "changes", "0"), responseOverhead: 4096 });
    const latest = sendRead({ kind: "bot_history_window", mode: "tail", cursor: null, responseOverhead: 4096 });
    const legacy = sendRead({ kind: "timeline", direction: "tail", cursor: null });
    await vi.waitFor(() => expect(responses).toHaveLength(4));
    expect(responses.find(response => response.requestId === stale)).toMatchObject({ sourceThrough: "2", result: null, error: { code: "reset_required" } });
    expect(responses.find(response => response.requestId === latest)).toMatchObject({ sourceThrough: "2", result: { windowRevision: "3", items: [third], earlierHistoryUnavailable: true } });
    expect(responses.find(response => response.requestId === legacy)).toMatchObject({ result: null, error: { code: "upgrade_required" } });
    expect(errors).toEqual([]);
  } finally {
    await relay?.close();
    for (const client of ws.clients) client.terminate();
    await new Promise<void>(resolve => ws.close(() => resolve()));
    http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(home, { recursive: true });
  }
});
