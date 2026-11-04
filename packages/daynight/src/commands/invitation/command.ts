import { randomUUID } from "node:crypto";
import { ApiError } from "../../api/client.js";
import { UsageError } from "../../cli/context.js";
import type { CliContext } from "../../cli/context.js";
import { parseCommand, renderCommandHelp } from "../../cli/schema.js";
import { PublicDiagnosticError } from "../../platform/diagnostics.js";
import type { runServerCommand } from "../server/runtime.js";
import { confirmTeamChange } from "../team/confirmation.js";
import { invitationDefinition } from "./definition.js";
import { parseInvitationLink, readInvitationLink } from "./input.js";
import { account, renderAcceptance, renderInspection, renderJson } from "./rendering.js";

type Dependencies = { runServerCommand: typeof runServerCommand; readLink: typeof readInvitationLink };
const defaults: Dependencies = { runServerCommand: async (...args) => (await import("../server/runtime.js")).runServerCommand(...args), readLink: readInvitationLink };

export const runInvitationCommand = async (args: readonly string[], context: CliContext, dependencies: Dependencies = defaults): Promise<void> => {
  let command;
  try { command = parseCommand(invitationDefinition, args, ["daynight", "invitation"], "daynight invitation --help"); }
  catch (error) {
    if (error instanceof UsageError) throw new UsageError("Invalid invitation command arguments.", "daynight invitation --help");
    throw error;
  }
  if (command.kind !== "run") { context.stdout(renderCommandHelp(command.command, command.path)); return; }
  const accepting = command.command.name === "accept";
  const confirmed = command.options.has("--confirm");
  if (accepting && !confirmed && context.prompt?.isInteractive !== true) throw new Error("Invitation acceptance requires interactive confirmation or --confirm.");
  await dependencies.runServerCommand(context, async ({ api, operation, serverUrl }) => {
    const link = await dependencies.readLink(command.options.has("--stdin"), operation.signal);
    const { scope, token } = parseInvitationLink(link, serverUrl);
    const user = await api.getTeamCurrentUser();
    const inspection = await api.inspectInvitation(scope, token, user.id);
    operation.check();
    if (!accepting) return command.options.has("--json") ? renderJson(inspection) : `${account(user)}\n${renderInspection(inspection)}`;
    const targetId = "team" in inspection ? inspection.team.id : inspection.projectId;
    context.stderr(`${account(user)}\n${renderInspection(inspection)}`);
    if (!confirmed) {
      await confirmTeamChange(context, false, "Accept this invitation as the account shown above?", operation.signal);
    }
    const requestId = randomUUID();
    let receipt;
    try { receipt = await api.acceptInvitation(scope, token, user.id, targetId, requestId); }
    catch (cause) {
      if (cause instanceof ApiError && cause.confirmedMutationId !== undefined) throw new PublicDiagnosticError(`Invitation acceptance was confirmed for ${scope} ${cause.confirmedMutationId}, but local request cleanup failed.`, 1, { cause });
      if (cause instanceof ApiError && cause.outcomeUnconfirmed) throw new Error(`Invitation acceptance outcome is unknown (requestId=${requestId}); read current state before deciding on a new operation.`, { cause });
      throw cause;
    }
    const failureText = (phase: string): string => `Invitation acceptance was confirmed for ${scope} ${targetId}, but local ${phase} failed.`;
    let output: string;
    try { output = command.options.has("--json") ? renderJson(receipt) : renderAcceptance(receipt); }
    catch (cause) { throw new PublicDiagnosticError(failureText("rendering"), 1, { cause }); }
    return { kind: "confirmed-mutation" as const, output, failureText };
  });
};
