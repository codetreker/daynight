import { performance } from "node:perf_hooks";

export type OperationLimits = {
  readonly totalMs: number;
  readonly requestMs: number;
  readonly responseBytes: number;
  readonly totalBytes: number;
};

export const DEFAULT_OPERATION_LIMITS: OperationLimits = Object.freeze({
  totalMs: 5 * 60_000,
  requestMs: 30_000,
  responseBytes: 128 * 1_048_576,
  totalBytes: 256 * 1_048_576,
});

export class OperationError extends Error {
  constructor(readonly kind: "cancelled" | "deadline" | "request_timeout" | "request_limit" | "response_limit" | "total_limit" | "disposed", options?: ErrorOptions) {
    const messages = {
      cancelled: "Operation cancelled.",
      deadline: "Operation deadline exceeded.",
      request_timeout: "HTTP request deadline exceeded.",
      request_limit: "HTTP request byte limit exceeded.",
      response_limit: "HTTP response byte limit exceeded.",
      total_limit: "Operation response byte budget exceeded.",
      disposed: "Operation has been disposed.",
    };
    super(messages[kind], options);
    this.name = "OperationError";
  }
}

export type Operation = {
  readonly signal: AbortSignal;
  readonly limits: OperationLimits;
  check(): void;
  remainingMs(): number;
  remainingBytes(): number;
  consume(bytes: number): void;
  dispose(): void;
};

export const createOperation = (options: {
  readonly signal?: AbortSignal;
  readonly limits?: Partial<OperationLimits>;
} = {}): Operation => {
  const limits = Object.freeze({ ...DEFAULT_OPERATION_LIMITS, ...options.limits });
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer.`);
  }
  if (limits.totalMs > 2_147_483_647 || limits.requestMs > 2_147_483_647) throw new RangeError("Operation deadlines must fit the supported timer range.");
  const controller = new AbortController();
  const deadline = performance.now() + limits.totalMs;
  let consumed = 0;
  let disposed = false;
  const cancel = (): void => controller.abort(new OperationError("cancelled", { cause: options.signal?.reason }));
  const timer = setTimeout(() => controller.abort(new OperationError("deadline")), limits.totalMs);
  timer.unref();
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const check = (): void => {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (disposed) throw new OperationError("disposed");
    if (performance.now() >= deadline) {
      controller.abort(new OperationError("deadline"));
      throw controller.signal.reason;
    }
  };
  return {
    signal: controller.signal,
    limits,
    check,
    remainingMs: () => { check(); return Math.max(0, deadline - performance.now()); },
    remainingBytes: () => { check(); return limits.totalBytes - consumed; },
    consume: (bytes) => {
      check();
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError("Response byte count must be a nonnegative safe integer.");
      consumed += bytes;
      if (consumed > limits.totalBytes) {
        controller.abort(new OperationError("total_limit"));
        throw controller.signal.reason;
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      if (!controller.signal.aborted) controller.abort(new OperationError("disposed"));
    },
  };
};
