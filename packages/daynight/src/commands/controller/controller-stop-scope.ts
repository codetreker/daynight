import type { ControllerStop } from "./controller-stop.js";

/** Join release without losing an earlier stopping failure. */
export const withControllerStop = async <T>(stop: ControllerStop, operation: () => Promise<T>): Promise<T> => {
  let value: T | undefined, failure: unknown, failed = false;
  try { value = await operation(); } catch (error) { failed = true; failure = error; }
  try { await stop.close(); }
  catch (error) {
    if (failed) throw new AggregateError([failure, error], "Controller stopping and original Job release failed.", { cause: failure });
    throw error;
  }
  if (failed) throw failure;
  return value!;
};
