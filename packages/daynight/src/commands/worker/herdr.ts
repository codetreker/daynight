import { readCodexConfiguration } from "./herdr/codex-config.js";
import type { WorkerPaths } from "./paths.js";
import type { HerdrExecutionContext, HerdrExecutionOwner, HerdrWorkspaceEnvironment } from "./herdr/agents.js";
import type { Operation } from "../../api/operation.js";
import type { ExecutionStopObserver, TerminalCleanupContext } from "./execution-stop.js";
import { createHerdrAgentManager } from "./herdr/agents.js";
import { createHerdrInstance, createHerdrNativeEnvironment } from "./herdr/instance.js";
import { createHerdrPreflight } from "./herdr/preflight.js";
import type { NativeSelectionVerifier } from "./native-selection.js";
import type { ExecutionConfiguration } from "./types.js";
import type { ResolvedToolLaunch } from "../../platform/tool-executables.js";
import { ToolSelectionError } from "../../platform/tool-executables.js";
import { createToolLaunchMapping } from "./herdr/tool-launch.js";

export type {
  HerdrExecutionContext,
  HerdrExecutionOwner,
  HerdrOwnedWorkspace,
  HerdrTaskBinding,
  HerdrPendingStop,
  HerdrAgentConfiguration,
  HerdrAgentObservation,
  HerdrAgentStartInput,
  HerdrAgentLaunchInput,
  HerdrPromptReceipt,
  HerdrPromptResult,
  HerdrPromptGuard,
  HerdrNativeReference,
} from "./herdr/agents.js";
export { HerdrAgentActionError, validateHerdrAgentArguments } from "./herdr/agents.js";
export { HerdrRpcError } from "./herdr/rpc.js";

export const createWorkerHerdr = (options: {
  paths: WorkerPaths;
  homeDirectory: string;
  executable?: string;
  herdrLaunch?: ResolvedToolLaunch | undefined;
  readExecutionConfiguration?: (context: HerdrExecutionContext) => ExecutionConfiguration | null;
  environment?: NodeJS.ProcessEnv;
  agentEnvironment?: Readonly<{ PATH?: string; DN_CONFIG_DIR?: string }>;
  onDaemonSpawn?: (pid: number) => Promise<void>;
  retainOnStartupFailure?: boolean;
  isolatedRun?: boolean;
  selectionVerifier?: NativeSelectionVerifier;
}) => {
  const inheritedEnvironment = options.environment === undefined ? process.env : options.environment;
  const instance = createHerdrInstance({ ...options, ...(options.herdrLaunch === undefined ? {} : { toolLaunch: options.herdrLaunch }), environment: inheritedEnvironment });
  const nativeEnvironment = { ...createHerdrNativeEnvironment(options.paths, inheritedEnvironment), ...options.agentEnvironment };
  const workspaceEnvironment: { -readonly [K in keyof HerdrWorkspaceEnvironment]: HerdrWorkspaceEnvironment[K] } = { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "", ...options.agentEnvironment };
  for (const key of ["XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const) {
    const value = inheritedEnvironment[key];
    // Herdr's workspace map cannot remove keys; empty XDG values select the user's defaults.
    // https://specifications.freedesktop.org/basedir/latest/
    workspaceEnvironment[key] = value === undefined ? "" : value;
  }
  const preflight = createHerdrPreflight({
    rpc: instance.rpc,
    assertIntegrationEnvironment: instance.assertIntegrationEnvironment,
    environment: nativeEnvironment,
    homeDirectory: options.homeDirectory,
    ...(options.selectionVerifier === undefined ? {} : { selectionVerifier: options.selectionVerifier }),
  });
  const tasks = createHerdrAgentManager({ rpc: instance.rpc, session: "w", preflight: {
    verifyStart: (input, operation) => {
      return preflight.verifyStart({ ...input, configuration: { ...input.configuration, agent: input.configuration.agent } }, operation);
    },
  }, workspaceEnvironment, nativeEnvironment,
    ...(options.readExecutionConfiguration === undefined ? {} : { toolMapping: async (context: HerdrExecutionContext, operation: Operation, existingOnly?: boolean) => {
      const configuration = options.readExecutionConfiguration!(context);
      if (configuration?.toolLaunch === undefined) {
        if (existingOnly || context.agent === "claude") return null;
        throw new ToolSelectionError(context.agent, "herdr", "launch", "legacy_tool_identity_missing");
      }
      if (configuration.toolLaunch.tool !== context.agent || configuration.toolLaunch.context !== "herdr") throw new Error("The original Herdr tool recipe differs from its execution owner.");
      return createToolLaunchMapping({ directory: options.paths.herdrDirectory, owner: context, launch: configuration.toolLaunch, nativeEnvironment, ...instance.toolMappingRuntime(), ...(existingOnly === undefined ? {} : { existingOnly }) }, operation);
    } }),
    readCodexConfig: (args, cwd, operation, toolLaunch) => readCodexConfiguration({ args, cwd, environment: nativeEnvironment, ...(toolLaunch === undefined ? {} : { toolLaunch }) }, operation) });
  return {
    createShellStartup: instance.createShellStartup,
    ensureInstance: instance.ensure,
    connectInstance: instance.connect,
    stopInstance: async (operation: Operation) => {
      const results = await Promise.allSettled([instance.stop(operation), preflight.close()]);
      const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, "Herdr instance or selection probe shutdown failed.");
      return (results[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof instance.stop>>>).value;
    },
    attachment: instance.attachment,
    paths: instance.paths,
    tasks,
  };
};

export type WorkerHerdrLifecycle = {
  activeToolSelections?(): import("./tool-selection.js").ActiveToolSelection[];
  neverStarted?: {
    candidates(): HerdrExecutionOwner[];
    retired(): { owner: HerdrExecutionOwner; cwd: string; agent: import("./types.js").ExecutionConfiguration["agent"] }[];
    retire(owner: HerdrExecutionOwner, operation: Operation, verifyWorktreeAbsent: (cwd: string) => Promise<void>): Promise<void>;
  };
  archive?: import("./herdr/resource-types.js").HerdrArchiveResources;
  registerClaim(context: HerdrExecutionContext, ownerUserId: string): void;
  assertCanAdvance(context: HerdrExecutionContext): void;
  hasPreparedRun(owner: HerdrExecutionOwner): boolean;
  pendingInitialPrompt?(owner: HerdrExecutionOwner): string | null;
  responsibilities(): HerdrExecutionOwner[];
  /** Original lifecycle path, without reading recording contents or archive state. */
  worktreePath?(owner: HerdrExecutionOwner): string | null;
  isStopped(owner: HerdrExecutionOwner): boolean;
  observeExecutionStop: ExecutionStopObserver;
  stop(owner: HerdrExecutionOwner, reason: "shutdown" | "terminal", operation: Operation): Promise<void>;
  cleanup(owner: HerdrExecutionOwner, prompt: string, operation: Operation, scope: TerminalCleanupContext): Promise<boolean>;
  close(): void;
};
export type WorkerHerdrInput = {
  state(owner: HerdrExecutionOwner): import("../../session/v2/types.js").SessionV2Payloads["control_state"];
  control(owner: HerdrExecutionOwner, message: Extract<import("../../session/v2/types.js").SessionV2Message, { type: "control_dispatch" }>, operation: Operation): Promise<import("../../session/v2/types.js").SessionV2Payloads["control_ack"]>;
  submit(owner: HerdrExecutionOwner, message: Extract<import("../../session/v2/types.js").SessionV2Message, { type: "operation" }>, operation: Operation): Promise<import("../../session/v2/types.js").SessionV2Payloads["operation_result"]>;
  suspend(owner: HerdrExecutionOwner): void;
};
export type WorkerHerdrAdapter = ReturnType<typeof createWorkerHerdr> & {
  lifecycle?: WorkerHerdrLifecycle;
  input?: WorkerHerdrInput;
  /** Restore only an original claim's frozen instance after its old process tree is closed. */
  ensureExecution?(context: HerdrExecutionContext, operation: Operation): Promise<import("./herdr/instance.js").HerdrInstanceReady>;
};
