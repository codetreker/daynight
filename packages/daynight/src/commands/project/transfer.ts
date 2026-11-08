import { randomUUID } from "node:crypto";
import { ApiError } from "../../api/client.js";
import { parseVersionArgument } from "../../api/json.js";
import { canonicalId } from "../../api/validation.js";
import type { ProjectTransferReceipt, TeamRef } from "../../api/types.js";
import { UsageError } from "../../cli/context.js";
import type { CliContext } from "../../cli/context.js";
import type { ParsedCommand } from "../../cli/schema.js";
import { PublicDiagnosticError } from "../../platform/diagnostics.js";
import { terminalText } from "../../platform/terminal.js";
import type { ServerSession } from "../server/runtime.js";
import { confirmTeamChange, requireTeamConfirmation } from "../team/confirmation.js";
import { parseTeamIdentifier } from "../team/identifier.js";

const help = "daynight project transfer --help";
const describeTeam = (team: TeamRef): string => `${terminalText(team.kind === "personal" ? "Personal" : JSON.stringify(team.name))} (${team.id})`;

export { resolveProject as resolveTransferProject } from "./resolve.js";
import { resolveProject } from "./resolve.js";

export const prepareTransfer = (command: Extract<ParsedCommand, { kind: "run" }>, context: CliContext) => {
  const rawTarget = command.options.get("--to-team") as string;
  parseTeamIdentifier(rawTarget);
  const rawProject = command.options.get("--project") as string | undefined;
  const projectId = rawProject === undefined ? undefined : canonicalId(rawProject);
  if (projectId === null) throw new UsageError("project-id must be a hyphenated UUID.", help);
  const rawVersion = command.options.get("--if-version");
  let version: bigint | undefined;
  if (typeof rawVersion === "string") {
    try { version = parseVersionArgument(rawVersion); }
    catch { throw new UsageError("--if-version must be a positive 64-bit integer.", help); }
  }
  const confirmed = command.options.has("--confirm");
  requireTeamConfirmation(context, confirmed, "Project transfer");
  return { rawTarget, projectId, version, confirmed };
};

export const runTransfer = async (command: Extract<ParsedCommand, { kind: "run" }>, context: CliContext, session: ServerSession, prepared: ReturnType<typeof prepareTransfer>, resolve = resolveProject) => {
  const { projectId, version, confirmed } = prepared;
  const target = parseTeamIdentifier(prepared.rawTarget, session.serverUrl);
  const user = await session.api.getTeamCurrentUser();
  const project = await resolve(session, context, user.id, projectId);
  const preview = await session.api.previewProjectTransfer(user.id, project.id, target);
  session.operation.check();
  if (version !== undefined && version !== preview.ownership.version) throw new Error(`Ownership version differs from --if-version; current version is ${preview.ownership.version}. Recheck the Project before confirming a new transfer.`);
  const description = `Transfer Project ${terminalText(JSON.stringify(project.name))} (${project.id})\nFrom: ${describeTeam(preview.sourceTeam)}\nTo: ${describeTeam(preview.targetTeam)}\nOwnership version: ${preview.ownership.version}; target version: ${preview.targetTeam.version}\nYour access after transfer: ${preview.actorRole ?? "none"}. Continue?`;
  await confirmTeamChange(context, confirmed, description, session.operation.signal, undefined, "Project transfer");
  const requestId = randomUUID();
  let receipt: ProjectTransferReceipt;
  try { receipt = await session.api.transferProject(user.id, project.id, preview, requestId); }
  catch (cause) {
    if (cause instanceof ApiError && cause.confirmedMutationId !== undefined) throw new PublicDiagnosticError(`Project transfer was confirmed for Project ${cause.confirmedMutationId}, but local request cleanup failed.`, 1, { cause });
    if (cause instanceof ApiError && cause.outcomeUnconfirmed) throw new Error(`Project transfer outcome is unknown (requestId=${requestId}); a later 404 cannot establish success. Do not automatically retry.`, { cause });
    throw cause;
  }
  const message = (phase: string) => `Project transfer was confirmed for Project ${receipt.projectId}, but local ${phase} failed.`;
  let output: string;
  try {
    const { renderTransferReceipt, renderProjectJsonValue } = await import("./rendering.js");
    output = command.options.has("--json") ? renderProjectJsonValue(receipt) : renderTransferReceipt(receipt);
  } catch (cause) { throw new PublicDiagnosticError(message("rendering"), 1, { cause }); }
  return { kind: "confirmed-mutation" as const, output, failureText: message };
};
