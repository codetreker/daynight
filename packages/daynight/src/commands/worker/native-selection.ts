import { fileURLToPath } from "node:url";
import type { Operation } from "../../api/operation.js";
import type { WorkerCloudNative } from "../../api/worker-configuration.js";
import { createBotCliProbe, BotCliProbeCleanupError } from "./bots/cli-probe.js";
import type { NativeModelObservation } from "../controller/providers/native-selection.js";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
const isObservation = (value: unknown): value is NativeModelObservation => record(value)
  && (value.model === null || typeof value.model === "string")
  && (value.effort === undefined || value.effort === null || typeof value.effort === "string")
  && Array.isArray(value.models) && value.models.length <= 500
  && value.models.every(model => record(model) && typeof model.id === "string"
    && (model.aliases === undefined || strings(model.aliases))
    && (model.efforts === null || strings(model.efforts)));

export const verifyWorkerNativeSelection = async (options: { native: WorkerCloudNative; cwd: string; environment: NodeJS.ProcessEnv }, operation: Operation): Promise<NativeModelObservation> => {
  const environment = { ...options.environment };
  for (const key of ["CODEX_THREAD_ID", "CODEX_TURN_ID", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "DAYNIGHT_CONTROLLER_TOKEN"]) delete environment[key];
  const probe = await createBotCliProbe({ cwd: options.cwd, environment }, operation);
  let failure: unknown;
  let observation: NativeModelObservation | undefined;
  try {
    const result = await probe.run(process.execPath, [fileURLToPath(new URL("./native-selection-probe.js", import.meta.url)), JSON.stringify({ agent: options.native.agent, model: options.native.model, args: options.native.args })]);
    let response: unknown;
    try { response = JSON.parse(result.stdout); } catch { throw new Error("Native model/effort selection probe returned invalid output."); }
    if (typeof response !== "object" || response === null || !("ok" in response) || response.ok !== true) {
      const detail = typeof response === "object" && response !== null && "error" in response && typeof response.error === "string" ? response.error : "Native selection is unknown.";
      throw new Error(`Native model/effort selection could not be validated: ${detail.slice(0, 2000)}`);
    }
    if (!("observation" in response) || !isObservation(response.observation)) throw new Error("Native selection observation is unavailable.");
    observation = response.observation;
  } catch (error) { failure = error; }
  try { await probe.close(); } catch (error) {
    throw failure === undefined ? error : new AggregateError([failure, error], "Native selection and probe cleanup failed.");
  }
  if (failure !== undefined) throw failure;
  if (observation === undefined) throw new Error("Native selection observation is unavailable.");
  return observation;
};

/** One Worker owns selection probes across its per-run Herdr adapters. */
export const createNativeSelectionVerifier = () => {
  const pending = new Map<string, BotCliProbeCleanupError>();
  let tail: Promise<void> = Promise.resolve(), closed = false;
  const retain = (error: unknown, seen = new Set<unknown>()): void => {
    if (seen.has(error)) return;
    seen.add(error);
    if (error instanceof BotCliProbeCleanupError) pending.set(error.ownership.launchId, error);
    if (error instanceof AggregateError) for (const child of error.errors) retain(child, seen);
    if (error instanceof Error && error.cause !== undefined) retain(error.cause, seen);
  };
  const cleanup = async (): Promise<void> => {
    const failures: unknown[] = [];
    for (const [id, error] of pending) {
      try { await error.retryCleanup(); pending.delete(id); }
      catch (failure) { retain(failure); failures.push(failure); }
    }
    if (failures.length) throw new AggregateError(failures, "Native selection probe cleanup remains unconfirmed.");
  };
  return {
    verify: (options: Parameters<typeof verifyWorkerNativeSelection>[0], operation: Operation): Promise<void> => {
      const running = tail.then(async () => {
        if (closed) throw new Error("Native selection verifier is closed.");
        operation.check();
        await cleanup();
        operation.check();
        try { await verifyWorkerNativeSelection(options, operation); }
        catch (error) { retain(error); throw error; }
      });
      tail = running.catch(() => {});
      return running;
    },
    settle: (): Promise<void> => {
      const running = tail.then(cleanup);
      tail = running.catch(() => {});
      return running;
    },
    close: async (): Promise<void> => { closed = true; await tail; await cleanup(); },
  };
};
export type NativeSelectionVerifier = ReturnType<typeof createNativeSelectionVerifier>;
