import { parseProviderArguments } from "../controller/providers/projection.js";
import type { AgentControlMode, WorkerAgent } from "../../api/types.js";

/** Validate effective arguments before a claim can create native execution responsibility. */
export const requireImplementedWorkerBackend = (configuration: { agent: WorkerAgent; agentControlMode?: AgentControlMode; args?: readonly string[] } | null): void => {
  if (configuration?.agentControlMode === "web" && configuration.args !== undefined) parseProviderArguments(configuration.agent, configuration.args);
};
