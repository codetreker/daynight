import { canonicalId } from "../../api/parse.js";
import { validateWorkerRepositoryLocations } from "./config.js";
import type { WorkerPaths } from "./paths.js";
import type { WorkerStore } from "./store.js";
import type { WorkerProject } from "./types.js";
import path from "node:path";
import { openWebExecutionStore } from "./backends/web-store.js";

export const createWorkerRepositoryAdmission = (options: {
  readonly paths: WorkerPaths;
  readonly store: () => WorkerStore;
  readonly workerId: string;
  readonly serverOrigin: string;
}): { admit(binding: WorkerProject, signal: AbortSignal): Promise<WorkerProject> } => {
  let pending: Promise<void> = Promise.resolve();
  return {
    admit: (binding, signal) => {
      const candidate = { ...binding };
      const admission = pending.then(async () => {
        signal.throwIfAborted();
        const projectId = canonicalId(candidate.projectId);
        if (projectId === null) throw new TypeError("Project ID must be a hyphenated UUID.");
        const store = options.store();
        const retained = store.listProjects().filter(project => project.projectId !== projectId);
        await validateWorkerRepositoryLocations([
          ...retained.map(project => ({ path: project.localPath })), { path: candidate.localPath },
        ], options.paths, signal);
        signal.throwIfAborted();
        const existing = store.getProject({ projectId });
        if (existing === null || existing.repoUrl === candidate.repoUrl && existing.localPath === candidate.localPath) return store.registerProject({ ...candidate, projectId });
        const web = openWebExecutionStore(path.join(options.paths.workerDirectory, "web-executions.sqlite"));
        try {
          const owners = [...web.listUnfinishedTasks(), ...web.listCompletedTasks()]
            .filter(owner => owner.workerId === options.workerId && owner.serverOrigin === options.serverOrigin && owner.projectId === projectId);
          signal.throwIfAborted();
          return store.registerProject({ ...candidate, projectId }, owners);
        } finally { web.close(); }
      });
      // Each caller retains its failure while the next admission reads the latest retained bindings.
      pending = admission.then(() => undefined, () => undefined);
      return admission;
    },
  };
};
