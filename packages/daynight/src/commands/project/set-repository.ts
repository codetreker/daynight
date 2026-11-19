import { randomUUID } from "node:crypto";
import { ApiError } from "../../api/client.js";
import { canonicalId } from "../../api/validation.js";
import { CliCancelledError } from "../../cli/cancellation.js";
import { UsageError } from "../../cli/context.js";
import type { CliContext } from "../../cli/context.js";
import type { ParsedCommand } from "../../cli/schema.js";
import { PublicDiagnosticError } from "../../platform/diagnostics.js";
import { terminalText } from "../../platform/terminal.js";
import { repositoryIdentity } from "../../repository/identity.js";
import type { ServerSession } from "../server/runtime.js";
import { resolveProject } from "./resolve.js";
import { renderProjectJsonValue } from "./rendering.js";

const help = "daynight project set-repository --help";

export const prepareSetRepository = (command: Extract<ParsedCommand, { kind: "run" }>, context: CliContext) => {
  const rawProject = command.options.get("--project") as string | undefined;
  const projectId = rawProject === undefined ? undefined : canonicalId(rawProject);
  if (projectId === null) throw new UsageError("project-id must be a hyphenated UUID.", help);
  const repoUrl = command.options.get("--repo") as string;
  repositoryIdentity(repoUrl);
  const confirmed = command.options.has("--confirm");
  if (!confirmed && context.prompt?.isInteractive !== true) throw new UsageError("Noninteractive repository changes require --confirm.", help);
  return { projectId, repoUrl, confirmed, allowUnverified: command.options.has("--allow-unverified-switch") };
};

export const runSetRepository = async (command: Extract<ParsedCommand, { kind: "run" }>, context: CliContext, session: ServerSession, prepared: ReturnType<typeof prepareSetRepository>) => {
  const user = await session.api.getTeamCurrentUser();
  const project = await resolveProject(session, context, user.id, prepared.projectId);
  let preview;
  try { preview = await session.api.previewProjectRepository(user.id, project.id, prepared.repoUrl); }
  catch (cause) {
    if (cause instanceof ApiError && [404, 405, 501].includes(cause.status ?? 0)) throw new Error("Repository change preview is unavailable; the server may not support this command or the Project may no longer be accessible.", { cause });
    throw cause;
  }
  session.operation.check();
  const lines = [
    `Change repository for Project ${terminalText(JSON.stringify(preview.projectName))} (${preview.projectId})`,
    `Current: ${terminalText(JSON.stringify(preview.currentRepoUrl))}`,
    `New: ${terminalText(JSON.stringify(preview.repoUrl))}`,
    `Classification: ${preview.classification}${preview.unverifiedReason === null ? "" : ` (${preview.unverifiedReason})`}`,
    preview.bindingsInvalidated
      ? "This will disconnect the Project's GitHub App repository connection and remove existing Worker cloud Project selections. Worker synchronization takes time and may stop existing executions. Reconnect GitHub and configure Workers manually as needed."
      : "GitHub App connection and Worker cloud Project selections will be retained.",
  ];
  context.stderr(`${lines.join("\n")}\n`);
  const interactive = context.prompt?.isInteractive === true;
  if (preview.classification === "unverified" && !prepared.allowUnverified && !interactive) throw new UsageError("An unverified repository requires --allow-unverified-switch in noninteractive use.", help);
  if ((!prepared.confirmed || (preview.classification === "unverified" && !prepared.allowUnverified)) && interactive) {
    try {
      const ask = async (question: string) => {
        const answer = await context.prompt!.ask(`${question} [y/N]: `, session.operation.signal);
        session.operation.signal.throwIfAborted();
        if (!/^(?:y|yes)$/i.test(answer)) throw new CliCancelledError("Project repository change cancelled.");
      };
      if (preview.classification === "unverified" && !prepared.allowUnverified) await ask("Treat this unverified identity as a repository switch?");
      if (!prepared.confirmed) await ask("Confirm this Project repository change?");
    } finally { context.prompt!.close(); }
  }
  const requestId = randomUUID();
  let receipt;
  try { receipt = await session.api.setProjectRepository(user.id, project.id, preview, preview.classification === "unverified", requestId); }
  catch (cause) {
    if (cause instanceof ApiError && cause.confirmedMutationId !== undefined) throw new PublicDiagnosticError(`Project repository change was confirmed for Project ${cause.confirmedMutationId}, but local request cleanup failed.`, 1, { cause });
    if (cause instanceof ApiError && cause.outcomeUnconfirmed) throw new Error(`Project repository change outcome is unknown (requestId=${requestId}); read the Project's current state before deciding on a new operation. Do not automatically retry.`, { cause });
    if (cause instanceof ApiError && cause.confirmedRefusal && cause.code === "version_conflict") throw new Error("Repository preview changed. Run the command again to preview and confirm the current facts.", { cause });
    throw cause;
  }
  const message = (phase: string) => `Project repository change was confirmed for Project ${receipt.projectId}, but local ${phase} failed.`;
  let output: string;
  try {
    output = command.options.has("--json") ? renderProjectJsonValue(receipt) : `${receipt.changed ? "Project repository updated." : "Project repository unchanged."}\nProject: ${receipt.projectId}\nRepository: ${terminalText(JSON.stringify(receipt.repoUrl))}\nRepository version: ${receipt.repositoryVersion}\nBindings invalidated: ${receipt.bindingsInvalidated}\n`;
  } catch (cause) { throw new PublicDiagnosticError(message("rendering"), 1, { cause }); }
  return { kind: "confirmed-mutation" as const, output, failureText: message };
};
