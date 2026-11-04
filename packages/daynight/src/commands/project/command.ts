import { UsageError } from "../../cli/context.js";
import type { CliContext } from "../../cli/context.js";
import { parseCommand, renderCommandHelp } from "../../cli/schema.js";
import { isNonemptyText } from "../../platform/text.js";
import type { runServerCommand } from "../server/runtime.js";
import { projectDefinition } from "./definition.js";

export type ProjectCommandDependencies = { runServerCommand: typeof runServerCommand };

const defaultDependencies: ProjectCommandDependencies = {
  runServerCommand: async (...args) => (await import("../server/runtime.js")).runServerCommand(...args),
};

export const runProjectCommand = async (
  args: readonly string[],
  context: CliContext,
  dependencies: ProjectCommandDependencies = defaultDependencies,
): Promise<void> => {
  const command = parseCommand(projectDefinition, args, ["daynight", "project"], "daynight project --help");
  if (command.kind !== "run") {
    context.stdout(renderCommandHelp(command.command, command.path));
    return;
  }
  if (command.command.name === "transfer") {
    const { prepareTransfer, runTransfer } = await import("./transfer.js");
    const prepared = prepareTransfer(command, context);
    await dependencies.runServerCommand(context, (session) => runTransfer(command, context, session, prepared));
    return;
  }
  const name = command.command.name === "create" ? command.values[0]! : undefined;
  if (name !== undefined && !isNonemptyText(name)) {
    throw new UsageError("Project name must be nonempty UTF-8 text without NUL characters.", "daynight project create --help");
  }
  let projectId: string | undefined;
  if (command.command.name === "show") {
    const { canonicalId } = await import("../../api/parse.js");
    projectId = canonicalId(command.values[0]!) ?? undefined;
    if (projectId === undefined) throw new UsageError("project-id must be a hyphenated UUID.", "daynight project show --help");
  }
  await dependencies.runServerCommand(context, async ({ api, operation }) => {
    operation.check();
    const { renderProject, renderProjectJson, renderProjectList } = await import("./rendering.js");
    operation.check();
    if (command.command.name === "create") {
      const { repositoryIdentity } = await import("../../repository/identity.js");
      operation.check();
      const explicitRepo = command.options.get("--repo") as string | undefined;
      const repoUrl = explicitRepo === undefined
        ? (await (await import("../../repository/git.js")).discoverRepository(context.workingDirectory(), operation)).remote
        : explicitRepo;
      operation.check();
      const identity = repositoryIdentity(repoUrl);
      const projects = await api.listProjects();
      operation.check();
      const matches = projects.filter((project) => repositoryIdentity(project.repoUrl) === identity);
      operation.check();
      if (matches.length > 1) throw new Error(`Multiple projects match this repository (${matches.map(({ id }) => id).join(", ")}); choose an existing project by its ID.`);
      if (matches.length === 1) return `Project already exists.\n${renderProject(matches[0]!)}`;
      const expectedUserId = (await api.getCurrentUser(true)).id;
      operation.check();
      const project = await api.createProject({ name: name!, repoUrl, expectedUserId });
      operation.check();
      return `Project created.\n${renderProject(project)}`;
    }
    if (command.command.name === "list") {
      const projects = await api.listProjects();
      operation.check();
      return command.options.has("--json") ? renderProjectJson(projects) : renderProjectList(projects);
    }
    const project = await api.getProject(projectId!);
    operation.check();
    return command.options.has("--json") ? renderProjectJson(project) : renderProject(project);
  });
};
