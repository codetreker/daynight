import { canonicalId } from "../../api/parse.js";
import { validateWorkerRepositoryLocations } from "./config.js";
import type { WorkerPaths } from "./paths.js";
import type { WorkerStore } from "./store.js";
import type { ResourceOwner, WorkerProject } from "./types.js";
import type { WorkerRepository } from "./worktrees.js";
import type { WorkerHerdrAdapter } from "./herdr.js";
import type { Operation } from "../../api/operation.js";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { openWebExecutionStore } from "./backends/web-store.js";
import { migrateLegacyWorktrees } from "./worktrees/migration.js";
import { resolvePhysicalDirectory } from "../../platform/filesystem.js";

const exists = async (target: string): Promise<boolean> => {
  try { await lstat(target); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
};

/** Prepare a repository using complete original backend observations. */
export const prepareWorkerWorktreeFormat = async (options: {
  paths: WorkerPaths;
  store: WorkerStore;
  project: WorkerProject;
  repository: WorkerRepository;
  operation: Operation;
  platform: "macos" | "linux" | "windows";
  getHerdr(): Promise<WorkerHerdrAdapter>;
  verifyWebUnregistered?(identity: { projectId: string; taskId: string; claimId: string }, signal: AbortSignal): Promise<void>;
}): Promise<void> => {
  const { paths, store, project, repository, operation } = options;
  let web: ReturnType<typeof openWebExecutionStore> | undefined;
  let backend: Promise<{ herdr: WorkerHerdrAdapter | undefined; lifecycle: NonNullable<WorkerHerdrAdapter["lifecycle"]>["migration"]; legacySession: boolean }> | undefined;
  const observeBackend = () => backend ??= (async () => {
    const journal = await exists(path.join(paths.workerDirectory, "herdr-executions.sqlite"));
    const legacySession = await exists(path.join(paths.herdrDirectory, "c", "herdr", "sessions", "w"));
    const unfinishedLegacy = (await selected(store.listUnfinishedTasks().filter(task => task.agentControlMode !== "web"), async task => {
      if (task.projectId === project.projectId) return true;
      const binding = store.getProject(task);
      if (binding === null) throw new Error("An unfinished Herdr task has no original repository binding.");
      return sameRepository(binding.localPath);
    })).length > 0;
    if (journal && options.platform !== "macos") throw new Error("A native Herdr lifecycle journal cannot be observed on this platform.");
    if (unfinishedLegacy && !journal && !legacySession) throw new Error("The original Herdr backend cannot be observed for worktree migration.");
    const herdr = journal || legacySession ? await options.getHerdr() : undefined;
    const lifecycle = herdr?.lifecycle?.migration;
    if (journal && (!lifecycle || !herdr?.lifecycle?.archive)) throw new Error("The original Herdr lifecycle migration sources are unavailable.");
    return { herdr, lifecycle, legacySession };
  })();
  const sameRepository = async (candidate: string): Promise<boolean> => {
    if (!path.isAbsolute(candidate)) throw new Error("An original repository path is not absolute.");
    if (path.normalize(candidate) === path.normalize(repository.root)) return true;
    const [left, right] = await Promise.all([resolvePhysicalDirectory(candidate), resolvePhysicalDirectory(repository.root)]);
    const a = path.join(left.ancestorPath, ...left.missingComponents), b = path.join(right.ancestorPath, ...right.missingComponents);
    if (a === b) return true;
    if ((left.missingComponents.length || right.missingComponents.length) && a.toLowerCase() === b.toLowerCase()) throw new Error("The original repository path has ambiguous missing case spelling.");
    return false;
  };
  const cwdRepository = (cwd: string): string => path.dirname(path.dirname(path.dirname(cwd)));
  const relevant = async (projectId: string, root: string): Promise<boolean> => projectId === project.projectId || await sameRepository(root);
  const selected = async <T>(values: readonly T[], predicate: (value: T) => Promise<boolean>): Promise<T[]> => {
    const decisions = await Promise.all(values.map(predicate));
    return values.filter((_value, index) => decisions[index]);
  };
  const webTasks = () => { const source = web ??= openWebExecutionStore(path.join(paths.workerDirectory, "web-executions.sqlite")); return [...source.listUnfinishedTasks(), ...source.listCompletedTasks()]; };
  let webObservation: ReturnType<typeof observeRelevantWeb> | undefined;
  const observeRelevantWeb = async () => {
    const records = await selected(webTasks(), async value => await relevant(value.projectId, value.repositoryPath)
      || value.resources.worktree !== null && await sameRepository(value.resources.worktree.repositoryPath));
    const local = await selected(store.listUnfinishedTasks().filter(task => task.agentControlMode === "web"), async task => {
      if (task.projectId === project.projectId) return true;
      const binding = store.getProject(task);
      if (binding === null) throw new Error("An unfinished Web task has no original repository binding.");
      return sameRepository(binding.localPath);
    });
    for (const task of local) {
      if (records.some(record => record.projectId === task.projectId && record.taskId === task.taskId && record.claimId === task.claimId)) continue;
      if (task.sessionId !== null || !options.verifyWebUnregistered) throw new Error("The original Web execution evidence is missing; worktree migration is prohibited.");
      operation.check();
      await options.verifyWebUnregistered({ projectId: task.projectId, taskId: task.taskId, claimId: task.claimId }, operation.signal);
      operation.check();
    }
    return records;
  };
  const relevantWeb = () => {
    if (webObservation) return webObservation;
    const observation = observeRelevantWeb();
    webObservation = observation;
    void observation.finally(() => { if (webObservation === observation) webObservation = undefined; }).catch(() => {});
    return observation;
  };
  const relevantLifecycles = async () => {
    const lifecycle = (await observeBackend()).lifecycle;
    const records = await selected(lifecycle?.listLifecycles() ?? [], value => relevant(value.owner.projectId, cwdRepository(value.cwd)));
    for (const record of records) lifecycle!.assertOrigin(record);
    return records;
  };
  let bindingObservation: Promise<{ owner: ResourceOwner; cwd: string }[]> | undefined;
  const relevantBindings = (): Promise<{ owner: ResourceOwner; cwd: string }[]> => {
    if (bindingObservation) return bindingObservation;
    const observation = (async () => {
      const { herdr, lifecycle, legacySession } = await observeBackend();
      const lifecycleProjects = [...new Set((await relevantLifecycles()).map(value => value.owner.projectId))];
      const workspaces = [
        ...(lifecycle ? (await Promise.all(lifecycleProjects.map(id => lifecycle.listBindings(id, operation)))).flat() : []),
        ...(legacySession && herdr ? lifecycle ? await lifecycle.listLegacyBindings(operation) : (await herdr.ensureInstance(operation), await herdr.tasks.listResources(operation)) : []),
      ];
      const bindings = (await selected(workspaces, async value => {
        if (value.owner.projectId === project.projectId) return true;
        const location = store.getProject(value.owner);
        if (location && await sameRepository(location.localPath)) return true;
        if (value.panes.length === 0 || value.panes.some(pane => pane.cwd === null)) throw new Error("An original Herdr workspace has no complete cwd observation.");
        return (await Promise.all(value.panes.map(pane => sameRepository(cwdRepository(pane.cwd!))))).some(Boolean);
      })).flatMap(workspace => {
        if (workspace.panes.length === 0 || workspace.panes.some(pane => pane.cwd === null)) throw new Error("An original Herdr workspace has no complete cwd observation.");
        return workspace.panes.map(pane => ({ owner: workspace.owner, cwd: pane.cwd! }));
      });
      for (const stop of herdr?.tasks.pendingStops() ?? []) if (await relevant(stop.context.projectId, cwdRepository(stop.context.cwd))) bindings.push({ owner: stop.context, cwd: stop.context.cwd });
      return bindings;
    })();
    bindingObservation = observation;
    void observation.finally(() => { if (bindingObservation === observation) bindingObservation = undefined; }).catch(() => {});
    return observation;
  };
  try {
    await migrateLegacyWorktrees({ repositoryPath: repository.root, commonDirectory: repository.commonDirectory, operation, sources: {
      listSchedules: async () => {
        const [webRecords, lifecycles, bindings] = await Promise.all([relevantWeb(), relevantLifecycles(), relevantBindings()]);
        return selected(store.listCleanupSchedules(), async value => {
          if (value.projectId === project.projectId || [...webRecords, ...lifecycles.map(record => ({ ...record.owner, claimId: record.claimId })), ...bindings.map(binding => binding.owner)].some(record => record.projectId === value.projectId && record.taskId === value.taskId && record.claimId === value.claimId)) return true;
          const binding = store.getProject(value);
          if (binding === null) throw new Error("A cleanup schedule has no repository binding or original backend location.");
          return sameRepository(binding.localPath);
        });
      },
      listWebTasks: relevantWeb,
      listHerdrLifecycles: relevantLifecycles,
      listHerdrRetired: async () => {
        const lifecycle = (await observeBackend()).lifecycle;
        const records = await selected(lifecycle?.listRetired() ?? [], value => relevant(value.owner.projectId, cwdRepository(value.cwd)));
        for (const record of records) lifecycle!.assertOrigin(record);
        return records;
      },
      listHerdrResources: async () => selected((await observeBackend()).herdr?.lifecycle?.archive?.resources() ?? [], value => relevant(value.owner.projectId, cwdRepository(value.worktreePath))),
      listHerdrBindings: relevantBindings,
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
