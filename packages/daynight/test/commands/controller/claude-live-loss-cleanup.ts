import { setTimeout as delay } from "node:timers/promises";
import { inspectBootstrapProcessProof, type ProcessProof } from "../../../src/commands/controller/process-proof.js";
import { withWindowsFixtureExit } from "./claude-live-loss-windows.js";

type Observe = typeof inspectBootstrapProcessProof;

// The control connection belongs to the original native fixture, so sending on
// it cannot signal another process if the fixture's PID has been reused.
export const stopNativeFixture = async (proof: ProcessProof, stop: () => void, deadline: number, observe: Observe = inspectBootstrapProcessProof): Promise<void> => {
  let requested = false;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Native fixture did not stop by its cleanup deadline.");
    const state = await observe(proof, Math.min(remaining, 5000));
    if (Date.now() >= deadline) throw new Error("Native fixture did not stop by its cleanup deadline.");
    if (state === "stopped") return;
    if (state === "replaced") throw new Error("Native fixture identity was replaced before stop was observed.");
    if (state === "running" && !requested) { stop(); requested = true; }
    const wait = deadline - Date.now();
    if (wait > 0) await delay(Math.min(wait, 25));
  }
};

export const withNativeFixtureExit = async (proof: ProcessProof, action: () => Promise<void>, stop: () => void, windows = process.platform === "win32"): Promise<void> => {
  if (windows) {
    await withWindowsFixtureExit(proof, action);
    return;
  }
  await withCleanup(action, () => stopNativeFixture(proof, stop, Date.now() + 1000));
};

export const withCleanup = async (body: () => Promise<void>, cleanup: () => Promise<void>): Promise<void> => {
  let bodyError: unknown, bodyFailed = false;
  try { await body(); } catch (error) { bodyError = error; bodyFailed = true; }
  try { await cleanup(); } catch (error) {
    if (bodyFailed) throw new AggregateError([bodyError, error], "Test and cleanup both failed.");
    throw error;
  }
  if (bodyFailed) throw bodyError;
};
