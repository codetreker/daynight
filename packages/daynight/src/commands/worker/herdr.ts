import type { WorkerPaths } from "./paths.js";
import { createHerdrAgentManager } from "./herdr/agents.js";
import { createHerdrInstance } from "./herdr/instance.js";
import { createHerdrPreflight } from "./herdr/preflight.js";

export type {
  HerdrExecutionContext,
  HerdrExecutionOwner,
  HerdrOwnedWorkspace,
  HerdrTaskBinding,
  HerdrWorkspaceEvidence,
  HerdrPreparedWorkspace,
  HerdrAgentConfiguration,
  HerdrAgentObservation,
  HerdrNativeReference,
  HerdrStopObservation,
  HerdrLaunchEvidence,
} from "./herdr/agents.js";
export { HerdrAgentActionError, validateHerdrAgentArguments } from "./herdr/agents.js";
export { HerdrRpcError } from "./herdr/rpc.js";

export const createWorkerHerdr = (options: {
  paths: WorkerPaths;
  homeDirectory: string;
  executable?: string;
  environment?: NodeJS.ProcessEnv;
}) => {
  const inheritedEnvironment = options.environment === undefined ? process.env : options.environment;
  const instance = createHerdrInstance({ ...options, environment: inheritedEnvironment });
  const nativeEnvironment = { ...instance.environment };
  const workspaceEnvironment = { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "" };
  for (const key of ["XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const) {
    const value = inheritedEnvironment[key];
    if (value === undefined) delete nativeEnvironment[key];
    else nativeEnvironment[key] = value;
    // Herdr's workspace map cannot remove keys; empty XDG values select the user's defaults.
    // https://specifications.freedesktop.org/basedir/latest/
    workspaceEnvironment[key] = value === undefined ? "" : value;
  }
  const preflight = createHerdrPreflight({
    rpc: instance.rpc,
    environment: nativeEnvironment,
    homeDirectory: options.homeDirectory,
  });
  const tasks = createHerdrAgentManager({ rpc: instance.rpc, session: "w", preflight: {
    verifyStart: (input, operation) => {
      return preflight.verifyStart({ ...input, configuration: { ...input.configuration, agent: input.configuration.agent } }, operation);
    },
  }, workspaceEnvironment });
  return {
    ensureInstance: instance.ensure,
    stopInstance: instance.stop,
    attachment: instance.attachment,
    paths: instance.paths,
    tasks,
  };
};

export type WorkerHerdrAdapter = ReturnType<typeof createWorkerHerdr>;
