import type { Operation, Project } from "../api/index.js";
import { persistProjectBinding, projectRepositoryIdentity, readProjectBinding, verifyProjectBinding } from "./binding.js";
import type { ProjectApi } from "./binding.js";
import { discoverRepository } from "./git.js";
import { ProjectDiscoveryError } from "./discovery-error.js";

export type ResolveProjectOptions = {
  readonly serverUrl: string;
  readonly operation: Operation;
  readonly api: ProjectApi;
  readonly workingDirectory: string;
  readonly projectId?: string;
};

export const resolveProject = async (options: ResolveProjectOptions): Promise<Project> => {
  const { operation, api, serverUrl } = options;
  operation.check();
  if (options.projectId !== undefined) {
    const project = await api.getProject(options.projectId);
    operation.check();
    return project;
  }
  const repository = await discoverRepository(options.workingDirectory, operation);
  operation.check();
  const context = { serverUrl, repoIdentity: repository.identity };
  const binding = await readProjectBinding(repository.root, operation);
  const cached = await verifyProjectBinding(binding, context, api, operation);
  if (cached !== undefined) return cached;
  const projects = await api.listProjects();
  operation.check();
  const matches = projects.filter((project) => projectRepositoryIdentity(project) === repository.identity);
  operation.check();
  if (matches.length !== 1) throw new ProjectDiscoveryError(matches.map(({ id }) => id));
  const selected = await api.getProject(matches[0]!.id);
  operation.check();
  if (projectRepositoryIdentity(selected) !== repository.identity) throw new Error(`Project ${selected.id} changed during repository discovery; retry the command to discover its current association.`);
  return persistProjectBinding({ root: repository.root, binding: { ...context, projectId: selected.id }, project: selected, operation, api });
};
