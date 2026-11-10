import { ApiError } from "../../../api/client.js";
import { UsageError } from "../../../cli/context.js";
import { CliCancelledError } from "../../../cli/cancellation.js";
import { PublicDiagnosticError } from "../../../platform/diagnostics.js";
import { terminalText } from "../../../platform/terminal.js";
import { ProjectDiscoveryError } from "../../../repository/discovery-error.js";

const find = <T extends Error>(value: unknown, match: (value: Error) => value is T, seen = new Set<unknown>()): T | undefined => {
  if (!(value instanceof Error) || seen.has(value)) return undefined;
  seen.add(value);
  if (match(value)) return value;
  if (value instanceof AggregateError) for (const child of value.errors as readonly unknown[]) {
    const result = find(child, match, seen); if (result !== undefined) return result;
  }
  return find(value.cause, match, seen);
};

export class SessionReadCommandError extends PublicDiagnosticError {
  constructor(cause: unknown, command: string, phase: "prepare" | "request" | "render" | "output", projectId?: string, taskId?: string, sessionId?: string) {
    const api = find(cause, (value): value is ApiError => value instanceof ApiError);
    const cancellation = find(cause, (value): value is CliCancelledError => value instanceof CliCancelledError);
    const discovery = find(cause, (value): value is ProjectDiscoveryError => value instanceof ProjectDiscoveryError);
    const code = api?.code;
    const retryRead = projectId === undefined || taskId === undefined || sessionId === undefined ? "" : `\nStart a new history read: daynight task session read ${taskId} ${sessionId} --project ${projectId}`;
    const guidance = code === "reset_required" ? `The history epoch or source changed; discard the old pagination cursor.${retryRead}`
      : code === "content_changed" ? `The entry changed; do not combine fragments from different versions.${retryRead}`
      : code === "upgrade_required" || code === "unsupported" || code === "unsupported_protocol" ? "Upgrade the Daynight service or Controller to use this read capability."
      : code === "unsupported_mode" ? "Herdr contains terminal_recording, not chat messages. Use session show for its state."
      : code === "history_pending" ? "History is not ready. Inspect the same Session before reading again."
      : code === "history_unavailable" ? "History is unavailable; this is not an empty conversation."
      : code === "source_corrupt" ? "The history source failed integrity validation."
      : api?.status === 401 ? "Run daynight login to authenticate." : "";
    const message = cancellation !== undefined ? `Session read cancelled. ${terminalText(cancellation.message)}`
      : cause instanceof UsageError ? `${cause.message} Run ${cause.helpCommand} for usage.`
      : discovery !== undefined ? discovery.kind === "missing" ? "Project does not exist." : `Multiple projects match this repository (${discovery.projectIds.join(", ")}); specify --project <id>.`
      : api?.phase === "protocol" ? "The service returned an invalid or unsupported Session response. Verify that the service supports this command."
      : phase === "prepare" ? "Could not prepare the Session read. Check configuration and authentication." : `Session ${command} failed.`;
    const context = [`source=cli`, `operation=task.session.${command}`, `phase=${api?.phase ?? phase}`,
      ...(projectId === undefined ? [] : [`projectId=${projectId}`]), ...(taskId === undefined ? [] : [`taskId=${taskId}`]), ...(sessionId === undefined ? [] : [`sessionId=${sessionId}`]),
      ...(code === undefined ? [] : [`code=${terminalText(code)}`]), ...(api?.status === undefined ? [] : [`status=${api.status}`]), ...(api?.requestId === undefined ? [] : [`requestId=${terminalText(api.requestId)}`])];
    super([message, ...guidance === "" ? [] : [guidance], context.join(" ")].join("\n"), cancellation !== undefined ? 130 : cause instanceof UsageError ? 2 : 1, { cause });
    this.name = "SessionReadCommandError";
  }
}
