import type { AgentControlMode, WorkerAgent } from "./types.js";

/** Missing legacy fields retain Herdr; explicit invalid values never select a backend. */
export const workerAgentControlMode = (value: { agentControlMode?: unknown }): AgentControlMode => {
  if (!Object.hasOwn(value, "agentControlMode")) return "herdr";
  if (value.agentControlMode !== "herdr" && value.agentControlMode !== "web") throw new TypeError("Worker agentControlMode must be herdr or web.");
  return value.agentControlMode;
};

export const validateWorkerAgentMode = (agent: unknown, _mode: AgentControlMode): WorkerAgent => {
  if (agent !== "codex" && agent !== "copilot" && agent !== "claude") throw new TypeError("Worker agent must be codex, copilot or claude.");
  return agent;
};
