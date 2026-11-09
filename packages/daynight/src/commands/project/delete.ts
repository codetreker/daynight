import { randomUUID } from "node:crypto";
import { ApiError } from "../../api/client.js";
import { canonicalId } from "../../api/validation.js";
import { UsageError } from "../../cli/context.js";
import type { CliContext } from "../../cli/context.js";
import type { ParsedCommand } from "../../cli/schema.js";
import { PublicDiagnosticError } from "../../platform/diagnostics.js";
import { terminalText } from "../../platform/terminal.js";
import type { ServerSession } from "../server/runtime.js";
import { confirmTeamChange, requireTeamConfirmation } from "../team/confirmation.js";
import { resolveProject } from "./resolve.js";
import { renderProjectJsonValue } from "./rendering.js";

export const prepareDelete = (command: Extract<ParsedCommand, { kind: "run" }>, context: CliContext) => {
  const rawProject = command.options.get("--project") as string | undefined;
  const projectId = rawProject === undefined ? undefined : canonicalId(rawProject);
  if (projectId === null) throw new UsageError("project-id must be a hyphenated UUID.", "daynight project delete --help");
  const confirmed = command.options.has("--confirm");
  requireTeamConfirmation(context, confirmed, "Project deletion");
  return { projectId, confirmed };
};

export const runDelete = async (command: Extract<ParsedCommand, { kind: "run" }>, context: CliContext, session: ServerSession, prepared: ReturnType<typeof prepareDelete>) => {
  const user = await session.api.getTeamCurrentUser();
  const project = await resolveProject(session, context, user.id, prepared.projectId);
  const preview = await session.api.previewProjectDeletion(user.id, project.id);
  const team = preview.project.ownerTeam;
  const lines = [
    `Delete Project ${terminalText(JSON.stringify(preview.project.name))} (${preview.project.id})`,
    `Repository: ${terminalText(JSON.stringify(preview.project.repoUrl))}`,
    `Owner Team: ${terminalText(team.kind === "personal" ? "Personal" : JSON.stringify(team.name))} (${team.id})`,
    `Observed at ${preview.observedAt}: ${preview.summary.taskCount} Tasks, ${preview.summary.unfinishedTaskCount} unfinished, ${preview.summary.attachmentCount} attachments.`,
    "The Project will be unavailable with no in-product recovery. History and files remain on the server.",
    ...preview.activeClaims.map(({ taskId, title, worker }) => `Active claim: ${taskId} ${terminalText(JSON.stringify(title))} (${terminalText(JSON.stringify(worker.machineName))}, ${worker.platform}, ${worker.connectivity === "offline" ? "offline" : worker.paused || worker.phase === "paused" ? "paused" : worker.phase}, ${worker.connectivity})`),
  ];
  context.stderr(`${lines.join("\n")}\n`);
  if (preview.activeClaims.length !== 0) throw new Error("Project deletion is blocked by active Worker claims. Stop or release them before trying again.");
  await confirmTeamChange(context, context.prompt?.isInteractive === true ? false : prepared.confirmed, "Confirm Project deletion.", session.operation.signal, preview.project.name, "Project deletion");
  const requestId = randomUUID();
  let receipt;
  try { receipt = await session.api.deleteProject(user.id, project.id, requestId); }
  catch (cause) {
    if (cause instanceof ApiError && cause.confirmedMutationId !== undefined) throw new PublicDiagnosticError(`Project deletion was confirmed for Project ${cause.confirmedMutationId}, but local request cleanup failed.`, 1, { cause });
    if (cause instanceof ApiError && cause.outcomeUnconfirmed) throw new Error(`Project deletion outcome is unknown (requestId=${requestId}); a later 404 cannot establish success. Do not automatically retry.`, { cause });
    throw cause;
  }
  const message = (phase: string) => `Project deletion was confirmed for Project ${receipt.projectId}, but local ${phase} failed.`;
  let output: string;
  try { output = command.options.has("--json") ? renderProjectJsonValue(receipt) : `Project deleted.\nProject: ${receipt.projectId}\n`; }
  catch (cause) { throw new PublicDiagnosticError(message("rendering"), 1, { cause }); }
  return { kind: "confirmed-mutation" as const, output, failureText: message };
};
