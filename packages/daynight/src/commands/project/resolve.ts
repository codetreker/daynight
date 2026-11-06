import type { Project } from "../../api/types.js";
import type { CliContext } from "../../cli/context.js";
import type { ServerSession } from "../server/runtime.js";

export const resolveProject = async (session: ServerSession, context: CliContext, userId: string, projectId?: string): Promise<Project> => {
  const { api, operation, serverUrl } = session;
  if (projectId !== undefined) return api.getProject(projectId, userId);
  const { discoverRepository } = await import("../../repository/git.js");
  const { readProjectBinding, verifyProjectBinding, projectRepositoryIdentity } = await import("../../repository/binding.js");
  const { ProjectDiscoveryError } = await import("../../repository/discovery-error.js");
  const repository = await discoverRepository(context.workingDirectory(), operation);
  const binding = await readProjectBinding(repository.root, operation);
  const boundApi = { getProject: (id: string) => api.getProject(id, userId), listProjects: () => api.listProjects(userId) };
  const bound = await verifyProjectBinding(binding, { serverUrl, repoIdentity: repository.identity }, boundApi, operation);
  if (bound !== undefined) return bound;
  const projects = await api.listProjects(userId);
  operation.check();
  const matches = projects.filter((project) => projectRepositoryIdentity(project) === repository.identity);
  if (matches.length !== 1) throw new ProjectDiscoveryError(matches.map(({ id }) => id));
  const project = await api.getProject(matches[0]!.id, userId);
  operation.check();
  if (projectRepositoryIdentity(project) !== repository.identity) throw new Error(`Project ${project.id} changed during repository discovery; retry the command to discover its current association.`);
  return project;
};
