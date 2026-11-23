import { CommandFailure } from "./command.ts";

export type WorkerCompletionTask = {
  id: string; projectId: string; version: number; status: string; assignedTo: string | null; allowAgents: boolean;
  properties: { paused?: boolean; worker?: { claimId: string; workerId: string; worktreeId: string; nativeSessionId: string | null; userId: string; state: string; platform: string; agent: string; agentControlMode: string } };
};

export const completeFixtureTask = async (input: {
  projectId: string; taskId: string; userId: string;
  original: { claimId: string; workerId: string; worktreeId: string; nativeSessionId: string | null; state: string; platform: string; agent: string; agentControlMode: string };
  read: () => Promise<WorkerCompletionTask>;
  complete: (version: number) => Promise<unknown>;
}): Promise<void> => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const task = await input.read(), worker = task.properties?.worker;
    if (task.id !== input.taskId || task.projectId !== input.projectId || task.assignedTo !== input.userId || task.allowAgents !== true
      || task.status !== "in_progress" || task.properties?.paused === true || !Number.isSafeInteger(task.version) || task.version < 1
      || !worker || worker.userId !== input.userId || worker.claimId !== input.original.claimId || worker.workerId !== input.original.workerId
      || worker.worktreeId !== input.original.worktreeId || worker.nativeSessionId !== input.original.nativeSessionId || worker.state !== "active"
      || worker.platform !== input.original.platform || worker.agent !== input.original.agent || worker.agentControlMode !== input.original.agentControlMode) {
      throw new Error("Fixture task no longer has the original active Worker assignment and authorization.");
    }
    try { await input.complete(task.version); return; }
    catch (error) {
      const prefix = `worker.complete project=${input.projectId} task=${input.taskId} [response]: version_conflict:`;
      if (!(error instanceof CommandFailure) || error.result.exitCode !== 1 || !error.result.stderr.startsWith(prefix) || attempt === 2) throw error;
    }
  }
};
