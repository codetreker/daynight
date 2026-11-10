import type { WorkerGitManager } from "../../src/commands/worker/execution.js";

type CompleteScan = {
  enumerationComplete: true;
  validated: Awaited<ReturnType<WorkerGitManager["listWorktrees"]>>;
  quarantined: never[];
  unknown: never[];
};

// These collaborators model complete inventories; partial coverage needs an
// explicit scan result or real Git observations.
export async function scanFromList(
  this: Pick<WorkerGitManager, "listWorktrees">,
  ...args: Parameters<WorkerGitManager["listWorktrees"]>
): Promise<CompleteScan> {
  return { enumerationComplete: true, validated: await this.listWorktrees(...args), quarantined: [], unknown: [] };
}
