import { setImmediate as yieldNative } from "node:timers/promises";

// Capture only timer registration synchronous with run; cancellation stays observable until restore.
export const captureSynchronousDeadline = <T>(run: () => T) => {
  const schedule = globalThis.setTimeout, cancel = globalThis.clearTimeout;
  let collecting = true, count = 0, requested: number | undefined, handle: NodeJS.Timeout | undefined;
  let active = false, delivered = false, ready = false, callback: (() => void) | undefined;
  const placeholders = new Set<NodeJS.Timeout>();
  const capturedSchedule = ((fn: (...args: any[]) => void, milliseconds?: number, ...args: any[]) => {
    if (!collecting) return schedule(fn, milliseconds, ...args);
    count++; requested = milliseconds;
    const timer = schedule(() => { placeholders.delete(timer); if (handle === timer) active = false; }, 60_000);
    placeholders.add(timer); handle = timer; active = true; callback = () => fn(...args);
    return timer;
  }) as typeof globalThis.setTimeout;
  const capturedCancel: typeof globalThis.clearTimeout = timer => {
    if (timer === handle) active = false;
    if (typeof timer === "object" && timer !== null) placeholders.delete(timer);
    cancel(timer);
  };
  globalThis.setTimeout = capturedSchedule; globalThis.clearTimeout = capturedCancel;
  let result: T;
  try { result = run(); }
  catch (error) { globalThis.setTimeout = schedule; globalThis.clearTimeout = cancel; for (const timer of placeholders) cancel(timer); throw error; }
  finally { collecting = false; }
  return {
    result,
    get requested() { return requested; },
    get count() { return count; },
    markReady: () => { ready = true; },
    expire: async () => {
      if (!ready || !active || delivered || handle === undefined || callback === undefined || count !== 1) throw new Error("Deadline is not eligible for delivery.");
      await yieldNative();
      if (!ready || !active || delivered) throw new Error("Deadline is no longer eligible for delivery.");
      active = false; delivered = true; placeholders.delete(handle); cancel(handle); callback();
    },
    restore: () => {
      for (const timer of placeholders) cancel(timer);
      placeholders.clear(); active = false;
      const scheduleOwned = globalThis.setTimeout === capturedSchedule, cancelOwned = globalThis.clearTimeout === capturedCancel;
      if (scheduleOwned) globalThis.setTimeout = schedule;
      if (cancelOwned) globalThis.clearTimeout = cancel;
      if (!scheduleOwned || !cancelOwned) throw new Error("Deadline timer ownership changed.");
    },
  };
};
