import { randomUUID } from "node:crypto";
import { PublicDiagnosticError } from "../../platform/diagnostics.js";
import { terminalText } from "../../platform/terminal.js";
import { confirmTeamChange, requireTeamConfirmation } from "../team/confirmation.js";
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
  const explicit = command.options.get("--team") as string | undefined;
  const target = explicit === undefined || explicit === "personal" ? explicit : (await import("../../api/parse.js")).canonicalId(explicit);
  if (target === null) throw new UsageError("--team must be a hyphenated UUID or personal.", "daynight project create --help");
  let projectId: string | undefined;
  if (command.command.name === "show") {
    projectId = (await import("../../api/parse.js")).canonicalId(command.values[0]!) ?? undefined;
    if (projectId === undefined) throw new UsageError("project-id must be a hyphenated UUID.", "daynight project show --help");
  }
  await dependencies.runServerCommand(context, async ({ api, operation, serverUrl }) => {
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
      const confirmed = command.options.has("--confirm");
      requireTeamConfirmation(context, confirmed);
      const user = await api.getTeamCurrentUser();
      const { readTeamDefault, teamTarget } = await import("../team/context.js");
      const configured = target === undefined ? await readTeamDefault(context.homeDirectory(), serverUrl, user, operation.signal) : undefined;
      const teamId = teamTarget(target ?? configured ?? "personal", user);
      const team = await api.getTeam(user.id, teamId);
      if ((team.kind === "personal") !== (team.id === user.personalTeam.id)) throw new (await import("../../api/parse.js")).ProtocolError("Team does not match the current user's Personal Team.");
      operation.check();
      const teamName = team.kind === "personal" ? "Personal" : terminalText(JSON.stringify(team.name));
      await confirmTeamChange(context, confirmed, `Create Project ${terminalText(JSON.stringify(name))} for repository ${terminalText(JSON.stringify(repoUrl))} in Team ${teamName} (${team.id}, ${team.membership.role})?`, operation.signal);
      const requestId = randomUUID();
      let project;
      try { project = await api.createProject({ name: name!, repoUrl, expectedUserId: user.id, teamId }, requestId); }
      catch (cause) {
        const { ApiError } = await import("../../api/client.js");
        if (cause instanceof ApiError && cause.confirmedMutationId !== undefined) throw new PublicDiagnosticError(`Project creation was confirmed for Project ${cause.confirmedMutationId}, but local request cleanup failed.`, 1, { cause });
        if (cause instanceof ApiError && cause.outcomeUnconfirmed) throw new Error(`Project creation outcome is unknown (requestId=${requestId}); read current state before deciding on a new operation.`, { cause });
        throw cause;
      }
      const failureText = (phase: string): string => `Project creation was confirmed for Project ${project.id}, but local ${phase} failed.`;
      let output: string;
      try { output = `Project created.\n${renderProject(project)}`; }
      catch (cause) { throw new PublicDiagnosticError(failureText("rendering"), 1, { cause }); }
      return { kind: "confirmed-mutation" as const, output, failureText };
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
