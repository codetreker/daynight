import type { AgentControlMode, WorkerAgent } from "./types.js";

export const validateWorkerAgentMode = (agent: unknown, _mode: AgentControlMode): WorkerAgent => {
  if (agent !== "codex" && agent !== "copilot" && agent !== "claude") throw new TypeError("Worker agent must be codex, copilot or claude.");
  return agent;
};
