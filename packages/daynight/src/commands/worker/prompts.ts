import { parseProviderArguments } from "../controller/providers/projection.js";
import path from "node:path";
import { canonicalId } from "../../api/parse.js";
import type { TaskPlatform } from "../../api/types.js";
import { normalizeServerUrl } from "../../config/server.js";
import { validateHerdrAgentArguments } from "./herdr/arguments.js";
import type { ClaimIdentity, ExecutionConfiguration, LocalTask, WorktreeBinding } from "./types.js";
import type { WorkerPromptTuple } from "./prompt-source.js";
import { assignmentInstruction, humanInterventionInstruction, ongoingWaitInstruction, completionInstruction } from "./execution-contract.js";

export const appendWorkerPrompts = (builtin: string, values: WorkerPromptTuple): string => {
  const blocks = (["user", "project", "worker"] as const)
    .filter(scope => values[scope].text !== "")
    .map(scope => `----- begin ${scope} prompt -----\n${values[scope].text}\n----- end ${scope} prompt -----`);
  return blocks.length === 0 ? builtin : [builtin, ...blocks].join("\n\n");
};

export type ManagedAssignment = LocalTask & { serverOrigin: string; workerId: string; worktreeId: string; configuration: ExecutionConfiguration; worktree: WorktreeBinding };
export const buildWorkerPrompt = (task: ManagedAssignment, platform: TaskPlatform): string => {
  if (task.status !== "active") throw new Error("A managed launch requires an active execution.");
  for (const [name, value] of Object.entries({ projectId: task.projectId, taskId: task.taskId, claimId: task.claimId, workerId: task.workerId, worktreeId: task.worktreeId })) {
    if (canonicalId(value) !== value) throw new Error(`Managed assignment ${name} must be a canonical UUID.`);
  }
  if (!["linux", "macos", "windows"].includes(platform)) throw new Error("Managed execution requires a supported actual platform.");
  const { configuration, worktree } = task;
  if (!path.isAbsolute(worktree.repositoryPath) || worktree.worktreePath !== path.join(worktree.repositoryPath, ".worktrees", "daynight", task.taskId) || worktree.branch !== `daynight/${task.taskId}`) throw new Error("The managed assignment must use the task's fixed worktree and branch.");
  if (configuration.agent !== task.agent) throw new Error("The managed assignment configuration must use its recorded agent.");
  if (configuration.agentControlMode === "web") parseProviderArguments(task.agent, configuration.args);
  else validateHerdrAgentArguments(task.agent, configuration.args);
  if (task.sessionId !== null && canonicalId(task.sessionId) !== task.sessionId) throw new Error("The native reference must be an exact session UUID.");
  const assignment = {
    serverOrigin: normalizeServerUrl(task.serverOrigin), projectId: task.projectId, taskId: task.taskId, claimId: task.claimId,
    workerId: task.workerId, worktreeId: task.worktreeId, worktreePath: worktree.worktreePath, branch: worktree.branch,
    platform, nativeSessionId: task.sessionId, configuration: {
      agent: configuration.agent, model: configuration.model, args: configuration.args, recoveryLimit: configuration.recoveryLimit,
      ...(configuration.agentControlMode === undefined ? {} : { agentControlMode: configuration.agentControlMode }),
      ...(configuration.validateNativeSelection === undefined ? {} : { validateNativeSelection: configuration.validateNativeSelection }),
    },
  };
  return [
    "The current execution environment is worker-managed.",
    "This is a background task. Make decisions autonomously within this assignment and its existing authorization.",
    assignmentInstruction,
    humanInterventionInstruction,
    ongoingWaitInstruction,
    completionInstruction,
    task.sessionId === null ? "This is a new native conversation for this execution." : "Continue this execution in its original native conversation and worktree. Reconcile interrupted business work before proceeding.",
    "Assignment:", JSON.stringify(assignment, null, 2),
  ].join("\n\n");
};

export const workerPingPrompt = (task: ClaimIdentity): string => [
  "<system remider>",
  `This is the worker's periodic check for project ${task.projectId}, task ${task.taskId}, original claim ${task.claimId}.`,
  "Continue the current assignment in its original native conversation and worktree, preserving its scope, existing authorization and worker-managed execution rules. This is a background task. Make decisions autonomously within that scope and authorization.",
  humanInterventionInstruction,
  ongoingWaitInstruction,
  completionInstruction,
  "</system remider>",
].join("\n\n");

export const workerCleanupPrompt = (task: ClaimIdentity, deadline: number): string => [
  `The controller is stopping this execution: project ${task.projectId}, task ${task.taskId}, original claim ${task.claimId}.`,
  `Release temporary files, services and processes outside the worktree that this execution created and can attribute to itself. This cleanup attempt ends at ${new Date(deadline).toISOString()}.`,
  "Preserve the controller-managed worktree, branch and workspace. Leave other executions and unrelated resources intact. Finish this cleanup turn when attributable temporary resources have been released; the controller will stop this agent.",
].join("\n\n");
