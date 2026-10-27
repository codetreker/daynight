import type { Project } from "../../api/types.js";
import { CliCancelledError, withCliCancellation } from "../../cli/cancellation.js";
import type { CliContext } from "../../cli/context.js";
import { terminalText } from "../../platform/terminal.js";
import { readWorkerConfiguration } from "./config.js";
import type { WorkerRepositoryConfiguration } from "./config.js";
import { resolveWorkerPaths } from "./paths.js";
import { changeWorkerRepositories, configuredWorkerProjectIds, readWorkerProjects, readWorkerRepositorySnapshot } from "./repositories.js";

export type WorkerRepositoryCommandRequest = { kind: "list"; json: boolean }
  | { kind: "add" | "remove"; projectId?: string };

export type WorkerRepositoryGuideDependencies = {
  readConfiguration: typeof readWorkerConfiguration;
  readSnapshot: typeof readWorkerRepositorySnapshot;
  readProjects: typeof readWorkerProjects;
  configuredProjectIds: typeof configuredWorkerProjectIds;
  change: typeof changeWorkerRepositories;
};

const defaultDependencies: WorkerRepositoryGuideDependencies = {
  readConfiguration: readWorkerConfiguration,
  readSnapshot: readWorkerRepositorySnapshot,
  readProjects: readWorkerProjects,
  configuredProjectIds: configuredWorkerProjectIds,
  change: changeWorkerRepositories,
};

const projectLabel = (project: Project): string =>
  `${terminalText(project.name)} · ${project.id} · ${terminalText(project.repoUrl)}`;

const renderRepositories = (repositories: readonly WorkerRepositoryConfiguration[], json: boolean): string => {
  const summaries = repositories.map(({ projectId, remote, path }) => ({ projectId: projectId === undefined ? null : projectId, remote, path }));
  if (json) return `${JSON.stringify(summaries, null, 2)}\n`;
  if (summaries.length === 0) return "No worker repositories configured.\n";
  return summaries.map(({ projectId, remote, path }) => [
    `Project: ${projectId === null ? "Matched by repository at startup" : projectId}`,
    `Repository: ${terminalText(remote)}`,
    `Path: ${terminalText(path)}`,
    "",
  ].join("\n")).join("\n");
};

const changeRepositories = async (
  request: Extract<WorkerRepositoryCommandRequest, { kind: "add" | "remove" }>,
  context: CliContext,
  dependencies: WorkerRepositoryGuideDependencies,
  signal: AbortSignal,
): Promise<void> => {
  const paths = resolveWorkerPaths(context.homeDirectory());
  const snapshot = await dependencies.readSnapshot(paths, signal);
  const projects = await dependencies.readProjects(snapshot, signal);
  signal.throwIfAborted();
  if (projects.length === 0) throw new Error("No accessible Daynight Projects exist. Create a Project before configuring worker repositories.");
  let projectIds: readonly string[];
  if (request.projectId !== undefined) {
    if (!projects.some(({ id }) => id === request.projectId)) throw new Error(`Project ${request.projectId} does not exist or is not accessible.`);
    projectIds = [request.projectId];
  } else {
    const configured = new Set(dependencies.configuredProjectIds(snapshot, projects));
    const choices = projects.filter(({ id }) => request.kind === "add" ? !configured.has(id) : configured.has(id));
    if (choices.length === 0) throw new Error(request.kind === "add"
      ? "All accessible Daynight Projects are already configured for this worker."
      : "No configured worker repository matches an accessible Daynight Project.");
    const prompt = context.prompt;
    if (prompt?.isInteractive !== true) throw new Error(`Interactive worker repository configuration requires terminal input and stderr. Run daynight worker repo ${request.kind} --project <project-id>.`);
    projectIds = await prompt.selectMany<string>({
      message: request.kind === "add" ? "Run tasks from which existing Daynight Projects?" : "Remove which existing Daynight Projects from worker configuration?",
      choices: choices.map((project) => ({ name: projectLabel(project), value: project.id })),
      requiredMessage: "Select at least one Project.",
    }, signal);
    signal.throwIfAborted();
    const available = new Set(choices.map(({ id }) => id));
    if (projectIds.length === 0 || projectIds.some((id) => !available.has(id)) || new Set(projectIds).size !== projectIds.length) {
      throw new Error("Select one or more distinct Projects from the available choices.");
    }
  }
  signal.throwIfAborted();
  await dependencies.change({
    paths, homeDirectory: context.homeDirectory(), snapshot, projects,
    ...(request.kind === "add" ? { addProjectIds: projectIds } : { removeProjectIds: projectIds }),
    signal,
  });
  signal.throwIfAborted();
  context.stderr(`Worker repositories saved to ${paths.configFile}. Changes apply at the next worker startup.\n`);
};

export const ensureWorkerRepositories = async (
  context: CliContext,
  dependencies: WorkerRepositoryGuideDependencies = defaultDependencies,
  suppliedSignal?: AbortSignal,
): Promise<void> => withCliCancellation(context, async (signal) => {
  signal.throwIfAborted();
  const configuration = await dependencies.readConfiguration(resolveWorkerPaths(context.homeDirectory()), signal);
  if (configuration.repositories.length > 0) return;
  await changeRepositories({ kind: "add" }, context, dependencies, signal);
}, suppliedSignal, () => new CliCancelledError("Worker repository configuration cancelled."));

export const runWorkerRepositoryCommand = async (
  request: WorkerRepositoryCommandRequest,
  context: CliContext,
  dependencies: WorkerRepositoryGuideDependencies = defaultDependencies,
  suppliedSignal?: AbortSignal,
): Promise<void> => withCliCancellation(context, async (signal) => {
  signal.throwIfAborted();
  if (request.kind === "list") {
    const configuration = await dependencies.readConfiguration(resolveWorkerPaths(context.homeDirectory()), signal);
    context.stdout(renderRepositories(configuration.repositories, request.json));
    return;
  }
  await changeRepositories(request, context, dependencies, signal);
}, suppliedSignal, () => new CliCancelledError("Worker repository configuration cancelled."));
