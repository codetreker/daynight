import type { SessionOperation } from "../../../session/protocol.js";

export const ASSISTANT_DELIVERY_OBSERVATION_MS = 10_000;
export const ASSISTANT_DELIVERY_POLL_MS = 1000;
export type AssistantTaskClock = { now(): number; wait(ms: number, signal: AbortSignal): Promise<void> };

const progressing = (operation: SessionOperation): boolean => ["accepted", "offered", "dispatching"].includes(operation.state);

/** Observe the original submitted operation without extending the event scan cadence. */
export const observeAssistantDelivery = async (options: {
  operation: SessionOperation; clock: AssistantTaskClock; signal: AbortSignal;
  read(signal: AbortSignal): Promise<SessionOperation>;
}): Promise<SessionOperation> => {
  let current = options.operation;
  if (!progressing(current)) return current;
  const cancellation = new AbortController(), deadline = options.clock.now() + ASSISTANT_DELIVERY_OBSERVATION_MS;
  const signal = AbortSignal.any([options.signal, cancellation.signal]);
  const expired = () => cancellation.abort(new Error("Assistant delivery observation deadline expired; the original operation is retained."));
  // The clock bounds controlled schedules; real time also bounds a stalled
  // receipt read even when the caller's clock does not advance.
  const timer = setTimeout(expired, ASSISTANT_DELIVERY_OBSERVATION_MS); timer.unref();
  const deadlineWork = options.clock.wait(ASSISTANT_DELIVERY_OBSERVATION_MS, signal).then(expired, () => undefined);
  try {
    while (progressing(current)) {
      signal.throwIfAborted();
      const remaining = deadline - options.clock.now();
      if (remaining <= 0) { expired(); signal.throwIfAborted(); }
      await options.clock.wait(Math.min(ASSISTANT_DELIVERY_POLL_MS, remaining), signal);
      signal.throwIfAborted();
      current = await options.read(signal);
      signal.throwIfAborted();
    }
    return current;
  } finally {
    clearTimeout(timer); cancellation.abort();
    await deadlineWork;
  }
};
