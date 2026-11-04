import { canonicalId, ProtocolError } from "../../api/parse.js";
import type { Team, User } from "../../api/types.js";
import { UsageError } from "../../cli/context.js";
import type { CliContext } from "../../cli/context.js";
import { parseCommand, renderCommandHelp } from "../../cli/schema.js";
import type { runServerCommand } from "../server/runtime.js";
import { teamDefinition } from "./definition.js";

export type TeamCommandDependencies = { runServerCommand: typeof runServerCommand };
const defaults: TeamCommandDependencies = { runServerCommand: async (...args) => (await import("../server/runtime.js")).runServerCommand(...args) };

const verifyPersonal = (team: Team, user: User): Team => {
  if ((team.kind === "personal") !== (team.id === user.personalTeam.id)) throw new ProtocolError("Team does not match the current user's Personal Team.");
  return team;
};

export const runTeamCommand = async (args: readonly string[], context: CliContext, dependencies: TeamCommandDependencies = defaults): Promise<void> => {
  const command = parseCommand(teamDefinition, args, ["daynight", "team"], "daynight team --help");
  if (command.kind !== "run") { context.stdout(renderCommandHelp(command.command, command.path)); return; }
  const explicit = command.options.get("--team") as string | undefined;
  const target = explicit === undefined || explicit === "personal" ? explicit : canonicalId(explicit);
  if (target === null) throw new UsageError("--team must be a hyphenated UUID or personal.", `daynight team ${command.command.name} --help`);
  await dependencies.runServerCommand(context, async ({ api, operation, serverUrl }) => {
    const user = await api.getTeamCurrentUser();
    const rendering = await import("./rendering.js");
    if (command.command.name === "list") {
      const teams = (await api.listTeams(user.id)).map((item) => verifyPersonal(item, user));
      operation.check();
      return command.options.has("--json") ? rendering.renderTeamJson(teams) : rendering.renderTeams(teams);
    }
    const { readTeamDefault, teamTarget } = await import("./context.js");
    const isDefault = command.path.includes("default");
    const configured = target === undefined ? await readTeamDefault(context.homeDirectory(), serverUrl, user, operation.signal) : undefined;
    const resolved = teamTarget(target ?? configured ?? "personal", user);
    if (command.command.name === "projects") {
      const projects = await api.listTeamProjects(user.id, resolved);
      operation.check();
      const projectRendering = await import("../project/rendering.js");
      return command.options.has("--json") ? projectRendering.renderProjectJson(projects) : projectRendering.renderProjectList(projects);
    }
    const result = verifyPersonal(await api.getTeam(user.id, resolved), user);
    operation.check();
    if (isDefault) {
      const value = { configured: configured ?? null, team: result };
      return command.options.has("--json") ? rendering.renderTeamJson(value) : `Configured: ${configured ?? "none"}\n${rendering.renderTeam(result)}`;
    }
    return command.options.has("--json") ? rendering.renderTeamJson(result) : rendering.renderTeam(result);
  });
};
