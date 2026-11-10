import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
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

/** Reject FIFOs through the opened descriptor without leaving a blocking open in the filesystem pool. */
export const openRegularToolFile = async (file: string, operation: Operation): Promise<FileHandle> => {
  operation.check();
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK);
  const handle = await withinOperation(open(file, flags), operation, value => value.close());
  try {
    if (!(await withinOperation(handle.stat(), operation)).isFile()) {
      throw Object.assign(new Error("Tool artifact must be a regular file."), { code: "not_executable" });
    }
    return handle;
  } catch (error) {
    await withinOperation(handle.close(), operation);
    throw error;
  }
};
