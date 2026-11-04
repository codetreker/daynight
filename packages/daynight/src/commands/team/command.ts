import { canonicalId, ProtocolError } from "../../api/parse.js";
import { parseVersionArgument } from "../../api/json.js";
import { ApiError } from "../../api/client.js";
import { randomUUID } from "node:crypto";
import type { Team, User } from "../../api/types.js";
import { UsageError } from "../../cli/context.js";
import type { CliContext } from "../../cli/context.js";
import { parseCommand, renderCommandHelp } from "../../cli/schema.js";
import type { runServerCommand } from "../server/runtime.js";
import { teamDefinition } from "./definition.js";
import { confirmTeamChange, requireTeamConfirmation } from "./confirmation.js";
import { isNonemptyText } from "../../platform/text.js";
import { terminalText } from "../../platform/terminal.js";
import { PublicDiagnosticError } from "../../platform/diagnostics.js";

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
  const action = command.command.name;
  const mutation = action === "create" || action === "rename" || action === "delete";
  const confirmed = command.options.has("--confirm");
  const name = command.values[0];
  if ((action === "create" || action === "rename") && !isNonemptyText(name)) throw new UsageError("Team name must be nonempty Unicode text without NUL.", `daynight team ${action} --help`);
  let expectedVersion: bigint | undefined;
  const rawVersion = command.options.get("--if-version");
  if (typeof rawVersion === "string") {
    try { expectedVersion = parseVersionArgument(rawVersion); }
    catch { throw new UsageError("--if-version must be a positive 64-bit integer.", `daynight team ${action} --help`); }
  }
  if (mutation) requireTeamConfirmation(context, confirmed);
  await dependencies.runServerCommand(context, async ({ api, operation, serverUrl }) => {
    const user = await api.getTeamCurrentUser();
    const rendering = await import("./rendering.js");
    if (action === "create") {
      await confirmTeamChange(context, confirmed, `Create Team ${terminalText(JSON.stringify(name))}?`, operation.signal);
      const requestId = randomUUID();
      const result = await api.createTeam(user.id, name!, requestId).catch((cause: unknown) => throwMutationFailure(cause, "creation", requestId));
      return confirmedOutput("Team creation", result.id, () => command.options.has("--json") ? rendering.renderTeamJson(result) : rendering.renderTeam(result));
    }
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
    if (action === "rename" || action === "delete") {
      if (expectedVersion !== undefined && expectedVersion !== result.version) throw new Error(`Team version differs from --if-version; current version is ${result.version}. Recheck the Team before confirming a new change.`);
      if (result.kind === "personal") throw new Error("Personal Team cannot be renamed or deleted.");
      const description = action === "rename"
        ? `Rename Team ${result.id} from ${terminalText(JSON.stringify(result.name))} to ${terminalText(JSON.stringify(name))}?`
        : `Delete Team ${result.id} (version ${result.version})?`;
      await confirmTeamChange(context, confirmed, description, operation.signal, action === "delete" ? result.name! : undefined);
      const requestId = randomUUID();
      try {
        if (action === "rename") {
          const updated = await api.renameTeam(user.id, result, name!, requestId);
          return confirmedOutput("Team rename", result.id, () => command.options.has("--json") ? rendering.renderTeamJson(updated) : rendering.renderTeam(updated));
        }
        const receipt = await api.deleteTeam(user.id, result, requestId);
        return confirmedOutput("Team deletion", result.id, () => command.options.has("--json") ? rendering.renderTeamJson(receipt) : `Deleted Team ${receipt.teamId}.\n`);
      } catch (cause) { throwMutationFailure(cause, action, requestId); }
    }
    if (isDefault) {
      const value = { configured: configured ?? null, team: result };
      return command.options.has("--json") ? rendering.renderTeamJson(value) : `Configured: ${configured ?? "none"}\n${rendering.renderTeam(result)}`;
    }
    return command.options.has("--json") ? rendering.renderTeamJson(result) : rendering.renderTeam(result);
  });
};

const throwMutationFailure = (cause: unknown, action: string, requestId: string): never => {
  if (cause instanceof ApiError && cause.confirmedMutationId !== undefined) throw new PublicDiagnosticError(`Team ${action} was confirmed for Team ${cause.confirmedMutationId}, but local request cleanup failed.`, 1, { cause });
  if (cause instanceof ApiError && cause.outcomeUnconfirmed) throw new PublicDiagnosticError(`Team ${action} outcome is unknown (requestId=${requestId}); read current state before deciding on a new operation.`, 1, { cause });
  throw cause;
};

const confirmedOutput = (action: string, id: string, render: () => string) => {
  const message = (phase: string): string => `${action} was confirmed for Team ${id}, but local ${phase} failed.`;
  let output: string;
  try { output = render(); } catch (cause) { throw new PublicDiagnosticError(message("rendering"), 1, { cause }); }
  return { kind: "confirmed-mutation" as const, output, failureText: message };
};
