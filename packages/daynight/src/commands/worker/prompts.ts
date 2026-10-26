import path from "node:path";
import { canonicalId } from "../../api/parse.js";
import type { TaskPlatform } from "../../api/types.js";
import { normalizeServerUrl } from "../../config/server.js";
import { captureInstalledSkill } from "../skill/install.js";
import { validateHerdrAgentArguments } from "./herdr/arguments.js";
import type { LocalTask } from "./types.js";

export const createWorkerPromptBuilder = async (packageDirectory: string) => {
  const bundle = await captureInstalledSkill(packageDirectory);
  for (const name of ["SKILL.md", "references/execute-task-in-managed.md", "references/task-execution.md", "references/handbook.md", "references/goal.md", "references/task-content.md"]) {
    const entry = bundle.find((item) => item.relativePath === name);
    if (entry?.type !== "file" || entry.contents.length === 0) throw new Error(`The installed using-daynight bundle is missing ${name}; reinstall the package before starting a worker.`);
  }
  const root = path.join(packageDirectory, "dist", "commands", "skill", "skills", "using-daynight");
  return (task: LocalTask, platform: TaskPlatform): string => {
    if (task.status !== "active" || task.cleanup !== null || task.control !== null) throw new Error("A managed launch requires an active execution without cleanup or management intent.");
    for (const [name, value] of Object.entries({ projectId: task.projectId, taskId: task.taskId, claimId: task.claimId, workerId: task.workerId, worktreeId: task.worktreeId })) {
      if (canonicalId(value) !== value) throw new Error(`Managed assignment ${name} must be a canonical UUID.`);
    }
    if (!["linux", "macos", "windows"].includes(platform)) throw new Error("Managed execution requires a supported actual platform.");
    const configuration = task.configuration;
    const worktree = task.resources.worktree;
    if (configuration === null || worktree === null) throw new Error("Managed execution requires the original frozen configuration and worktree binding.");
    if (!path.isAbsolute(task.repositoryPath) || worktree.repositoryPath !== task.repositoryPath || worktree.worktreePath !== path.join(task.repositoryPath, ".worktrees", "daynight", task.taskId) || worktree.branch !== `daynight/${task.taskId}`) throw new Error("The managed assignment does not match its original fixed worktree and branch.");
    validateHerdrAgentArguments(configuration.agent, configuration.args);
    if ((configuration.model !== null && (typeof configuration.model !== "string" || configuration.model.trim() === "")) || !Number.isSafeInteger(configuration.recoveryLimit) || configuration.recoveryLimit < 0) throw new Error("The managed assignment has an invalid frozen execution configuration.");
    const native = task.resources.nativeSession;
    if (native !== null && canonicalId(native.sessionId) !== native.sessionId) throw new Error("The original native reference must be an exact session UUID.");
    const assignment = {
      serverOrigin: normalizeServerUrl(task.serverOrigin),
      projectId: task.projectId, taskId: task.taskId, claimId: task.claimId,
      workerId: task.workerId, worktreeId: task.worktreeId,
      worktreePath: worktree.worktreePath, branch: worktree.branch,
      platform, nativeSession: native, configuration,
    };
    return [
      "The current execution environment is worker-managed.",
      "Use the using-daynight skill in execute-task-in-managed mode for this already-claimed assignment.",
      `Read the installed skill entry at ${JSON.stringify(path.join(root, "SKILL.md"))} and its references/execute-task-in-managed.md at ${JSON.stringify(path.join(root, "references", "execute-task-in-managed.md"))}. Resolve its other references from that same bundle.`,
      "Verify the current service task, original claim, actual worktree and frozen configuration before business writes. Missing or mismatched context means wait for intervention.",
      "Execute only this assignment under its task and repository authorization. Preserve the controller-owned worktree and workspace. The controller owns scheduling and cleanup.",
      "After all required delivery, acceptance and evidence, complete the task with the original claimId and the version observed for that decision as the final task mutation. Unconfirmed writes require observation before any further decision.",
      native === null ? "This is the initial native conversation for this execution." : "Continue this same execution using its original native conversation, worktree and frozen configuration. Reconcile interrupted work before proceeding.",
      "Assignment:",
      JSON.stringify(assignment, null, 2),
    ].join("\n\n");
  };
};

export const workerCleanupPrompt = (task: LocalTask): string => {
  if (task.cleanup === null) throw new Error("A cleanup request requires its persisted original deadline.");
  return [
    `The controller is stopping this execution: project ${task.projectId}, task ${task.taskId}, original claim ${task.claimId}.`,
    `Release temporary files, services and processes outside the worktree that this execution created and can attribute to itself. The original deadline is ${new Date(task.cleanup.deadline).toISOString()}.`,
    "Preserve the controller-managed worktree, branch and workspace. Leave other executions and unrelated resources intact. Finish this cleanup turn when attributable temporary resources have been released; the controller will stop this original agent.",
  ].join("\n\n");
};
