import { canonicalId } from "../../api/parse.js";
import { validateWorkerRepositoryLocations } from "./config.js";
import type { WorkerPaths } from "./paths.js";
import type { WorkerStore } from "./store.js";
import type { WorkerProject } from "./types.js";

export const createWorkerRepositoryAdmission = (options: {
  readonly paths: WorkerPaths;
  readonly store: () => WorkerStore;
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
        return store.registerProject({ ...candidate, projectId });
      });
      // Each caller retains its failure while the next admission reads the latest retained bindings.
      pending = admission.then(() => undefined, () => undefined);
      return admission;
    },
  };
};
