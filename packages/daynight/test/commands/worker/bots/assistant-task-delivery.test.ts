import { afterEach, expect, it, vi } from "vitest";
import { observeAssistantDelivery, ASSISTANT_DELIVERY_OBSERVATION_MS, type AssistantTaskClock } from "../../../../src/commands/worker/bots/assistant-task-delivery.js";
import type { SessionOperation } from "../../../../src/session/protocol.js";

class Clock implements AssistantTaskClock {
  time = 0;
  pending: { due: number; resolve(): void }[] = [];
  now = () => this.time;
  wait = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    const cleanup = () => { this.pending = this.pending.filter(value => value !== entry); signal.removeEventListener("abort", cancel); };
    const cancel = () => { cleanup(); reject(signal.reason); };
    const entry = { due: this.time + ms, resolve: () => { cleanup(); resolve(); } };
    if (signal.aborted) { reject(signal.reason); return; }
    this.pending.push(entry); signal.addEventListener("abort", cancel, { once: true });
  });
  advance(ms: number): void { this.time += ms; for (const entry of [...this.pending]) if (entry.due <= this.time) entry.resolve(); }
}
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const operation = (state: SessionOperation["state"]): SessionOperation => ({ protocol: "daynight.session.v1", sessionId: id(1), testExecutionId: id(2), executionGeneration: "1", operationId: id(3), kind: "send_message", state, providerResult: null, error: null });
afterEach(() => { vi.useRealTimers(); });

it("observes each progressing state until provider acceptance and releases its deadline wait", async () => {
  const clock = new Clock(), controller = new AbortController();
  const read = vi.fn<(_: AbortSignal) => Promise<SessionOperation>>()
    .mockResolvedValueOnce(operation("offered"))
    .mockResolvedValueOnce(operation("dispatching"))
    .mockResolvedValueOnce({ ...operation("provider_accepted"), providerResult: "started" });
  const result = observeAssistantDelivery({ operation: operation("accepted"), clock, signal: controller.signal, read });
  clock.advance(999); await Promise.resolve(); expect(read).not.toHaveBeenCalled();
  for (let index = 0; index < 3; index++) {
    clock.advance(index === 0 ? 1 : 1000);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(index + 1));
  }
  await expect(result).resolves.toMatchObject({ operationId: id(3), state: "provider_accepted" });
  expect(clock.time).toBe(3000); expect(clock.pending).toEqual([]);
  expect(read.mock.calls.every(([signal]) => signal.aborted)).toBe(true);
});

it.each(["confirmed", "provider_accepted", "unknown", "failed", "rejected", "expired"] as const)("does not poll a %s outcome", async state => {
  const clock = new Clock(), original = operation(state), read = vi.fn<(_: AbortSignal) => Promise<SessionOperation>>();
  await expect(observeAssistantDelivery({ operation: original, clock, signal: new AbortController().signal, read })).resolves.toBe(original);
  expect(read).not.toHaveBeenCalled(); expect(clock.pending).toEqual([]);
});

it("ends at the absolute budget when a progressing receipt read is still in flight", async () => {
  const clock = new Clock(), entered = Promise.withResolvers<AbortSignal>();
  const read = vi.fn((signal: AbortSignal) => new Promise<SessionOperation>((_resolve, reject) => {
    entered.resolve(signal); signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const result = observeAssistantDelivery({ operation: operation("accepted"), clock, signal: new AbortController().signal, read });
  const rejected = expect(result).rejects.toThrow("observation deadline expired");
  clock.advance(1000); const readSignal = await entered.promise;
  clock.advance(ASSISTANT_DELIVERY_OBSERVATION_MS - 1001); await Promise.resolve(); expect(readSignal.aborted).toBe(false);
  clock.advance(1); await rejected;
  expect(readSignal.aborted).toBe(true); expect(read).toHaveBeenCalledOnce(); expect(clock.pending).toEqual([]);
});

it("uses real time to cancel a stalled read even without advancement of the supplied clock", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const clock = new Clock(), entered = Promise.withResolvers<AbortSignal>();
  const read = vi.fn((signal: AbortSignal) => new Promise<SessionOperation>((_resolve, reject) => {
    entered.resolve(signal); signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const result = observeAssistantDelivery({ operation: operation("accepted"), clock, signal: new AbortController().signal, read });
  const rejected = expect(result).rejects.toThrow("observation deadline expired");
  clock.advance(1000); const readSignal = await entered.promise;
  await vi.advanceTimersByTimeAsync(ASSISTANT_DELIVERY_OBSERVATION_MS); await rejected;
  expect(readSignal.aborted).toBe(true); expect(clock.time).toBe(1000); expect(clock.pending).toEqual([]); expect(vi.getTimerCount()).toBe(0);
});

it("propagates a receipt failure and joins the cancelled deadline wait", async () => {
  const clock = new Clock(), failure = new Error("Original receipt unavailable"), read = vi.fn(async () => { throw failure; });
  const result = observeAssistantDelivery({ operation: operation("accepted"), clock, signal: new AbortController().signal, read });
  const rejected = expect(result).rejects.toBe(failure);
  clock.advance(1000); await rejected;
  expect(read).toHaveBeenCalledOnce(); expect(clock.pending).toEqual([]);
});

it.each(["wait", "receipt"] as const)("joins cancellation during the %s without further queries", async phase => {
  const clock = new Clock(), controller = new AbortController(), entered = Promise.withResolvers<AbortSignal>();
  const read = vi.fn((signal: AbortSignal) => new Promise<SessionOperation>((_resolve, reject) => {
    entered.resolve(signal); signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const result = observeAssistantDelivery({ operation: operation("accepted"), clock, signal: controller.signal, read });
  const failure = new Error("Original Bot stopped"), rejected = expect(result).rejects.toBe(failure);
  if (phase === "receipt") { clock.advance(1000); await entered.promise; }
  controller.abort(failure); await rejected;
  expect(read).toHaveBeenCalledTimes(phase === "receipt" ? 1 : 0); expect(clock.pending).toEqual([]);
});
