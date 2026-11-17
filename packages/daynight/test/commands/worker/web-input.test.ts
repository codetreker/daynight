import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { controllerPayloadHash, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { ControllerIpcOutcomeUnknownError, type requestController } from "../../../src/commands/controller/local-client.js";
import type { ControllerOperation, ControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import type { LocalTask } from "../../../src/commands/worker/backends/web-types.js";
import { createWebInput } from "../../../src/commands/worker/backends/web-input.js";

const fixture = (initial: ControllerSnapshot["initialInputState"] = "confirmed") => {
  const executionId = randomUUID(), sessionId = randomUUID(), nativeSessionId = randomUUID(), controllerInstanceId = randomUUID();
  const projectId = randomUUID(), taskId = randomUUID(), claimId = randomUUID(), workerId = randomUUID(), worktreeId = randomUUID(), userId = randomUUID();
  const ticket = { executionId, sessionId, controllerInstanceId, executionGeneration: "1", claimId, projectId, taskId, workerId, worktreeId, userId,
    serverOrigin: "https://daynight.test", provider: "codex", initialOperationId: randomUUID(), initialPrompt: "original assignment", ipcSecret: "secret" } as ControllerLaunchTicket;
  const task = { projectId, taskId, claimId, workerId, worktreeId, userId, serverOrigin: ticket.serverOrigin, status: "active", cleanup: null, control: null,
    configuration: { agent: "codex" }, resources: { nativeSession: { source: "controller", sessionId: nativeSessionId } },
    webExecution: { executionId, sessionId, controllerInstanceId, executionGeneration: "1" } } as unknown as LocalTask;
  const snapshot = { executionId, sessionId, controllerInstanceId, executionGeneration: "1", claimId, lifecycle: "ready", nativeSessionId,
    initialInputState: initial, activity: "idle", currentTurnId: null, capabilities: { send: true, steer: false, cancel: false, respond: false },
    nativeStopped: false, error: null, startup: { state: "ready", reasonCode: "ready" } } as ControllerSnapshot;
  const legacyAuthority = vi.fn(async () => null as "task_paused" | "claim_invalid" | null);
  const signal = new AbortController().signal;
  const input = { task, ticket, snapshot, signal, legacyAuthority, protocol: 1 as const };
  let now = 1_000, latestSnapshot = snapshot;
  const operations = new Map<string, ControllerOperation>();
  const operation = (purpose: "initial" | "worker_input", operationId: string, prompt: string, state: ControllerOperation["state"]): ControllerOperation => {
    const payload = purpose === "initial" ? { text: prompt } : { content: [{ type: "text", text: prompt }], expectedTurnId: null, origin: "daynight" };
    return { operationId, executionGeneration: "1", kind: purpose, payload, payloadHash: controllerPayloadHash({ kind: purpose, payload }), state, result: null, error: null, createdAt: now, updatedAt: now };
  };
  const request = vi.fn<typeof requestController>(async (_ticket, action) => {
    if (action.kind === "submit_initial") return { requestId: randomUUID(), ok: true, snapshot: { ...snapshot, initialInputState: "confirmed" }, operation: operation("initial", action.operationId, ticket.initialPrompt, "confirmed") };
    if (action.kind !== "submit_worker_input") throw new Error("unexpected action");
    return { requestId: randomUUID(), ok: true, snapshot, inputResult: { kind: "operation", operation: operation("worker_input", action.operationId, action.prompt, "provider_accepted") } };
  });
  const report = vi.fn(), event = vi.fn();
  const helper = createWebInput({ current: () => task, currentSnapshot: () => latestSnapshot, buildPrompt: () => "current assignment", now: () => now, request, report, event,
    readOperation: (_task, id) => operations.get(id) ?? null });
  return { task, ticket, snapshot, input, legacyAuthority, helper, request, operations, operation, report, event, setNow: (value: number) => { now = value; }, setSnapshot: (value: ControllerSnapshot) => { latestSnapshot = value; } };
};

describe("Web automatic input", () => {
  it.each(["codex", "claude", "copilot"] as const)("sends an assignment and a new ping on every unchanged idle check for %s", async provider => {
    const f = fixture(); f.task.configuration!.agent = provider; (f.ticket as { provider: string }).provider = provider;
    for (let i = 0; i < 4; i++) expect((await f.helper.step(f.input)).kind).toBe("observed");
    const actions = f.request.mock.calls.map(([, action]) => action);
    expect(actions).toHaveLength(4);
    expect(actions[0]).toMatchObject({ kind: "submit_worker_input", prompt: "current assignment" });
    for (const action of actions.slice(1)) expect(action).toMatchObject({ kind: "submit_worker_input", prompt: expect.stringContaining("periodic check") });
    expect(new Set(actions.map(action => "operationId" in action && action.operationId)).size).toBe(4);
  });

  it("uses the original initial input and does not send a second assignment", async () => {
    const f = fixture("not_submitted");
    expect((await f.helper.step(f.input)).kind).toBe("observed");
    expect(f.request.mock.calls[0]![1]).toEqual({ kind: "submit_initial", operationId: f.ticket.initialOperationId });
    expect((await f.helper.step({ ...f.input, snapshot: { ...f.snapshot, initialInputState: "confirmed" } })).kind).toBe("observed");
    expect(f.request.mock.calls[1]![1]).toMatchObject({ kind: "submit_worker_input", prompt: expect.stringContaining("periodic check") });
  });

  it("waits through busy and paused results and retries the assignment before ping", async () => {
    const f = fixture();
    expect(await f.helper.step({ ...f.input, snapshot: { ...f.snapshot, activity: "working", currentTurnId: randomUUID() } })).toMatchObject({ kind: "waiting", reason: "native_input" });
    expect(f.event).toHaveBeenCalledWith(f.task, expect.objectContaining({ operationId: null, outcome: "waiting", detail: "native_input:activity=working,send=true,turn=present" }));
    f.request.mockResolvedValueOnce({ requestId: randomUUID(), ok: true, snapshot: f.snapshot, inputResult: { kind: "waiting", reason: "task_paused" } });
    expect(await f.helper.step(f.input)).toMatchObject({ kind: "waiting", reason: "task_paused" });
    expect(f.event).toHaveBeenCalledWith(f.task, expect.objectContaining({ outcome: "waiting", detail: "task_paused" }));
    expect((await f.helper.step(f.input)).kind).toBe("observed");
    expect(f.request.mock.calls.map(([, action]) => action)).toEqual([
      expect.objectContaining({ prompt: "current assignment" }), expect.objectContaining({ prompt: "current assignment" }),
    ]);
  });

  it("waits for missing or oversized prompt data without sending", async () => {
    const f = fixture();
    const event = vi.fn();
    const options = { current: () => f.task, currentSnapshot: () => f.snapshot, now: () => 1_000,
      readOperation: () => null, request: f.request, event };
    const unavailable = createWebInput({ ...options, buildPrompt: () => "assignment", promptSource: { current: () => null } });
    expect(await unavailable.step(f.input)).toMatchObject({ kind: "waiting", reason: "prompt_unknown" });
    expect(event).toHaveBeenCalledWith(f.task, expect.objectContaining({ operationId: null, detail: "prompt_unknown" }));
    const tooLarge = createWebInput({ ...options, buildPrompt: () => "x" + "\n".repeat(3 * 1024 * 1024) });
    expect(await tooLarge.step(f.input)).toMatchObject({ kind: "waiting", reason: "prompt_too_large" });
    expect(event).toHaveBeenCalledWith(f.task, expect.objectContaining({ operationId: null, detail: "prompt_too_large" }));
    expect(f.request).not.toHaveBeenCalled();
  });

  it("reconciles the same timed-out operation without concurrent resends and resumes after terminal unknown", async () => {
    const f = fixture();
    await f.helper.step(f.input);
    f.request.mockRejectedValueOnce(new ControllerIpcOutcomeUnknownError("lost response"));
    expect(await f.helper.step(f.input)).toMatchObject({ kind: "waiting" });
    const sent = f.request.mock.calls[1]![1];
    if (sent.kind !== "submit_worker_input") throw new Error("expected worker input");
    f.operations.set(sent.operationId, f.operation("worker_input", sent.operationId, sent.prompt, "dispatching"));
    expect(await f.helper.step(f.input)).toMatchObject({ kind: "waiting" });
    expect(f.request).toHaveBeenCalledTimes(2);
    f.operations.set(sent.operationId, f.operation("worker_input", sent.operationId, sent.prompt, "unknown"));
    expect(await f.helper.step(f.input)).toMatchObject({ kind: "waiting" });
    expect(f.report).toHaveBeenCalledTimes(1);
    await f.helper.step(f.input);
    expect(f.request).toHaveBeenCalledTimes(3);
  });

  it("waits for the expired admission deadline before deciding again when the original operation is absent", async () => {
    const f = fixture();
    f.request.mockRejectedValueOnce(new ControllerIpcOutcomeUnknownError("lost response"));
    await f.helper.step(f.input);
    f.setNow(30_999);
    expect(await f.helper.step(f.input)).toMatchObject({ kind: "waiting" });
    expect(f.request).toHaveBeenCalledTimes(1);
    f.setNow(31_001);
    expect(await f.helper.step(f.input)).toMatchObject({ kind: "waiting" });
    expect(f.request).toHaveBeenCalledTimes(1);
    await f.helper.step(f.input);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.request.mock.calls[1]![1]).toMatchObject({ kind: "submit_worker_input", prompt: "current assignment" });
  });

  it("accepts a late original assignment receipt before issuing a ping", async () => {
    const f = fixture();
    f.request.mockRejectedValueOnce(new ControllerIpcOutcomeUnknownError("lost response"));
    await f.helper.step(f.input);
    const sent = f.request.mock.calls[0]![1];
    if (sent.kind !== "submit_worker_input") throw new Error("expected worker input");
    f.operations.set(sent.operationId, f.operation("worker_input", sent.operationId, sent.prompt, "provider_accepted"));
    expect(await f.helper.step(f.input)).toMatchObject({ kind: "observed" });
    expect(f.request).toHaveBeenCalledTimes(1);
    await f.helper.step(f.input);
    expect(f.request.mock.calls[1]![1]).toMatchObject({ prompt: expect.stringContaining("periodic check") });
  });

  it("keeps assignment ahead of ping after a terminal unknown outcome", async () => {
    const f = fixture();
    f.request.mockRejectedValueOnce(new ControllerIpcOutcomeUnknownError("lost response"));
    await f.helper.step(f.input);
    const sent = f.request.mock.calls[0]![1];
    if (sent.kind !== "submit_worker_input") throw new Error("expected worker input");
    f.operations.set(sent.operationId, f.operation("worker_input", sent.operationId, sent.prompt, "unknown"));
    expect(await f.helper.step(f.input)).toMatchObject({ kind: "waiting" });
    expect(f.report).toHaveBeenCalledTimes(1);
    await f.helper.step(f.input);
    expect(f.request.mock.calls[1]![1]).toMatchObject({ prompt: "current assignment" });
    expect(f.request.mock.calls[1]![1]).not.toMatchObject({ operationId: sent.operationId });
  });

  it("does not replace an in-flight call when checks overlap", async () => {
    const f = fixture(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementationOnce(async (...args) => { await gate; return original(...args); });
    const first = f.helper.step(f.input), second = f.helper.step(f.input);
    expect(first).toBe(second); expect(f.request).toHaveBeenCalledTimes(1);
    release(); await Promise.all([first, second]);
  });

  it("checks legacy authority before original initial input and before proposing an upgrade", async () => {
    const f = fixture("not_submitted"); f.legacyAuthority.mockResolvedValueOnce("task_paused");
    const legacy = { ...f.input, protocol: undefined };
    expect(await f.helper.step(legacy)).toMatchObject({ kind: "waiting", reason: "task_paused" });
    expect(f.request).not.toHaveBeenCalled();
    await f.helper.step(legacy);
    expect(f.request.mock.calls[0]![1]).toEqual({ kind: "submit_initial", operationId: f.ticket.initialOperationId });
    const resumed = { ...legacy, snapshot: { ...f.snapshot, initialInputState: "confirmed" as const } };
    f.setSnapshot(resumed.snapshot);
    expect(await f.helper.step(resumed)).toMatchObject({ kind: "upgrade" });
    f.legacyAuthority.mockResolvedValueOnce("claim_invalid");
    expect(await f.helper.confirmUpgrade(resumed)).toMatchObject({ kind: "waiting", reason: "claim_invalid" });
  });

  it("rechecks the local journal after legacy task read before sending or upgrading", async () => {
    const initial = fixture("not_submitted");
    initial.legacyAuthority.mockImplementationOnce(async () => {
      initial.setSnapshot({ ...initial.snapshot, activity: "working", currentTurnId: randomUUID() });
      return null;
    });
    expect(await initial.helper.step({ ...initial.input, protocol: undefined })).toMatchObject({ kind: "waiting", reason: "native_input" });
    expect(initial.request).not.toHaveBeenCalled();
    const resumed = fixture();
    resumed.legacyAuthority.mockImplementationOnce(async () => {
      resumed.setSnapshot({ ...resumed.snapshot, activity: "working", currentTurnId: randomUUID() });
      return null;
    });
    expect(await resumed.helper.step({ ...resumed.input, protocol: undefined })).toMatchObject({ kind: "waiting", reason: "native_input" });
  });

  it("treats a known native state race as waiting and exposes other refusals without their text", async () => {
    const f = fixture();
    const reject = (message: string) => f.request.mockImplementationOnce(async (_ticket, action) => {
      if (action.kind !== "submit_worker_input") throw new Error("unexpected");
      const op = { ...f.operation("worker_input", action.operationId, action.prompt, "rejected"), error: message };
      return { requestId: randomUUID(), ok: true, snapshot: f.snapshot, inputResult: { kind: "operation", operation: op } };
    });
    reject("Native turn changed or interaction is pending.");
    expect(await f.helper.step(f.input)).toMatchObject({ kind: "waiting", reason: "native_input" });
    reject("private prompt token=secret");
    await expect(f.helper.step(f.input)).rejects.toThrow("original assignment input was rejected");
    expect(JSON.stringify(f.event.mock.calls)).not.toContain("private prompt");
    expect(JSON.stringify(f.event.mock.calls)).not.toContain("token=secret");
    expect(f.event).toHaveBeenCalledWith(f.task, expect.objectContaining({ purpose: "assignment", outcome: "rejected", operationId: expect.any(String), executionId: f.ticket.executionId }));
  });

  it("rejects inconsistent operation identity instead of treating it as accepted", async () => {
    const f = fixture();
    f.request.mockImplementationOnce(async (_ticket, action) => {
      if (action.kind !== "submit_worker_input") throw new Error("unexpected");
      const op = f.operation("worker_input", action.operationId, "other content", "confirmed");
      return { requestId: randomUUID(), ok: true, snapshot: f.snapshot, inputResult: { kind: "operation", operation: op } };
    });
    await expect(f.helper.step(f.input)).rejects.toThrow("conflicts");
  });
});
