import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import { createControllerRelay } from "../../../src/commands/controller/relay.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { RELAY_LIMITS, parseControllerMessage, type SourceTimelineEntry } from "../../../src/session/controller-protocol.js";
import { canonicalHistoryJSON } from "../../../src/session/history.js";
import snapshotFixture from "../../session/fixtures/snapshot.json" with { type: "json" };

it("keeps body history, online tools and approval identity across real relay reconnection and source-floor hydration", async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/controller-tests"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "task-body-relay-"));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("headers", headers => headers.push("Daynight-Task-Body-History-Version: 1"));
  await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test relay address");
  const ticket: ControllerLaunchTicket = {
    schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: `http://127.0.0.1:${address.port}`,
    projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "Initial input", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString(),
  };
  await writeFile(ticket.credentialFile, JSON.stringify({ token: "local-test-token", expiresAt: new Date(Date.now() + 60_000).toISOString(), sessionId: ticket.sessionId, claimId: ticket.claimId, executionGeneration: ticket.executionGeneration, controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId }), { mode: 0o600 });
  const file = path.join(home, "journal.sqlite"), journal = openControllerLifecycleStore(file, ticket, { historyPolicy: "task_body", contentOwnedLocally: true, maxOutboxBytes: 512 });
  const callId = randomUUID(), approvalId = randomUUID(), bodyId = randomUUID(), nativeSessionId = randomUUID();
  const call = (text: string): Extract<SourceTimelineEntry, { kind: "tool_call" }> => ({ entryId: callId, revision: "1", kind: "tool_call", callId: "tool-call", name: "shell", input: "command", output: [{ type: "text", text }], status: "running", truncated: false });
  const body = (entryId: string, text: string): SourceTimelineEntry => ({ entryId, revision: "1", kind: "assistant_message", content: [{ type: "text", text }] });
  const errors: unknown[] = [], onCommand = vi.fn(async () => {});
  const frames: ReturnType<typeof parseControllerMessage>[][] = [], sockets: WebSocket[] = [], epochs: string[] = [];
  let relay: ReturnType<typeof createControllerRelay> | undefined, acknowledged = "0", eventSequence = 0n;
  const fence = (index: number) => ({ protocol: "daynight.session.v1", sessionId: ticket.sessionId, claimId: ticket.claimId, executionGeneration: "1", connectionEpoch: String(index + 1) });
  server.on("connection", (socket, request) => {
    const index = frames.length, received: ReturnType<typeof parseControllerMessage>[] = [], historyEpoch = randomUUID();
    frames.push(received); sockets.push(socket); epochs.push(historyEpoch);
    expect(request.headers["daynight-task-body-history-version"]).toBe("1");
    socket.on("message", raw => {
      try {
        const message = parseControllerMessage(JSON.parse(raw.toString())); received.push(message);
        if (message.type === "hello") {
          if (BigInt(message.sourceFloor ?? "0") > BigInt(acknowledged)) acknowledged = message.sourceFloor!;
          const session = { ...snapshotFixture, ...fence(index), historyEpoch, lastEventSeq: String(eventSequence), lastTimelineSeq: "0", identity: { ...snapshotFixture.identity, projectId: ticket.projectId, taskId: ticket.taskId, workerId: ticket.workerId, worktreeId: ticket.worktreeId, controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId, nativeSessionId } };
          socket.send(JSON.stringify({ type: "welcome", protocol: "daynight.session.v1", connectionEpoch: String(index + 1), session, lastAckedSourceSeq: acknowledged, limits: RELAY_LIMITS, requiresLiveSync: true }));
        } else if (message.type === "reconcile") socket.send(JSON.stringify({ ...fence(index), type: "reconcile_result", operations: [] }));
        else if (message.type === "events") {
          expect(BigInt(message.events[0]!.sourceSeq)).toBe(BigInt(acknowledged) + 1n);
          acknowledged = message.events.at(-1)!.sourceSeq; eventSequence += BigInt(message.events.length);
          socket.send(JSON.stringify({ ...fence(index), type: "events_ack", sourceEpoch: message.sourceEpoch, batchId: message.batchId, lastAckedSourceSeq: acknowledged, lastEventSeq: String(eventSequence) }));
        } else if (message.type === "sync_state") socket.send(JSON.stringify({ ...fence(index), type: "sync_ack" }));
      } catch (error) { errors.push(error); }
    });
  });
  const requestPage = async (index: number) => {
    const requestId = randomUUID();
    sockets[index]!.send(JSON.stringify({ ...fence(index), type: "content_request", requestId, kind: "timeline", historyEpoch: epochs[index], direction: "tail", cursor: null, limit: 100 }));
    await vi.waitFor(() => expect(frames[index]!.some(message => message.type === "content_response" && message.requestId === requestId)).toBe(true), { timeout: 5000 });
    const response = frames[index]!.find(message => message.type === "content_response" && message.requestId === requestId)!;
    if (response.type !== "content_response" || response.result?.kind !== "timeline") throw new Error("Missing timeline response");
    return response.result.items;
  };
  const requestContent = async (query: Record<string, unknown>) => {
    const requestId = randomUUID(), index = 1;
    sockets[index]!.send(JSON.stringify({ ...fence(index), type: "content_request", requestId, historyEpoch: epochs[index], ...query }));
    await vi.waitFor(() => expect(frames[index]!.some(message => message.type === "content_response" && message.requestId === requestId)).toBe(true), { timeout: 5000 });
    const response = frames[index]!.find(message => message.type === "content_response" && message.requestId === requestId)!;
    if (response.type !== "content_response" || !response.result) throw new Error("Missing inspection content response");
    return response.result;
  };
  try {
    journal.patchSnapshot({ nativeSessionId, initialInputState: "confirmed", activity: "idle", capabilities: { send: true, steer: false, cancel: false, respond: true } });
    const operation = journal.prepareOperation({ operationId: randomUUID(), kind: "send_message", payload: { text: "original input" } });
    journal.markDispatching(operation.operationId); journal.recordOperation(operation.operationId, "unknown");
    journal.projectTimeline(call("tool-only initial"));
    journal.projectTimeline({ entryId: approvalId, revision: "1", kind: "interaction", interaction: { interactionId: randomUUID(), revision: "1", kind: "approval", state: "pending", title: "Approval", detail: "original command", actions: ["allow_once", "reject"] } });
    journal.projectTimeline(body(bodyId, "retained body before reconnect"));
    journal.projectTimeline(call(`tool-only revised ${"x".repeat(600)}`));
    expect(BigInt(journal.getSourceFloor())).toBeGreaterThan(0n);
    relay = createControllerRelay(ticket, journal, { onConnection() {}, onCommand, onError: error => errors.push(error) });
    await vi.waitFor(() => expect(relay!.connected()).toBe(true), { timeout: 5000 });
    const initial = await requestPage(0);
    expect(initial.map(entry => entry.entryId)).toEqual([callId, approvalId, bodyId]);
    expect(initial[0]).toMatchObject({ kind: "tool_call", entrySeq: "1", revision: "2" });
    expect(frames[0]!.find(message => message.type === "sync_state")).toMatchObject({ pendingInteractions: [{ entryId: approvalId }] });
    expect(frames[0]!.find(message => message.type === "reconcile")).toMatchObject({ operations: [{ operationId: operation.operationId, state: "unknown" }] });
    const closed = once(sockets[0]!, "close"); sockets[0]!.close(); await closed;
    const offlineBodyId = randomUUID(); journal.projectTimeline(body(offlineBodyId, "body during disconnect"));
    journal.projectTimeline(call(`tool-only latest ${"y".repeat(600)}`));
    await vi.waitFor(() => expect(frames.length === 2 && relay!.connected()).toBe(true), { timeout: 5000 });
    const after = await requestPage(1);
    expect(after.map(entry => entry.entryId)).toEqual([callId, approvalId, bodyId, offlineBodyId]);
    expect(after[0]).toMatchObject({ entrySeq: "1", revision: "3", output: [{ type: "text", text: `tool-only latest ${"y".repeat(600)}` }] });
    expect(frames[1]!.find(message => message.type === "sync_state")).toMatchObject({ pendingInteractions: [{ entryId: approvalId }] });
    expect(frames[1]!.find(message => message.type === "reconcile")).toMatchObject({ operations: [{ operationId: operation.operationId, state: "unknown" }] });
    const finalBodyId = randomUUID(), appended = journal.projectTimeline(body(finalBodyId, "body after reconnect"))!;
    await vi.waitFor(() => expect(journal.getLastAcknowledgedSequence()).toBe(appended.sequence), { timeout: 5000 });
    expect(journal.pendingEvents()).toEqual([]); expect(onCommand).not.toHaveBeenCalled();
    expect(journal.getOperation(operation.operationId)?.state).toBe("unknown");
    const reader = new Database(file, { readonly: true });
    try {
      const history = reader.prepare("SELECT id,kind,value FROM timeline_entries ORDER BY entry_seq").all() as { id: string; kind: string; value: string }[];
      expect(history.map(row => row.id)).toEqual([bodyId, offlineBodyId, finalBodyId]);
      expect(history.every(row => row.kind === "assistant_message" && !row.value.includes("tool-only"))).toBe(true);
      expect(reader.prepare("SELECT COUNT(*) AS count FROM online_entries").get()).toEqual({ count: 2 });
    } finally { reader.close(); }
    journal.projectTimeline({ ...call(""), output: Array.from({ length: 1001 }, (_, index) => ({ type: "text" as const, text: `tool part ${index} 😀` })) });
    await vi.waitFor(() => expect(journal.getLastAcknowledgedSequence()).toBe(journal.getLastSourceSequence()), { timeout: 5000 });
    const inspection = await requestContent({ kind: "inspect_page", cursor: null, limit: 100, responseOverhead: 4096 });
    if (inspection.kind !== "inspect_page") throw new Error("Missing inspection page");
    const item = inspection.items.find(item => item.entryId === callId)!;
    expect(item.body).toBeNull(); expect(item.contentRef).not.toBeNull();
    let cursor = item.contentRef!.cursor, complete = "";
    for (;;) {
      const chunk = await requestContent({ kind: "entry_chunk", cursor, limit: 8192 });
      if (chunk.kind !== "entry_chunk") throw new Error("Missing entry chunk");
      complete += chunk.fragment;
      if (chunk.eof) break;
      cursor = chunk.nextCursor!;
    }
    expect(complete).toBe(canonicalHistoryJSON(journal.getTimelineEntry(callId)));
    expect(JSON.parse(complete).output).toHaveLength(1001);
    expect(createHash("sha256").update(complete).digest("hex")).toBe(item.contentRef!.sha256);
    expect(String(Buffer.byteLength(complete))).toBe(item.contentRef!.byteLength);
    expect((await requestContent({ kind: "inspect_page", cursor: null, limit: 100, responseOverhead: 4096 })).kind).toBe("inspect_page");
    expect(relay.connected()).toBe(true); expect(frames).toHaveLength(2);
    expect(errors).toEqual([]);
  } finally {
    relay?.close(); journal.close(); for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
