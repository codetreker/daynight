import { fileURLToPath } from "node:url";
import { probeResourceKey, toolCommand, verifyToolLaunch, ToolSelectionError, type ResolvedToolLaunch } from "../../platform/tool-executables.js";
import { runHerdrCommand } from "./herdr/command.js";
import { parseNativeAgentVersion } from "./herdr/version-probe.js";
import { createCodexProbeOwner, joinNativeProbeCleanup, type CodexProbeOwner } from "./codex-probe-owner.js";
import { withinOperation } from "../../platform/tool-io.js";
import type { Operation } from "../../api/operation.js";
import type { WorkerCloudNative } from "../../api/worker-configuration.js";
import { createBotCliProbe, BotCliProbeCleanupError } from "./bots/cli-probe.js";
import { NativeCapabilityError, validateNativeModelObservation, type NativeModelObservation } from "../controller/providers/native-selection.js";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const capabilityFailure = (error: unknown): unknown => error instanceof ToolSelectionError ? error : error instanceof Error && "code" in error && ["capability_error", "limit_exceeded", "cleanup_unknown"].includes(String(error.code)) ? error
  : new NativeCapabilityError("capability_error", error instanceof Error ? error.message : "Native capability discovery failed.", { cause: error });
export type NativeProbeOptions = { native: WorkerCloudNative; cwd: string; environment: NodeJS.ProcessEnv; mode?: "web" | "herdr"; toolLaunch?: ResolvedToolLaunch; toolRuntimeRoot?: string };
const runNativeRequest = async (options: NativeProbeOptions, operation: Operation, action: "verify" | "discover" | "status"): Promise<Record<string, unknown>> => {
  const mode = options.mode ?? options.toolLaunch?.context ?? (action === "verify" ? "herdr" : "web");
  if (options.toolLaunch) {
    if (options.toolLaunch.tool !== options.native.agent || options.toolLaunch.context !== mode) throw new Error("Native probe tool identity differs from its request.");
    await verifyToolLaunch(options.toolLaunch, operation, options.toolRuntimeRoot ? { trustedRuntimeRoot: options.toolRuntimeRoot } : {});
  }
  const environment = { ...options.environment };
  for (const key of ["CODEX_THREAD_ID", "CODEX_TURN_ID", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "DAYNIGHT_CONTROLLER_TOKEN"]) delete environment[key];
  let probe: Awaited<ReturnType<typeof createBotCliProbe>>;
  try { probe = await createBotCliProbe({ cwd: options.cwd, environment }, operation); }
  catch (error) { if (error instanceof BotCliProbeCleanupError) throw new NativeCapabilityError("cleanup_unknown", "Native probe setup cleanup is unconfirmed.", { cause: error }); throw capabilityFailure(error); }
  let failure: unknown;
  let observation: Record<string, unknown> | undefined;
  try {
    const result = await probe.run(process.execPath, [fileURLToPath(new URL("./native-selection-probe.js", import.meta.url)), JSON.stringify({ agent: options.native.agent, model: options.native.model, args: options.native.args, mode, ...(options.toolLaunch ? { toolLaunch: options.toolLaunch } : {}), ...(options.toolRuntimeRoot ? { toolRuntimeRoot: options.toolRuntimeRoot } : {}) }), action]);
    let response: unknown;
    try { response = JSON.parse(result.stdout); } catch { throw new NativeCapabilityError("capability_error", "Native model/effort selection probe returned invalid output."); }
    if (typeof response !== "object" || response === null || !("ok" in response) || response.ok !== true) {
      if (record(response) && record(response.toolSelection) && options.toolLaunch && response.toolSelection.tool === options.toolLaunch.tool && response.toolSelection.context === options.toolLaunch.context && response.toolSelection.code === "tool_identity_changed") {
        throw new ToolSelectionError(options.toolLaunch.tool, options.toolLaunch.context, "verify", "tool_identity_changed");
      }
      const detail = typeof response === "object" && response !== null && "error" in response && typeof response.error === "string" ? response.error : "Native selection is unknown.";
      const code = record(response) && (response.code === "limit_exceeded" || response.code === "cleanup_unknown") ? response.code : "capability_error";
      throw new NativeCapabilityError(code, `Native model/effort selection could not be validated: ${detail.slice(0, 2000)}`);
    }
    observation = response as Record<string, unknown>;
  } catch (error) { failure = capabilityFailure(error); }
  try { await probe.close(); } catch (error) {
    if (failure === undefined) throw new NativeCapabilityError("cleanup_unknown", "Native probe cleanup is unconfirmed.", { cause: error });
    throw Object.assign(new AggregateError([failure, error], "Native selection and probe cleanup failed."), { code: "cleanup_unknown" as const });
  }
  if (failure !== undefined) throw failure;
  if (observation === undefined) throw new Error("Native selection observation is unavailable.");
  return observation;
};

const runNativeProbe = async (options: NativeProbeOptions, operation: Operation, action: "verify" | "discover"): Promise<NativeModelObservation> => {
  const response = await runNativeRequest(options, operation, action);
  return validateNativeModelObservation(response.observation);
};

export const verifyWorkerNativeSelection = (options: NativeProbeOptions, operation: Operation): Promise<NativeModelObservation> => runNativeProbe(options, operation, "verify");
export const discoverWorkerNativeCapabilities = (options: NativeProbeOptions, operation: Operation): Promise<NativeModelObservation> => runNativeProbe(options, operation, "discover");

/** Retain every process scope by canonical resource, including targets no longer desired. */
export const createNativeSelectionVerifier = () => {
  type State = { pending: Map<string, BotCliProbeCleanupError>; tail: Promise<void>; revision: number };
  const states = new Map<string, State>(); let closed = false;
  const key = (options: NativeProbeOptions) => options.toolLaunch ? probeResourceKey(options.toolLaunch, { cwd: options.cwd, environment: options.environment })
    : JSON.stringify([options.native.agent, options.cwd, options.environment]);
  const state = (options: NativeProbeOptions): State => {
    const id = key(options); let value = states.get(id);
    if (!value) { value = { pending: new Map(), tail: Promise.resolve(), revision: 0 }; states.set(id, value); }
    return value;
  };
  const retain = (owner: State, error: unknown, seen = new Set<unknown>()): void => {
    if (seen.has(error)) return; seen.add(error);
    if (error instanceof BotCliProbeCleanupError) owner.pending.set(error.ownership.launchId, error);
    if (error instanceof AggregateError) for (const child of error.errors) retain(owner, child, seen);
    if (error instanceof Error && error.cause !== undefined) retain(owner, error.cause, seen);
  };
  const cleanup = async (owner: State, operation?: Operation): Promise<void> => {
    const failures: unknown[] = [];
    for (const [id, error] of [...owner.pending]) {
      try {
        operation?.check();
        const pending = joinNativeProbeCleanup(error).then(() => { owner.pending.delete(id); }, failure => { retain(owner, failure); throw failure; });
        await (operation ? withinOperation(pending, operation) : pending);
      } catch (failure) { failures.push(failure); if (operation?.signal.aborted) break; }
    }
    if (failures.length) throw new AggregateError(failures, "Native selection probe cleanup remains unconfirmed.");
  };
  const enqueue = <T>(options: NativeProbeOptions, operation: Operation, invoke: () => Promise<T>): Promise<T> => {
    const owner = state(options);
    const running = owner.tail.then(async () => {
      if (closed) throw new Error("Native selection verifier is closed.");
      operation.check(); await cleanup(owner, operation); operation.check();
      try { return await invoke(); }
      catch (error) { retain(owner, error); if (owner.pending.size || error instanceof Error && "code" in error && error.code === "cleanup_unknown") owner.revision++; throw error; }
    });
    owner.tail = running.then(() => {}, () => {}); return running;
  };
  const settle = async (operation?: Operation): Promise<void> => {
    const errors: unknown[] = [];
    for (const owner of states.values()) {
      try {
        operation?.check();
        await (operation ? withinOperation(owner.tail, operation) : owner.tail);
        await cleanup(owner, operation);
      } catch (error) { errors.push(error); if (operation?.signal.aborted) break; }
    }
    if (errors.length) throw new AggregateError(errors, "Native selection probe cleanup remains unconfirmed.");
  };
  return {
    reconcile: (options: NativeProbeOptions, operation: Operation): Promise<void> => enqueue(options, operation, async () => {}),
    verify: async (options: NativeProbeOptions, operation: Operation): Promise<void> => { await enqueue(options, operation, () => runNativeProbe(options, operation, "verify")); },
    discover: (options: NativeProbeOptions, operation: Operation): Promise<NativeModelObservation> => enqueue(options, operation, () => runNativeProbe(options, operation, "discover")),
    status: (options: NativeProbeOptions, operation: Operation): Promise<string> => enqueue(options, operation, async () => {
      const response = await runNativeRequest(options, operation, "status");
      if (typeof response.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(response.version) || Buffer.byteLength(response.version) > 256) throw new NativeCapabilityError("capability_error", "Native runtime version is invalid.");
      return response.version;
    }),
    assertAvailable: (options: NativeProbeOptions): void => {
      if (closed) throw new Error("Native selection verifier is closed.");
      if (state(options).pending.size) throw new NativeCapabilityError("cleanup_unknown", "Native probe cleanup is unconfirmed.");
    },
    revision: (options: NativeProbeOptions): number => state(options).revision,
    settle,
    close: async (operation?: Operation): Promise<void> => { closed = true; await settle(operation); },
  };
};
export type NativeSelectionVerifier = Pick<ReturnType<typeof createNativeSelectionVerifier>, "verify" | "settle" | "close">;

export const createWorkerToolInspector = (options: { cwd: string; environment: NodeJS.ProcessEnv; toolRuntimeRoot?: string; codexProbes?: CodexProbeOwner }) => {
  const verifier = createNativeSelectionVerifier(), codex = options.codexProbes ?? createCodexProbeOwner(options.environment, options.cwd);
  const request = (launch: ResolvedToolLaunch): NativeProbeOptions => {
    if (launch.tool === "herdr") throw new Error("Herdr runtime inspection belongs to its instance adapter.");
    return { native: { agent: launch.tool, model: null, args: [] }, cwd: options.cwd, environment: options.environment, mode: launch.context, toolLaunch: launch, ...(options.toolRuntimeRoot ? { toolRuntimeRoot: options.toolRuntimeRoot } : {}) };
  };
  const invocation = (launch: ResolvedToolLaunch, scope = options) => ({ file: launch.command.file, toolLaunch: launch, environment: scope.environment, workingDirectory: scope.cwd });
  const modelProbe = <T>(input: NativeProbeOptions & { toolLaunch: ResolvedToolLaunch }, operation: Operation, run: () => Promise<T>): Promise<T> => codex.observe(invocation(input.toolLaunch, input), operation, run);
  return {
    reconcile: (launch: ResolvedToolLaunch, operation: Operation): Promise<void> => withinOperation(codex.observe(invocation(launch), operation, async () => {
      if (launch.tool !== "herdr") await verifier.reconcile(request(launch), operation);
    }), operation),
    discover: (input: NativeProbeOptions & { toolLaunch: ResolvedToolLaunch }, operation: Operation): Promise<NativeModelObservation> => modelProbe(input, operation, () => verifier.discover(input, operation)),
    verify: (input: NativeProbeOptions & { toolLaunch: ResolvedToolLaunch }, operation: Operation): Promise<void> => modelProbe(input, operation, () => verifier.verify(input, operation)),
    check: async (launch: ResolvedToolLaunch, operation: Operation): Promise<{ version: string; checkedAt: string }> => {
      const inspect = async () => {
        await verifyToolLaunch(launch, operation, options.toolRuntimeRoot ? { trustedRuntimeRoot: options.toolRuntimeRoot } : {});
        let version: string;
        if (launch.tool === "copilot" && launch.context === "web") version = await verifier.status(request(launch), operation);
        else {
          const result = await runHerdrCommand({ ...toolCommand(launch, launch.tool === "copilot" ? ["--no-auto-update", "--version"] : ["--version"]), environment: options.environment, cwd: options.cwd }, operation);
          if (launch.tool === "herdr") {
            const match = /^herdr (\d+\.\d+\.\d+)(?:\s|$)/m.exec(result.stdout);
            if (!match) throw new ToolSelectionError(launch.tool, launch.context, "probe", "unrecognized_output"); version = match[1]!;
          } else version = parseNativeAgentVersion(launch.tool, result.stdout);
          if (launch.tool === "codex" && launch.context === "web") {
            const help = await runHerdrCommand({ ...toolCommand(launch, ["app-server", "--stdio", "--help"]), environment: options.environment, cwd: options.cwd }, operation);
            if (!["app-server", "--stdio"].every(flag => help.stdout.includes(flag))) throw new ToolSelectionError(launch.tool, launch.context, "probe", "incompatible_runtime");
          }
        }
        return { version, checkedAt: new Date().toISOString() };
      };
      return codex.observe(invocation(launch), operation, inspect);
    },
    assertAvailable: (launch: ResolvedToolLaunch): void => { codex.assertAvailable(invocation(launch)); if (launch.tool !== "herdr") verifier.assertAvailable(request(launch)); },
    revision: (launch: ResolvedToolLaunch): number => codex.revision(invocation(launch)) + (launch.tool !== "herdr" ? verifier.revision(request(launch)) : 0),
    close: async (operation?: Operation): Promise<void> => {
      const results = await Promise.allSettled([verifier.close(operation), ...(options.codexProbes ? [] : [codex.close(operation)])]);
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Tool probe cleanup remains unconfirmed.");
    },
  };
};

export const inspectWorkerToolLaunch = async (options: { launch: ResolvedToolLaunch; cwd: string; environment: NodeJS.ProcessEnv; toolRuntimeRoot?: string }, operation: Operation): Promise<{ version: string; checkedAt: string }> => {
  const inspector = createWorkerToolInspector(options);
  try { return await inspector.check(options.launch, operation); } finally { await inspector.close(); }
};
