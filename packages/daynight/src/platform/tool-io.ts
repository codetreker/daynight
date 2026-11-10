import type { Operation } from "../api/operation.js";

/** Bound uncancellable filesystem requests and dispose resources returned after cancellation. */
export const withinOperation = <T>(pending: Promise<T>, operation: Operation, disposeLate?: (value: T) => Promise<void>): Promise<T> => new Promise((resolve, reject) => {
  let settled = false;
  const abort = () => {
    if (settled) return;
    settled = true; operation.signal.removeEventListener("abort", abort);
    reject(operation.signal.reason);
  };
  operation.signal.addEventListener("abort", abort, { once: true });
  if (operation.signal.aborted) abort();
  pending.then(value => {
    if (settled) { void disposeLate?.(value).catch(() => {}); return; }
    settled = true; operation.signal.removeEventListener("abort", abort);
    try { operation.check(); resolve(value); }
    catch (error) { void disposeLate?.(value).catch(() => {}); reject(error); }
  }, error => {
    if (settled) return;
    settled = true; operation.signal.removeEventListener("abort", abort); reject(error);
  });
});
