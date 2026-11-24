import { describe, expect, it, vi } from "vitest";
import { lifecycleAssistantApi, withLifecycleProducer, withLifecycleReservation, withWorkerLifecycle, type LifecycleContext } from "../../../src/commands/worker/lifecycle-context.js";
import { assistantTaskClaimFingerprint } from "../../../src/api/assistant-task-parse.js";

const userId = "11111111-1111-4111-8111-111111111111", workerId = "22222222-2222-4222-8222-222222222222", operationId = "33333333-3333-4333-8333-333333333333", botId = "44444444-4444-4444-8444-444444444444", taskId = "55555555-5555-4555-8555-555555555555";
const fixture = () => {
  const reserveExecution = vi.fn(), recordResource = vi.fn(), failed = vi.fn();
  const context: LifecycleContext = { store: { reserveExecution, recordResource } as unknown as LifecycleContext["store"], binding: { serverOrigin: "http://localhost:8787", userId, workerId, instanceId: workerId, localEpoch: "1", intentVersion: "1", scopeGeneration: "1" }, failed };
  return { context, reserveExecution, recordResource, failed };
};
describe("external results and local producer joins", () => {
  it("keeps a resolved pending dispatch reserved while preserving its original receipt", async () => {
    const f = fixture();
    await withWorkerLifecycle(f.context, () => withLifecycleReservation("assistant", { kind: "assistant_input" }, async () => ({ state: "accepted" }), operationId, result => ({ stage: "unknown", receipt: result })));
    expect(f.recordResource).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ stage: "unknown", stopProof: { kind: "external_result", operationId, receipt: { state: "accepted" } } }));
  });
  it("joins a failed local producer without closing its unknown child request", async () => {
    const f = fixture(), failure = new Error("Response lost");
    await expect(withWorkerLifecycle(f.context, () => withLifecycleProducer("assistant", { kind: "bot_advance" }, () => withLifecycleReservation("assistant", { kind: "assistant_api" }, async () => { throw failure; }, operationId)))).rejects.toBe(failure);
    expect(f.reserveExecution).toHaveBeenCalledTimes(2);
    expect(f.recordResource.mock.calls[0]![0]).toMatchObject({ stage: "unknown", error: "Response lost" });
    expect(f.recordResource.mock.calls[1]![0]).toMatchObject({ stage: "stopped", stopProof: { kind: "producer_joined", outcome: "failed" }, error: "Response lost" });
    expect(f.failed).not.toHaveBeenCalled();
  });
  it("freezes the claim request fingerprint without saving its credential", async () => {
    const f = fixture(), input = { operationId, claimGeneration: "1", claimToken: Buffer.alloc(32, 7).toString("base64url") };
    const claim = vi.fn(async (_taskId: string, _kind: string, _input: unknown) => ({ confirmed: true }));
    const api = lifecycleAssistantApi({ claim }, botId);
    await withWorkerLifecycle(f.context, () => api.claim(taskId, "renew", input));
    const reservation = f.reserveExecution.mock.calls[0]![0];
    expect(reservation.identity).toEqual({ kind: "assistant_api", method: "claim", assistantTaskId: taskId, botId, claimKind: "renew", requestFingerprint: assistantTaskClaimFingerprint({ ...input, kind: "renew", ownerUserId: userId, taskId, actorBotId: botId }) });
    expect(JSON.stringify(reservation)).not.toContain(input.claimToken);
    expect(claim).toHaveBeenCalledExactlyOnceWith(taskId, "renew", input);
  });
  it("keeps list/get reads outside application admission and freezes acknowledgement identity", async () => {
    const f = fixture(), getTask = vi.fn(async (_taskId: string) => ({})), ackEvent = vi.fn(async (_taskId: string, _eventId: string, _input: unknown) => ({}));
    const api = lifecycleAssistantApi({ getTask, ackEvent }, botId);
    await withWorkerLifecycle(f.context, async () => { await api.getTask(taskId); await api.ackEvent(taskId, workerId, { operationId }); });
    expect(f.reserveExecution).toHaveBeenCalledOnce();
    expect(f.reserveExecution.mock.calls[0]![0].identity).toEqual({ kind: "assistant_api", method: "ackEvent", assistantTaskId: taskId, botId, eventId: workerId, eventState: "delivered" });
  });
  it("does not swallow a join persistence failure", async () => {
    const f = fixture(), failure = new Error("Disk full"); f.recordResource.mockImplementation(() => { throw failure; });
    await expect(withWorkerLifecycle(f.context, () => withLifecycleProducer("task", { kind: "task_advance" }, async () => 1))).rejects.toBe(failure);
    expect(f.failed).toHaveBeenCalledExactlyOnceWith(failure);
  });
});
