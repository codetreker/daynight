import { readCodexConfiguration } from "./herdr/codex-config.js";
import type { WorkerPaths } from "./paths.js";
import type { HerdrExecutionContext, HerdrExecutionOwner, HerdrWorkspaceEnvironment } from "./herdr/agents.js";
import type { Operation } from "../../api/operation.js";
import { createHerdrAgentManager } from "./herdr/agents.js";
import { createHerdrInstance, createHerdrNativeEnvironment } from "./herdr/instance.js";
import { createHerdrPreflight } from "./herdr/preflight.js";

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
  environment?: NodeJS.ProcessEnv;
  agentEnvironment?: Readonly<{ PATH?: string; DN_CONFIG_DIR?: string }>;
  onDaemonSpawn?: (pid: number) => Promise<void>;
  retainOnStartupFailure?: boolean;
  isolatedRun?: boolean;
}) => {
  const inheritedEnvironment = options.environment === undefined ? process.env : options.environment;
  const instance = createHerdrInstance({ ...options, environment: inheritedEnvironment });
  const nativeEnvironment = createHerdrNativeEnvironment(options.paths, inheritedEnvironment);
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
  });
  const tasks = createHerdrAgentManager({ rpc: instance.rpc, session: "w", preflight: {
    verifyStart: (input, operation) => {
      return preflight.verifyStart({ ...input, configuration: { ...input.configuration, agent: input.configuration.agent } }, operation);
    },
  }, workspaceEnvironment, readCodexConfig: (args, cwd, operation) => readCodexConfiguration({ args, cwd, environment: { ...nativeEnvironment, ...workspaceEnvironment } }, operation) });
  return {
    ensureInstance: instance.ensure,
    stopInstance: instance.stop,
    attachment: instance.attachment,
    paths: instance.paths,
    tasks,
  };
};

export type WorkerHerdrLifecycle = {
  archive?: import("./herdr/resource-types.js").HerdrArchiveResources;
  registerClaim(context: HerdrExecutionContext, ownerUserId: string): void;
  assertCanAdvance(context: HerdrExecutionContext): void;
  hasPreparedRun(owner: HerdrExecutionOwner): boolean;
  responsibilities(): HerdrExecutionOwner[];
  isStopped(owner: HerdrExecutionOwner): boolean;
  stop(owner: HerdrExecutionOwner, reason: "shutdown" | "terminal", operation: Operation): Promise<void>;
  cleanup?(owner: HerdrExecutionOwner, prompt: string, operation: Operation): Promise<boolean>;
  close(): void;
};
export type WorkerHerdrInput = {
  state(owner: HerdrExecutionOwner): import("../../session/v2/types.js").SessionV2Payloads["control_state"];
  control(owner: HerdrExecutionOwner, message: Extract<import("../../session/v2/types.js").SessionV2Message, { type: "control_dispatch" }>, operation: Operation): Promise<import("../../session/v2/types.js").SessionV2Payloads["control_ack"]>;
  submit(owner: HerdrExecutionOwner, message: Extract<import("../../session/v2/types.js").SessionV2Message, { type: "operation" }>, operation: Operation): Promise<import("../../session/v2/types.js").SessionV2Payloads["operation_result"]>;
  suspend(owner: HerdrExecutionOwner): void;
};
export type WorkerHerdrAdapter = ReturnType<typeof createWorkerHerdr> & { lifecycle?: WorkerHerdrLifecycle; input?: WorkerHerdrInput };
