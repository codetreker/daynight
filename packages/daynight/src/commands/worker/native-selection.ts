import { fileURLToPath } from "node:url";
import type { Operation } from "../../api/operation.js";
import type { WorkerCloudNative } from "../../api/worker-configuration.js";
import { createBotCliProbe, BotCliProbeCleanupError } from "./bots/cli-probe.js";
import { NativeCapabilityError, validateNativeModelObservation, type NativeModelObservation } from "../controller/providers/native-selection.js";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const capabilityFailure = (error: unknown): unknown => error instanceof Error && "code" in error && ["capability_error", "limit_exceeded", "cleanup_unknown"].includes(String(error.code)) ? error
  : new NativeCapabilityError("capability_error", error instanceof Error ? error.message : "Native capability discovery failed.", { cause: error });
type NativeProbeOptions = { native: WorkerCloudNative; cwd: string; environment: NodeJS.ProcessEnv };
const runNativeProbe = async (options: NativeProbeOptions, operation: Operation, mode: "verify" | "discover"): Promise<NativeModelObservation> => {
  const environment = { ...options.environment };
  for (const key of ["CODEX_THREAD_ID", "CODEX_TURN_ID", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "DAYNIGHT_CONTROLLER_TOKEN"]) delete environment[key];
  let probe: Awaited<ReturnType<typeof createBotCliProbe>>;
  try { probe = await createBotCliProbe({ cwd: options.cwd, environment }, operation); }
  catch (error) { if (error instanceof BotCliProbeCleanupError) throw new NativeCapabilityError("cleanup_unknown", "Native probe setup cleanup is unconfirmed.", { cause: error }); throw capabilityFailure(error); }
  let failure: unknown;
  let observation: NativeModelObservation | undefined;
  try {
    const result = await probe.run(process.execPath, [fileURLToPath(new URL("./native-selection-probe.js", import.meta.url)), JSON.stringify({ agent: options.native.agent, model: options.native.model, args: options.native.args }), mode]);
    let response: unknown;
    try { response = JSON.parse(result.stdout); } catch { throw new NativeCapabilityError("capability_error", "Native model/effort selection probe returned invalid output."); }
    if (typeof response !== "object" || response === null || !("ok" in response) || response.ok !== true) {
      const detail = typeof response === "object" && response !== null && "error" in response && typeof response.error === "string" ? response.error : "Native selection is unknown.";
      const code = record(response) && (response.code === "limit_exceeded" || response.code === "cleanup_unknown") ? response.code : "capability_error";
      throw new NativeCapabilityError(code, `Native model/effort selection could not be validated: ${detail.slice(0, 2000)}`);
    }
    if (!("observation" in response)) throw new NativeCapabilityError("capability_error", "Native selection observation is unavailable.");
    observation = validateNativeModelObservation(response.observation);
  } catch (error) { failure = capabilityFailure(error); }
  try { await probe.close(); } catch (error) {
    if (failure === undefined) throw new NativeCapabilityError("cleanup_unknown", "Native probe cleanup is unconfirmed.", { cause: error });
    throw Object.assign(new AggregateError([failure, error], "Native selection and probe cleanup failed."), { code: "cleanup_unknown" as const });
  }
  if (failure !== undefined) throw failure;
  if (observation === undefined) throw new Error("Native selection observation is unavailable.");
  return observation;
};

export const verifyWorkerNativeSelection = (options: NativeProbeOptions, operation: Operation): Promise<NativeModelObservation> => runNativeProbe(options, operation, "verify");
export const discoverWorkerNativeCapabilities = (options: NativeProbeOptions, operation: Operation): Promise<NativeModelObservation> => runNativeProbe(options, operation, "discover");

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
  const enqueue = (options: NativeProbeOptions, operation: Operation, mode: "verify" | "discover"): Promise<NativeModelObservation> => {
      const running = tail.then(async () => {
        if (closed) throw new Error("Native selection verifier is closed.");
        operation.check();
        await cleanup();
        operation.check();
        try { return await runNativeProbe(options, operation, mode); }
        catch (error) { retain(error); throw error; }
      });
      tail = running.then(() => {}, () => {});
      return running;
  };
  return {
    verify: async (options: NativeProbeOptions, operation: Operation): Promise<void> => { await enqueue(options, operation, "verify"); },
    discover: (options: NativeProbeOptions, operation: Operation): Promise<NativeModelObservation> => enqueue(options, operation, "discover"),
    settle: (): Promise<void> => {
      const running = tail.then(cleanup);
      tail = running.catch(() => {});
      return running;
    },
    close: async (): Promise<void> => { closed = true; await tail; await cleanup(); },
  };
};
export type NativeSelectionVerifier = Pick<ReturnType<typeof createNativeSelectionVerifier>, "verify" | "settle" | "close">;
