import type { WorkerPaths } from "./paths.js";
import { createHerdrAgentManager } from "./herdr/agents.js";
import { createHerdrInstance } from "./herdr/instance.js";
import { createHerdrPreflight } from "./herdr/preflight.js";

export type {
  HerdrExecutionContext,
  HerdrExecutionOwner,
  HerdrOwnedWorkspace,
  HerdrTaskBinding,
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
  const instance = createHerdrInstance(options);
  const preflight = createHerdrPreflight({
    rpc: instance.rpc,
    environment: instance.environment,
    homeDirectory: options.homeDirectory,
  });
  const tasks = createHerdrAgentManager({ rpc: instance.rpc, session: "w", preflight });
  return {
    ensureInstance: instance.ensure,
    stopInstance: instance.stop,
    attachment: instance.attachment,
    paths: instance.paths,
    tasks,
  };
};

export type WorkerHerdrAdapter = ReturnType<typeof createWorkerHerdr>;
