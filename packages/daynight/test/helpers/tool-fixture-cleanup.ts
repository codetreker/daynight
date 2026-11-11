import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export const removeFixtureRoot = async (root: string, remove: typeof rm = rm, wait: (ms: number) => Promise<void> = delay): Promise<void> => {
  // Node's recursive retries apply at every depth; keep one budget for the root.
  for (let retry = 0; ; retry++) {
    try { await remove(root, { recursive: true, force: true, maxRetries: 0 }); return; }
    catch (error) {
      if (retry === 3 || !(error instanceof Error) || !("code" in error) || error.code !== "EBUSY") throw error;
      await wait(100 * (retry + 1));
    }
  }
};
