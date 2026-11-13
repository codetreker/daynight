import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistantTaskSessionTransport } from "../../../../src/commands/worker/bots/assistant-task-session.js";
import type { BotDefinition, BotRecord } from "../../../../src/commands/worker/bots/types.js";
import { SESSION_PROTOCOL, type SessionCommand, type SessionOperation, type SessionSnapshot } from "../../../../src/session/protocol.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = { serverOrigin: "https://daynight.example", ownerUserId: id(1), workerId: id(2) };
const signal = () => new AbortController().signal;
const command = (): SessionCommand => ({ protocol: SESSION_PROTOCOL, sessionId: id(4), testExecutionId: id(5), executionGeneration: "1", operationId: id(10), requestId: id(10), kind: "send_message", payload: { origin: "daynight", expectedTurnId: null, content: [{ type: "text", text: "Daynight notification" }] } });
const receipt = (): SessionOperation => ({ protocol: SESSION_PROTOCOL, sessionId: id(4), testExecutionId: id(5), executionGeneration: "1", operationId: id(10), kind: "send_message", state: "confirmed", providerResult: "started", error: null });
const operationUrl = `/api/v1/test-sessions/${id(4)}/operations/${id(10)}`;
const fixture = () => {
  const bot: BotDefinition = { id: id(3), ownerUserId: id(1), workerId: id(2), version: "2", deletion: null, name: "Assistant", creationOrder: "1", requestedOverrides: {}, resolvedConfiguration: { workerId: id(2), cwd: "/ordinary", provider: "codex", model: null, args: [] }, roleConfiguration: null, sessionId: id(4), testExecutionId: id(5), startupResult: { state: "ready", code: null }, createdAt: "2026-11-04T00:00:00Z", updatedAt: "2026-11-04T00:00:00Z" };
  const record: BotRecord = { owner, botId: id(3), observed: bot, definition: bot, observedAt: 1, intent: { botVersion: "1", registration: { protocol: SESSION_PROTOCOL, schemaVersion: 1, projectionVersion: 1, registrationId: id(6), testExecutionId: id(5), controllerId: id(7), controllerInstanceId: id(8), provider: "codex", initialInput: "none" }, controllerInstanceId: id(8), launchId: id(9), executionId: id(5), initialOperationId: id(10), sessionId: id(4), executionGeneration: "1", nativeSessionId: null, ticketPath: "/private/ticket.json", journalPath: "/private/journal.sqlite", credentialFile: "/private/credential.json", recoveryLimit: 3, roleConfiguration: null } };
  const snapshot: SessionSnapshot = { protocol: SESSION_PROTOCOL, schemaVersion: 1, projectionVersion: 1, sessionId: id(4), testExecutionId: id(5), executionGeneration: "1", connectionEpoch: "2", identity: { ownerUserId: id(1), controllerId: id(7), controllerInstanceId: id(8), agentControlMode: "web", provider: "codex", nativeSessionId: null }, sessionRevision: "3", historyEpoch: id(12), lastEventSeq: "1", lastTimelineSeq: "0", initialInputState: "not_required", synchronized: true, lifecycle: "active", connectionState: "connected", activity: "idle", currentTurnId: null, capabilities: { send: true, steer: false, cancel: false, respond: true }, operations: { canSend: true, canCancel: false, canRespond: true } };
  const response = (value: unknown = { operation: receipt(), operationUrl }, status = 202, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "Daynight-User-ID": owner.ownerUserId, location: operationUrl, ...headers } });
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
  const readSession = vi.fn(async () => snapshot);
  const transport = createAssistantTaskSessionTransport({ owner, serverToken: "fixture-secret", sessionApi: { readSession }, fetch });
  return { record, snapshot, response, fetch, readSession, transport };
};
afterEach(() => vi.useRealTimers());

describe("assistant-task Session transport", () => {
  it("sends the original Daynight input once after idle preflight, including a new native Session", async () => {
    const f = fixture(), input = command();
    expect(await f.transport.send(f.record, input, signal())).toEqual(receipt());
    expect(f.readSession).toHaveBeenCalledOnce(); expect(f.fetch).toHaveBeenCalledOnce();
    const [url, init] = f.fetch.mock.calls[0]!;
    expect(url).toBe(`${owner.serverOrigin}/api/v1/test-sessions/${id(4)}/commands`);
    expect(init).toMatchObject({ method: "POST", redirect: "manual", headers: { authorization: "Bearer fixture-secret" } });
    expect(JSON.parse(init!.body as string)).toEqual(input);
    expect(input.kind === "send_message" && input.payload.origin).toBe("daynight");
  });

  it.each(["busy", "turn", "disconnected", "unsynchronized", "archived", "no-send", "generation", "session", "preflight-error"])("does not submit when preflight reports %s", async condition => {
    const f = fixture();
    const patch: Partial<Pick<SessionSnapshot, "activity" | "currentTurnId" | "connectionState" | "synchronized" | "lifecycle" | "operations" | "executionGeneration" | "sessionId">> = condition === "busy" ? { activity: "working" } : condition === "turn" ? { currentTurnId: "turn" } : condition === "disconnected" ? { connectionState: "disconnected" } : condition === "unsynchronized" ? { synchronized: false } : condition === "archived" ? { lifecycle: "archived" } : condition === "no-send" ? { operations: { canSend: false, canCancel: false, canRespond: false } } : condition === "generation" ? { executionGeneration: "2" } : { sessionId: id(90) };
    f.readSession.mockResolvedValue({ ...f.snapshot, ...patch });
    if (condition === "preflight-error") f.readSession.mockRejectedValue(new Error("unavailable"));
    await expect(f.transport.send(f.record, command(), signal())).rejects.toMatchObject({ outcomeUnconfirmed: false });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each(["owner", "worker", "bot", "session", "execution", "generation", "origin", "turn", "kind"])("refuses a command with conflicting %s before preflight", async mismatch => {
    const f = fixture(), input = command();
    if (mismatch === "owner") f.record.owner = { ...owner, ownerUserId: id(90) };
    if (mismatch === "worker") f.record.owner = { ...owner, workerId: id(90) };
    if (mismatch === "bot") f.record.botId = id(90);
    const changed = mismatch === "session" ? { ...input, sessionId: id(90) } : mismatch === "execution" ? { ...input, testExecutionId: id(90) } : mismatch === "generation" ? { ...input, executionGeneration: "2" } : mismatch === "origin" ? { ...input, payload: { ...input.payload, origin: "user" } } : mismatch === "turn" ? { ...input, payload: { ...input.payload, expectedTurnId: "turn" } } : mismatch === "kind" ? { ...input, kind: "cancel", payload: { expectedTurnId: "turn" } } : input;
    await expect(f.transport.send(f.record, changed as SessionCommand, signal())).rejects.toMatchObject({ outcomeUnconfirmed: false });
    expect(f.readSession).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each(["sessionId", "testExecutionId", "executionGeneration", "operationId", "kind", "principal", "location", "url", "token", "json", "size"])("retains unknown submission when response %s conflicts", async mismatch => {
    const f = fixture(); let value: unknown = { operation: receipt(), operationUrl };
    if (["sessionId", "testExecutionId", "operationId"].includes(mismatch)) value = { operation: { ...receipt(), [mismatch]: id(90) }, operationUrl };
    if (mismatch === "executionGeneration") value = { operation: { ...receipt(), executionGeneration: "2" }, operationUrl };
    if (mismatch === "kind") value = { operation: { ...receipt(), kind: "cancel" }, operationUrl };
    if (mismatch === "url") value = { operation: receipt(), operationUrl: "/another" };
    if (mismatch === "token") value = { operation: { ...receipt(), error: { code: "provider_error", message: "fixture-secret" } }, operationUrl };
    if (mismatch === "size") value = { large: "x".repeat(65_536) };
    f.fetch.mockResolvedValue(mismatch === "json" ? new Response("broken", { status: 202, headers: { "content-type": "application/json", "Daynight-User-ID": id(1) } }) : f.response(value, 202, mismatch === "principal" ? { "Daynight-User-ID": id(90) } : mismatch === "location" ? { location: "/another" } : {}));
    await expect(f.transport.send(f.record, command(), signal())).rejects.toMatchObject({ outcomeUnconfirmed: true });
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("queries the original operation after an uncertain send without another POST, including after recovery", async () => {
    const f = fixture(); f.fetch.mockRejectedValueOnce(new Error("fixture-secret must not escape"));
    await expect(f.transport.send(f.record, command(), signal())).rejects.toMatchObject({ outcomeUnconfirmed: true, message: expect.not.stringContaining("fixture-secret") });
    f.record.intent!.executionGeneration = "2";
    f.fetch.mockResolvedValue(f.response({ operation: receipt() }, 200));
    expect(await f.transport.readOperation(f.record, command(), signal())).toEqual(receipt());
    expect(f.fetch.mock.calls.map(([, request]) => request!.method)).toEqual(["POST", "GET"]);
    expect(f.fetch.mock.calls[1]![0]).toBe(`${owner.serverOrigin}${operationUrl}`);
    expect(f.readSession).toHaveBeenCalledOnce();
  });

  it.each([400, 409, 500])("distinguishes confirmed refusal from ambiguous HTTP %s", async status => {
    const f = fixture(); f.fetch.mockResolvedValue(f.response({ error: { code: "stale_turn", message: "Changed", requestId: id(20) } }, status));
    await expect(f.transport.send(f.record, command(), signal())).rejects.toMatchObject({ outcomeUnconfirmed: status >= 500, code: "stale_turn", status });
    expect(f.fetch).toHaveBeenCalledOnce();
  });


  it.each([
    [409, "session_conflict"], [503, "controller_offline"], [429, "rate_limited"], [401, "unauthenticated"],
  ] as const)("recognizes the service's pre-dispatch refusal HTTP %s %s without retrying", async (status, code) => {
    const f = fixture();
    f.fetch.mockResolvedValue(f.response({ error: { code, message: "Operation admission refused", requestId: id(20) } }, status));
    await expect(f.transport.send(f.record, command(), signal())).rejects.toMatchObject({ outcomeUnconfirmed: false, code, status });
    expect(f.readSession).toHaveBeenCalledOnce();
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.fetch.mock.calls[0]![1]!.method).toBe("POST");
  });

  it.each([
    [503, "write_outcome_unknown"], [503, "session_conflict"], [500, "controller_offline"], [500, "rate_limited"],
  ] as const)("retains uncertain dispatch for HTTP %s %s outside the confirmed refusal contract", async (status, code) => {
    const f = fixture();
    f.fetch.mockResolvedValue(f.response({ error: { code, message: "Unknown outcome", requestId: id(20) } }, status));
    await expect(f.transport.send(f.record, command(), signal())).rejects.toMatchObject({ outcomeUnconfirmed: true, status });
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("bounds an unresponsive dispatched request and never retries", async () => {
    vi.useFakeTimers(); const f = fixture(); f.fetch.mockImplementation(() => new Promise(() => {}));
    const pending = f.transport.send(f.record, command(), signal());
    const result = expect(pending).rejects.toMatchObject({ outcomeUnconfirmed: true, code: "request_cancelled" });
    await vi.advanceTimersByTimeAsync(10_000); await result;
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("cancels a response body read without losing submission uncertainty", async () => {
    const f = fixture(), controller = new AbortController(); let reading!: () => void;
    const started = new Promise<void>(resolve => { reading = resolve; });
    f.fetch.mockResolvedValue(new Response(new ReadableStream({ pull() { reading(); return new Promise(() => {}); } }), { status: 202, headers: { "content-type": "application/json", "Daynight-User-ID": id(1), location: operationUrl } }));
    const pending = f.transport.send(f.record, command(), controller.signal);
    const result = expect(pending).rejects.toMatchObject({ outcomeUnconfirmed: true });
    await started; controller.abort(); await result; expect(f.fetch).toHaveBeenCalledOnce();
  });
});
