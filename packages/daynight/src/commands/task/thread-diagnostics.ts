import { ApiError } from "../../api/client.js";
import { UsageError } from "../../cli/context.js";
import { PublicDiagnosticError } from "../../platform/diagnostics.js";
import { terminalText } from "../../platform/terminal.js";

const codes = new Set(["invalid_input", "payload_too_large", "unauthenticated", "forbidden", "not_found", "message_not_found", "task_deleted", "claim_conflict", "clock_not_advanced", "message_outcome_unknown", "internal_error"]);
const safeText = (value: string): string => terminalText(value).replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`);

const apiFailures = (cause: unknown, seen = new Set<unknown>()): ApiError[] => {
  if (!(cause instanceof Error) || seen.has(cause)) return [];
  seen.add(cause);
  return [...(cause instanceof ApiError ? [cause] : []), ...(cause instanceof AggregateError ? cause.errors.flatMap((error: unknown) => apiFailures(error, seen)) : []), ...apiFailures(cause.cause, seen)];
};
export const classifyThreadPostFailure = (cause: unknown): "confirmed" | "unknown" | "failed" => {
  const failures = apiFailures(cause);
  return failures.some((error) => error.confirmedMessageId !== undefined) ? "confirmed" : failures.some((error) => error.outcomeUnconfirmed) ? "unknown" : "failed";
};

export class ThreadCommandError extends PublicDiagnosticError {
  constructor(cause: unknown, operation: "read" | "post", phase: "prepare" | "request" | "render" | "output", projectId?: string, taskId?: string) {
    const outcome = operation === "post" ? classifyThreadPostFailure(cause) : "failed";
    const failures = apiFailures(cause);
    const api = failures.find((error) => error.confirmedMessageId !== undefined) ?? failures.find((error) => error.outcomeUnconfirmed) ?? failures[0];
    const message = cause instanceof UsageError ? `${cause.message} Run ${cause.helpCommand} for usage.`
      : outcome === "confirmed" ? `Message posted. Id: ${api!.confirmedMessageId!}\nThe message is confirmed, but local response cleanup failed.`
      : outcome === "unknown" ? "The posting outcome is unknown.\nRead the thread before sending the message again."
      : phase === "prepare" ? "Could not prepare the Thread request. Check configuration and authentication; run daynight login if needed."
      : `Thread ${operation} failed.`;
    const context = [`source=cli`, `operation=task.thread.${operation}`, `phase=${api?.phase ?? phase}`, ...(projectId === undefined ? [] : [`projectId=${projectId}`]), ...(taskId === undefined ? [] : [`taskId=${taskId}`]), ...(api?.status === undefined ? [] : [`status=${api.status}`]), ...(api?.code === undefined ? [] : [`code=${codes.has(api.code) ? api.code : "server_error"}`]), ...(api?.requestId === undefined ? [] : [`requestId=${safeText(api.requestId)}`])];
    super(`${message}${api?.status === 401 ? " Run daynight login to authenticate." : api?.code === "claim_conflict" ? " Verify the current claim before posting again." : ""}\n${context.join(" ")}`, cause instanceof UsageError ? 2 : 1, { cause });
    this.name = "ThreadCommandError";
  }
}
