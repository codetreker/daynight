import { createOperation } from "../api/operation.js";
import type { Operation } from "../api/operation.js";

export const CLEANUP_OPERATION_MS = 5 * 60_000;

export const cleanupOperation = async <T>(action: (operation: Operation) => Promise<T>, signal?: AbortSignal, totalMs = CLEANUP_OPERATION_MS): Promise<T> => {
  const operation = createOperation({ ...(signal === undefined ? {} : { signal }), limits: { totalMs, requestMs: totalMs } });
  try { return await action(operation); } finally { operation.dispose(); }
};
