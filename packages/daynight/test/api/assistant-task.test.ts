import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation, type Operation } from "../../src/api/operation.js";
import { AssistantTaskApiError, assistantTaskClaimFingerprint, createAssistantTaskClient, parseAssistantTask, parseAssistantTaskClaimResult, parseAssistantTaskPage, parseAssistantTaskManual, parseAssistantTaskAppendix, parseAssistantTaskProposal, parseAssistantTaskItem, parseAssistantTaskRecord, parseAssistantTaskEvent, parseAssistantTaskInquiry } from "../../src/api/assistant-task.js";
import { ProtocolError } from "../../src/api/validation.js";
const owner = "11111111-1111-4111-8111-111111111111", taskId = "22222222-2222-4222-8222-222222222222", operationId = "33333333-3333-4333-8333-333333333333", botId = "44444444-4444-4444-8444-444444444444", other = "55555555-5555-4555-8555-555555555555";
const now = "2026-11-13T10:00:00.123456Z", until = "2026-11-13T10:05:00.123456Z";
const claimToken = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64url");
const claimInput = { operationId, ifVersion: "7", expectedGeneration: "0", claimToken };
const unowned = { holderBotId: null, credentialOperationId: null, claimGeneration: "0", claimState: "unowned", claimedAt: null, renewedAt: null, leaseUntil: null, observedAt: now };
const active = { holderBotId: botId, credentialOperationId: operationId, claimGeneration: "1", claimState: "active", claimedAt: now, renewedAt: now, leaseUntil: until, observedAt: now };
const task = { id: taskId, ownerUserId: owner, application: "", name: "Watch", purpose: "Observe", scope: "Builds", kind: "continuous", state: "active", takeover: "manual", trigger: null, version: "9223372036854775807", manualVersion: "1", ...unowned, createdAt: now, updatedAt: now };
const receipt = { operation: { operationId, kind: "claim", taskId, actorBotId: botId, requestFingerprint: "5844a794f76443253acfeef7df9dd7b04929a37c3494def4f557dd8b33141048", admittedAt: now, resultingVersion: "8", resultingGeneration: "1", holderBotId: botId, credentialOperationId: operationId, leaseUntil: until }, currentClaim: active };
const manual = { taskId, version: "1", body: "Instructions", rules: {}, source: "initial", proposalId: null, createdAt: now };
const appendix = { id: operationId, taskId, text: "Experience", sourceRecords: [], authorBotId: botId, state: "active", version: "1", createdAt: now, updatedAt: now };
const proposal = { id: operationId, taskId, baseVersion: "1", body: "Instructions", rules: {}, reason: "Evidence", evidenceRecords: [], authorBotId: botId, widens: false, status: "pending", decisionNote: "", createdAt: now, decidedAt: null };
const item = { id: operationId, taskId, key: "build/1", episode: "1", state: "open", category: "build", followerBotId: botId, appState: {}, version: "1", createdAt: now, updatedAt: now };
const record = { id: operationId, taskId, itemId: null, author: "bot", authorBotId: botId, kind: "fact", text: "Build failed", refs: {}, createdAt: now };
const event = { id: operationId, taskId, targetBotId: botId, type: "inquiry", payload: {}, state: "pending", attention: true, createdAt: now, deliveredAt: null, seenAt: null, ackOperationId: null };
const inquiry = { id: operationId, taskId, itemId: null, fromBotId: other, toBotId: botId, answerBotId: null, question: "Why?", answer: "", state: "open", createdAt: now, deadline: until, answeredAt: null };
const response = (value: unknown, status = 200, principal: string | null = owner) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...(principal === null ? {} : { "Daynight-User-ID": principal }) } });
const operations: Operation[] = [];
afterEach(() => { operations.splice(0).forEach(o => o.dispose()); vi.restoreAllMocks(); });
const setup = (fetch: typeof globalThis.fetch, limits = {}) => {
  const operation = createOperation({ limits }); operations.push(operation);
  return createAssistantTaskClient({ serverUrl: "http://localhost:3000", serverToken: "dnpat_fixture", expectedUserId: owner, botId, operation, fetch });
};

describe("assistant task response contracts", () => {
  it("preserves int64 strings and validates scope, claim state and microsecond timestamps", () => {
    expect(parseAssistantTask(task, taskId, owner)).toEqual(task);
    expect(() => parseAssistantTask(task, other, owner)).toThrow(ProtocolError);
    expect(() => parseAssistantTask(task, taskId, other)).toThrow(ProtocolError);
    for (const patch of [{ version: 7 }, { version: "01" }, { version: "9223372036854775808" }, { id: "00000000-0000-0000-0000-000000000000" }, { claimToken }, { state: "unknown" }, { claimState: "active" }, { createdAt: "2026-02-30T00:00:00Z" }, { claimGeneration: "-1" }]) expect(() => parseAssistantTask({ ...task, ...patch })).toThrow(ProtocolError);
    expect(parseAssistantTask({ ...task, ...active, leaseUntil: "2026-11-13T10:00:00.123457Z" }).claimState).toBe("active");
    expect(() => parseAssistantTask({ ...task, ...active, leaseUntil: now })).toThrow(ProtocolError);
  });
  it("constructs the cross-language fingerprint vector from request fields and raw token bytes", () => {
    expect(assistantTaskClaimFingerprint({ ...claimInput, kind: "claim", ownerUserId: owner, taskId, actorBotId: botId })).toBe(receipt.operation.requestFingerprint);
    expect(() => assistantTaskClaimFingerprint({ ...claimInput, claimToken: `${claimToken}=`, kind: "claim", ownerUserId: owner, taskId, actorBotId: botId })).toThrow(ProtocolError);
  });
  it("binds historical receipts to original operation intent independently of current ownership", () => {
    expect(parseAssistantTaskClaimResult(receipt, taskId, operationId, { kind: "claim", actorBotId: botId, requestFingerprint: receipt.operation.requestFingerprint })).toEqual(receipt);
    const expired = { ...receipt, currentClaim: { ...active, claimState: "expired", holderBotId: other } };
    expect(parseAssistantTaskClaimResult(expired, taskId, operationId).currentClaim.holderBotId).toBe(other);
    for (const patch of [{ operationId: other }, { taskId: other }, { credentialOperationId: other }, { resultingVersion: 8 }]) expect(() => parseAssistantTaskClaimResult({ ...receipt, operation: { ...receipt.operation, ...patch } }, taskId, operationId)).toThrow(ProtocolError);
    expect(() => parseAssistantTaskClaimResult(receipt, taskId, operationId, { requestFingerprint: "0".repeat(64) })).toThrow(ProtocolError);
  });
  it.each([
    [manual, parseAssistantTaskManual], [appendix, parseAssistantTaskAppendix], [proposal, parseAssistantTaskProposal], [item, parseAssistantTaskItem], [record, parseAssistantTaskRecord], [event, parseAssistantTaskEvent], [inquiry, parseAssistantTaskInquiry],
  ] as const)("checks required resource fields and owner task %#", (resource, parser) => {
    expect(parser(resource, taskId)).toEqual(resource);
    expect(() => parser(resource, other)).toThrow(ProtocolError);
    expect(() => parser({ ...resource, claimToken }, taskId)).toThrow(ProtocolError);
    for (const key of Object.keys(resource)) expect(() => parser(Object.fromEntries(Object.entries(resource).filter(([k]) => k !== key)), taskId)).toThrow(ProtocolError);
  });
  it("validates every page before exposure, rejects duplicate identities and preserves explicit cursors", () => {
    const page = { items: [task], nextCursor: "opaque+cursor", observedAt: now };
    expect(parseAssistantTaskPage(page, v => parseAssistantTask(v, undefined, owner))).toEqual(page);
    expect(() => parseAssistantTaskPage({ ...page, items: [task, task] }, parseAssistantTask)).toThrow(ProtocolError);
    expect(() => parseAssistantTaskPage({ ...page, nextCursor: "" }, parseAssistantTask)).toThrow(ProtocolError);
  });
});

describe("assistant task HTTP client", () => {
  it("confirms deleted task tombstones and preserves the later 410 refusal", async () => {
    const deleted = { ...task, state: "deleted", name: "", purpose: "", scope: "", manualVersion: "0", claimGeneration: "2" };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(deleted)).mockResolvedValueOnce(response({ error: { code: "task_deleted", message: "Deleted", requestId: operationId } }, 410));
    const client = setup(fetch);
    expect(await client.deleteTask(taskId, "7")).toEqual(deleted);
    await expect(client.getTask(taskId)).rejects.toMatchObject({ status: 410, code: "task_deleted", outcomeUnconfirmed: false });
    expect(fetch.mock.calls.map(call => call[1]?.method)).toEqual(["DELETE", "GET"]);
    expect(() => parseAssistantTask({ ...deleted, state: "active" })).toThrow(ProtocolError);
    expect(() => parseAssistantTask({ ...deleted, name: "Retained content" })).toThrow(ProtocolError);
    expect(() => parseAssistantTask({ ...deleted, manualVersion: "1" })).toThrow(ProtocolError);
  });
  it("confirms deleted appendix tombstones and reads them in a page", async () => {
    const deleted = { ...appendix, state: "deleted", text: "", sourceRecords: [] };
    const page = { items: [deleted], nextCursor: null, observedAt: now };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(deleted)).mockResolvedValueOnce(response(page));
    const client = setup(fetch);
    expect(await client.deleteAppendix(taskId, operationId, "7")).toEqual(deleted);
    expect(await client.listAppendix(taskId)).toEqual(page);
    expect(() => parseAssistantTaskAppendix({ ...deleted, state: "active" }, taskId)).toThrow(ProtocolError);
    expect(() => parseAssistantTaskAppendix({ ...deleted, sourceRecords: [other] }, taskId)).toThrow(ProtocolError);
  });
  it("sends explicit Bot identity, exact versions and a secret only in the claim body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(receipt));
    const client = setup(fetch);
    expect(await client.claim(taskId, "claim", claimInput)).toEqual(receipt);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`http://localhost:3000/api/v1/assistant-tasks/${taskId}/claim`);
    expect(init?.headers).toMatchObject({ "X-Daynight-Bot-Id": botId, Authorization: "Bearer dnpat_fixture" });
    expect(init?.redirect).toBe("manual");
    expect(JSON.parse(init?.body as string)).toEqual(claimInput);
    expect(JSON.stringify(init?.headers)).not.toContain(claimToken);
  });
  it("reads pages with encoded cursors without hidden pagination or writes", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ items: [task], nextCursor: "next", observedAt: now }));
    expect((await setup(fetch).listTasks({ limit: 200, cursor: "a+b&c", targetBotId: botId })).items).toEqual([task]);
    expect(String(fetch.mock.calls[0]![0])).toContain("cursor=a%2Bb%26c");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("reads the original operation without replaying and checks its fingerprint", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(receipt));
    await setup(fetch).getClaimOperation(taskId, operationId, { requestFingerprint: receipt.operation.requestFingerprint });
    expect(String(fetch.mock.calls[0]![0])).toContain(`/claim-operations/${operationId}`);
    expect(fetch.mock.calls[0]![1]?.method).toBe("GET");
  });
  it("reports safe claim conflict details while excluding arbitrary server messages", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ error: { code: "claim_held", message: "Do not repeat this raw text", requestId: operationId, details: { holderBotId: other, claimGeneration: "9", leaseUntil: until } } }, 409));
    const error = await setup(fetch).claim(taskId, "claim", claimInput).catch(e => e) as AssistantTaskApiError;
    expect(error).toMatchObject({ code: "claim_held", confirmedRefusal: true, outcomeUnconfirmed: false, details: { holderBotId: other } });
    expect(error.message).toContain(other);
    expect(error.message).not.toContain("raw text");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["transport", "malformed", "principal", "secret-echo", "unknown", "redirect"])("does not replay unknown %s writes or expose token-bearing causes", async kind => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    if (kind === "transport") fetch.mockRejectedValue(new Error(claimToken, { cause: new Error("dnpat_fixture") }));
    else if (kind === "malformed") fetch.mockResolvedValue(response({ ...receipt, claimToken }));
    else if (kind === "principal") fetch.mockResolvedValue(response(receipt, 200, other));
    else if (kind === "secret-echo") fetch.mockResolvedValue(response({ error: { code: "invalid_input", message: claimToken, requestId: operationId } }, 400));
    else if (kind === "redirect") fetch.mockResolvedValue(new Response(null, { status: 307, headers: { Location: `https://example.test/${claimToken}` } }));
    else fetch.mockResolvedValue(response({ error: { code: "claim_outcome_unknown", message: "Unknown", requestId: operationId } }, 503));
    const error = await setup(fetch).claim(taskId, "claim", claimInput).catch(e => e) as AssistantTaskApiError;
    expect(error).toBeInstanceOf(AssistantTaskApiError);
    expect(error.outcomeUnconfirmed).toBe(true);
    expect(error.message).not.toContain(claimToken);
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(claimToken);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("bounds an uncooperative fetch and retains unknown dispatched outcomes", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise(() => {}));
    const error = await setup(fetch, { requestMs: 20 }).claim(taskId, "claim", claimInput).catch(e => e) as AssistantTaskApiError;
    expect(error).toMatchObject({ outcomeUnconfirmed: true, code: "request_cancelled" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects oversized and duplicate-field responses before returning a resource", async () => {
    const duplicate = JSON.stringify(task).replace('"version":', '"version":"1","version":');
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(duplicate, { headers: { "Content-Type": "application/json", "Daynight-User-ID": owner } }));
    await expect(setup(fetch).getTask(taskId)).rejects.toMatchObject({ code: "invalid_response", outcomeUnconfirmed: false });
    const large = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(task));
    await expect(setup(large, { responseBytes: 16 }).getTask(taskId)).rejects.toMatchObject({ code: "response_limit" });
  });
  it("rejects nonlocal HTTP credential transport without dispatch", () => {
    const operation = createOperation(); operations.push(operation);
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(() => createAssistantTaskClient({ serverUrl: "http://example.test", serverToken: "dnpat_fixture", expectedUserId: owner, operation, fetch })).toThrow("HTTPS");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("assistant task resource routing", () => {
  const credential = { claimToken, claimGeneration: "1" };
  const create = { id: taskId, name: "Watch", purpose: "Observe", scope: "Builds", kind: "continuous" as const, takeover: "manual" as const, manual: { body: "Instructions", rules: {} } };
  type Client = ReturnType<typeof createAssistantTaskClient>;
  const cases: { name: string; invoke: (api: Client) => Promise<unknown>; path: string; method: string; value: unknown; body?: unknown }[] = [
    { name: "create", invoke: a => a.createTask(create), path: "/assistant-tasks", method: "POST", body: create, value: task },
    { name: "update", invoke: a => a.updateTask(taskId, { ifVersion: "9007199254740993", state: "paused" }), path: `/assistant-tasks/${taskId}`, method: "PATCH", body: { ifVersion: "9007199254740993", state: "paused" }, value: { ...task, state: "paused" } },
    { name: "delete", invoke: a => a.deleteTask(taskId, "8"), path: `/assistant-tasks/${taskId}`, method: "DELETE", body: { ifVersion: "8" }, value: { ...task, state: "deleted", name: "", purpose: "", scope: "", manualVersion: "0", claimGeneration: "2" } },
    { name: "manual", invoke: a => a.getManual(taskId, "1"), path: `/assistant-tasks/${taskId}/manual/versions/1`, method: "GET", value: manual },
    { name: "rollback", invoke: a => a.rollback(taskId, { ifVersion: "8", manualVersion: "1" }), path: `/assistant-tasks/${taskId}/manual/rollback`, method: "POST", body: { ifVersion: "8", manualVersion: "1" }, value: manual },
    { name: "appendix", invoke: a => a.addAppendix(taskId, { ...credential, id: operationId, text: "Experience", sourceRecords: [] }), path: `/assistant-tasks/${taskId}/appendix`, method: "POST", body: { ...credential, id: operationId, text: "Experience", sourceRecords: [] }, value: appendix },
    { name: "edit appendix", invoke: a => a.updateAppendix(taskId, operationId, { ifVersion: "1", text: "Experience", sourceRecords: [] }), path: `/assistant-tasks/${taskId}/appendix/${operationId}`, method: "PATCH", body: { ifVersion: "1", text: "Experience", sourceRecords: [] }, value: appendix },
    { name: "delete appendix", invoke: a => a.deleteAppendix(taskId, operationId, "1"), path: `/assistant-tasks/${taskId}/appendix/${operationId}`, method: "DELETE", body: { ifVersion: "1" }, value: appendix },
    { name: "propose", invoke: a => a.propose(taskId, { ...credential, id: operationId, baseVersion: "1", body: "Instructions", rules: {}, reason: "Evidence", evidenceRecords: [] }), path: `/assistant-tasks/${taskId}/proposals`, method: "POST", body: { ...credential, id: operationId, baseVersion: "1", body: "Instructions", rules: {}, reason: "Evidence", evidenceRecords: [] }, value: { proposal, rejectedMatches: [] } },
    { name: "decide", invoke: a => a.decide(taskId, operationId, { ifVersion: "1", decision: "rejected" }), path: `/assistant-tasks/${taskId}/proposals/${operationId}/decision`, method: "POST", body: { ifVersion: "1", decision: "rejected" }, value: proposal },
    { name: "item show", invoke: a => a.getItem(taskId, operationId), path: `/assistant-tasks/${taskId}/items/${operationId}`, method: "GET", value: item },
    { name: "item save", invoke: a => a.saveItem(taskId, { ...credential, id: operationId, key: "build/1", episode: "1", state: "open", category: "build", appState: {} }), path: `/assistant-tasks/${taskId}/items`, method: "POST", body: { ...credential, id: operationId, key: "build/1", episode: "1", state: "open", category: "build", appState: {} }, value: item },
    { name: "item update", invoke: a => a.saveItem(taskId, { ...credential, ifVersion: "1", key: "build/1", episode: "1", state: "closed", category: "build", appState: {} }, operationId), path: `/assistant-tasks/${taskId}/items/${operationId}`, method: "PATCH", body: { ...credential, ifVersion: "1", key: "build/1", episode: "1", state: "closed", category: "build", appState: {} }, value: item },
    { name: "record", invoke: a => a.addRecord(taskId, { ...credential, id: operationId, kind: "fact", text: "Build failed", refs: {} }), path: `/assistant-tasks/${taskId}/records`, method: "POST", body: { ...credential, id: operationId, kind: "fact", text: "Build failed", refs: {} }, value: record },
    { name: "event", invoke: a => a.addEvent(taskId, { ...credential, id: operationId, targetBotId: botId, type: "inquiry", payload: {} }), path: `/assistant-tasks/${taskId}/events`, method: "POST", body: { ...credential, id: operationId, targetBotId: botId, type: "inquiry", payload: {} }, value: event },
    { name: "ack", invoke: a => a.ackEvent(taskId, operationId, { operationId: other, state: "delivered" }), path: `/assistant-tasks/${taskId}/events/${operationId}/ack`, method: "POST", body: { operationId: other, state: "delivered" }, value: { ...event, ackOperationId: other, state: "delivered", deliveredAt: now } },
    { name: "attention", invoke: a => a.clearAttention(botId), path: "/assistant-task-events/attention", method: "POST", body: { targetBotId: botId }, value: { targetBotId: botId } },
    { name: "ask", invoke: a => a.ask(taskId, { id: operationId, question: "Why?" }), path: `/assistant-tasks/${taskId}/inquiries`, method: "POST", body: { id: operationId, question: "Why?" }, value: inquiry },
    { name: "answer", invoke: a => a.answer(taskId, operationId, { ...credential, answer: "Known cause" }), path: `/assistant-tasks/${taskId}/inquiries/${operationId}/answer`, method: "POST", body: { ...credential, answer: "Known cause" }, value: { ...inquiry, state: "answered", answer: "Known cause", answerBotId: botId, answeredAt: now } },
  ];
  it.each(cases)("routes $name to its typed resource", async ({ invoke, path, method, value, body }) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(value));
    expect(await invoke(setup(fetch))).toEqual(value);
    expect(String(fetch.mock.calls[0]![0])).toBe(`http://localhost:3000/api/v1${path}`);
    const init = fetch.mock.calls[0]![1]!;
    expect(init.method).toBe(method);
    expect(init.body === undefined ? undefined : JSON.parse(init.body as string)).toEqual(body);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["manual/versions", manual, (a: Client) => a.listManuals(taskId)],
    ["appendix", appendix, (a: Client) => a.listAppendix(taskId)],
    ["proposals", proposal, (a: Client) => a.listProposals(taskId)],
    ["items", item, (a: Client) => a.listItems(taskId)],
    ["records", record, (a: Client) => a.listRecords(taskId)],
    ["events", event, (a: Client) => a.listEvents(taskId)],
    ["inquiries", inquiry, (a: Client) => a.listInquiries(taskId)],
  ] as const)("reads the %s collection", async (path, value, invoke) => {
    const page = { items: [value], nextCursor: null, observedAt: now };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(page));
    expect(await invoke(setup(fetch))).toEqual(page);
    expect(String(fetch.mock.calls[0]![0])).toBe(`http://localhost:3000/api/v1/assistant-tasks/${taskId}/${path}`);
    expect(fetch.mock.calls[0]![1]?.method).toBe("GET");
  });
});

describe("assistant task application JSON", () => {
  const applicationData = { version: 3, nested: [{ version: 4, fraction: 0.125, negative: -12, zero: 0 }], maximum: Number.MAX_SAFE_INTEGER };
  it.each([
    ["rules", { ...manual, rules: applicationData }, (api: ReturnType<typeof createAssistantTaskClient>) => api.getManual(taskId)],
    ["appState", { ...item, appState: applicationData }, (api: ReturnType<typeof createAssistantTaskClient>) => api.getItem(taskId, operationId)],
    ["refs", { items: [{ ...record, refs: applicationData }], nextCursor: null, observedAt: now }, (api: ReturnType<typeof createAssistantTaskClient>) => api.listRecords(taskId)],
    ["payload", { items: [{ ...event, payload: applicationData }], nextCursor: null, observedAt: now }, (api: ReturnType<typeof createAssistantTaskClient>) => api.listEvents(taskId)],
  ] as const)("keeps numeric version keys in %s as serializable JSON numbers", async (_field, value, read) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(value));
    const resource = await read(setup(fetch));
    expect(resource).toEqual(value);
    expect(JSON.stringify(resource)).toBe(JSON.stringify(value));
  });
  it.each(["9007199254740993", "-9007199254740993", "1e400"])("rejects unrepresentable application number %s without returning rounded data", async numeric => {
    const source = JSON.stringify({ ...item, appState: { version: "replace" } }).replace('"replace"', numeric);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(source, { headers: { "Content-Type": "application/json", "Daynight-User-ID": owner } }));
    await expect(setup(fetch).getItem(taskId, operationId)).rejects.toMatchObject({ code: "invalid_response", outcomeUnconfirmed: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects numeric application bigint inputs at the parser and preserves string resource versions", () => {
    expect(() => parseAssistantTaskItem({ ...item, appState: { version: 3n } }, taskId)).toThrow(ProtocolError);
    expect(() => parseAssistantTaskItem({ ...item, appState: { count: Number.MAX_SAFE_INTEGER + 1 } }, taskId)).toThrow(ProtocolError);
    expect(parseAssistantTaskItem({ ...item, version: "9007199254740993", appState: applicationData }, taskId).version).toBe("9007199254740993");
  });
});

describe("assistant task request JSON numbers", () => {
  it.each([Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])("rejects %s before dispatch instead of rounding or replacing with null", async value => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(setup(fetch).addRecord(taskId, { id: operationId, kind: "note", text: "Observation", refs: { value } })).rejects.toMatchObject({ outcomeUnconfirmed: false });
    expect(fetch).not.toHaveBeenCalled();
  });
});
