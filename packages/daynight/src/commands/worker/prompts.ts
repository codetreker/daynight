import path from "node:path";
import { canonicalId } from "../../api/parse.js";
import type { TaskPlatform } from "../../api/types.js";
import { normalizeServerUrl } from "../../config/server.js";
import { captureInstalledSkill } from "../skill/install.js";
import { validateHerdrAgentArguments } from "./herdr/arguments.js";
import type { ClaimIdentity, ExecutionConfiguration, LocalTask, WorktreeBinding } from "./types.js";

export type ManagedAssignment = LocalTask & { serverOrigin: string; workerId: string; worktreeId: string; configuration: ExecutionConfiguration; worktree: WorktreeBinding };

export const createWorkerPromptBuilder = async (packageDirectory: string) => {
  const bundle = await captureInstalledSkill(packageDirectory);
  for (const name of ["SKILL.md", "references/execute-task-in-managed.md", "references/task-execution.md", "references/handbook.md", "references/goal.md", "references/task-content.md"]) {
    const entry = bundle.find((item) => item.relativePath === name);
    if (entry?.type !== "file" || entry.contents.length === 0) throw new Error(`The installed using-daynight bundle is missing ${name}; reinstall the package before starting a worker.`);
  }
  const root = path.join(packageDirectory, "dist", "commands", "skill", "skills", "using-daynight");
  return (task: ManagedAssignment, platform: TaskPlatform): string => {
    if (task.status !== "active") throw new Error("A managed launch requires an active execution.");
    for (const [name, value] of Object.entries({ projectId: task.projectId, taskId: task.taskId, claimId: task.claimId, workerId: task.workerId, worktreeId: task.worktreeId })) {
      if (canonicalId(value) !== value) throw new Error(`Managed assignment ${name} must be a canonical UUID.`);
    }
    if (!["linux", "macos", "windows"].includes(platform)) throw new Error("Managed execution requires a supported actual platform.");
    const { configuration, worktree } = task;
    if (!path.isAbsolute(worktree.repositoryPath) || worktree.worktreePath !== path.join(worktree.repositoryPath, ".worktrees", "daynight", task.taskId) || worktree.branch !== `daynight/${task.taskId}`) throw new Error("The managed assignment must use the task's fixed worktree and branch.");
    if (configuration.agent !== task.agent) throw new Error("The managed assignment configuration must use its recorded agent.");
    validateHerdrAgentArguments(task.agent, configuration.args);
    if (task.sessionId !== null && canonicalId(task.sessionId) !== task.sessionId) throw new Error("The native reference must be an exact session UUID.");
    const assignment = {
      serverOrigin: normalizeServerUrl(task.serverOrigin), projectId: task.projectId, taskId: task.taskId, claimId: task.claimId,
      workerId: task.workerId, worktreeId: task.worktreeId, worktreePath: worktree.worktreePath, branch: worktree.branch,
      platform, nativeSessionId: task.sessionId, configuration,
    };
    return [
      "The current execution environment is worker-managed.",
      "Use the using-daynight skill in execute-task-in-managed mode for this already-claimed assignment.",
      `Read the installed skill entry at ${JSON.stringify(path.join(root, "SKILL.md"))} and its references/execute-task-in-managed.md at ${JSON.stringify(path.join(root, "references", "execute-task-in-managed.md"))}. Resolve its other references from that same bundle.`,
      "Verify the current service task, original claim and actual worktree before business writes.",
      "Execute only this assignment under its task and repository authorization. Preserve the controller-owned worktree and workspace. The controller owns scheduling and cleanup.",
      "After all required delivery, acceptance and evidence, complete the task with the original claimId and the version observed for that decision as the final task mutation. Unconfirmed writes require observation before any further decision.",
      task.sessionId === null ? "This is a new native conversation for this execution." : "Continue this execution in its original native conversation and worktree. Reconcile interrupted business work before proceeding.",
      "Assignment:", JSON.stringify(assignment, null, 2),
    ].join("\n\n");
  };
};

export const workerCleanupPrompt = (task: ClaimIdentity, deadline: number): string => [
  `The controller is stopping this execution: project ${task.projectId}, task ${task.taskId}, original claim ${task.claimId}.`,
  `Release temporary files, services and processes outside the worktree that this execution created and can attribute to itself. This cleanup attempt ends at ${new Date(deadline).toISOString()}.`,
  "Preserve the controller-managed worktree, branch and workspace. Leave other executions and unrelated resources intact. Finish this cleanup turn when attributable temporary resources have been released; the controller will stop this agent.",
].join("\n\n");
