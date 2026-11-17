import { canonicalId } from "../../api/parse.js";
import { validateWorkerRepositoryLocations } from "./config.js";
import type { WorkerPaths } from "./paths.js";
import type { WorkerStore } from "./store.js";
import type { ResourceOwner, WorkerProject } from "./types.js";
import type { WorkerRepository } from "./worktrees.js";
import type { Operation } from "../../api/operation.js";
import path from "node:path";
import { openWebExecutionStore } from "./backends/web-store.js";
import { migrateLegacyWorktrees } from "./worktrees/migration.js";
import { resolvePhysicalDirectory } from "../../platform/filesystem.js";

/** Prepare a repository using complete original backend observations. */
export const prepareWorkerWorktreeFormat = async (options: {
  paths: WorkerPaths;
  store: WorkerStore;
  project: WorkerProject;
  repository: WorkerRepository;
  operation: Operation;
  serverOrigin: string; workerId: string; userId: string;
}): Promise<void> => {
  const { paths, store, project, repository, operation } = options;
  let web: ReturnType<typeof openWebExecutionStore> | undefined;
  const sameRepository = async (candidate: string): Promise<boolean> => {
    if (!path.isAbsolute(candidate)) throw new Error("An original repository path is not absolute.");
    if (path.normalize(candidate) === path.normalize(repository.root)) return true;
    const [left, right] = await Promise.all([resolvePhysicalDirectory(candidate), resolvePhysicalDirectory(repository.root)]);
    const a = path.join(left.ancestorPath, ...left.missingComponents), b = path.join(right.ancestorPath, ...right.missingComponents);
    if (a === b) return true;
    if ((left.missingComponents.length || right.missingComponents.length) && a.toLowerCase() === b.toLowerCase()) throw new Error("The original repository path has ambiguous missing case spelling.");
    return false;
  };
  const relevant = async (projectId: string, root: string): Promise<boolean> => projectId === project.projectId || await sameRepository(root);
  const selected = async <T>(values: readonly T[], predicate: (value: T) => Promise<boolean>): Promise<T[]> => {
    const decisions = await Promise.all(values.map(predicate));
    return values.filter((_value, index) => decisions[index]);
  };
  const webTasks = () => { const source = web ??= openWebExecutionStore(path.join(paths.workerDirectory, "web-executions.sqlite")); return [...source.listUnfinishedTasks(), ...source.listCompletedTasks()]; };
  let webObservation: ReturnType<typeof observeRelevantWeb> | undefined;
  const observeRelevantWeb = async () => {
    const records = await selected(webTasks(), async value => value.serverOrigin === options.serverOrigin && value.workerId === options.workerId && value.userId === options.userId && (await relevant(value.projectId, value.repositoryPath)
      || value.resources.worktree !== null && await sameRepository(value.resources.worktree.repositoryPath)));
    return records;
  };
  const relevantWeb = () => {
    if (webObservation) return webObservation;
    const observation = observeRelevantWeb();
    webObservation = observation;
    void observation.finally(() => { if (webObservation === observation) webObservation = undefined; }).catch(() => {});
    return observation;
  };
  try {
    await migrateLegacyWorktrees({ repositoryPath: repository.root, commonDirectory: repository.commonDirectory, operation, sources: {
      listSchedules: async () => {
        const records = await relevantWeb();
        return store.listCleanupSchedules().filter(value => records.some(record => record.projectId === value.projectId && record.taskId === value.taskId && record.claimId === value.claimId && record.worktreeId === value.worktreeId));
      },
      listWebTasks: relevantWeb,
    } });
  } finally { web?.close(); }
};

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
