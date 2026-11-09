import type { TaskSessionOperationTarget } from "../../../api/task-session.js";
import type { SessionOperation } from "../../../session/protocol.js";
import { terminalText } from "../../../platform/terminal.js";
import type { KnownSessionOperationOutput } from "../../server/runtime.js";

export type SessionOperationResult = TaskSessionOperationTarget & {
  readonly schemaVersion: 1;
  readonly origin: string;
  readonly actorId: string;
  readonly state: SessionOperation["state"] | "not_found";
  readonly operation: SessionOperation | null;
  readonly currentBinding: boolean | null;
  readonly waitExpired: boolean;
  readonly sendMode?: "start" | "steer";
  readonly expectedTurnId?: string | null;
  readonly problem: string | null;
};
export const operationQuery = (target: TaskSessionOperationTarget): string => `daynight task session operation ${target.taskId} ${target.sessionId} ${target.operationId} --project ${target.projectId}`;
export const operationExit = (state: SessionOperationResult["state"]): 0 | 1 | 3 => ["provider_accepted", "confirmed"].includes(state) ? 0 : ["rejected", "failed", "expired"].includes(state) ? 1 : 3;
export const renderSessionOperation = (result: SessionOperationResult, json: boolean, override?: 1 | 3 | 130): KnownSessionOperationOutput => {
  const query = operationQuery(result);
  const identity = `Operation: ${result.operationId}\nProject: ${result.projectId}\nTask: ${result.taskId}\nSession: ${result.sessionId}\nState: ${result.state}\nQuery: ${query}`;
  const lines = [identity, `Server: ${terminalText(result.origin)}`, `Actor: ${result.actorId}`];
  if (result.operation?.providerResult !== null && result.operation?.providerResult !== undefined) lines.push(`Provider result: ${result.operation.providerResult}`);
  if (result.operation?.error !== null && result.operation?.error !== undefined) lines.push(`Error: ${terminalText(result.operation.error.code)}: ${terminalText(result.operation.error.message)}`);
  if (result.sendMode !== undefined) lines.push(`Send mode: ${result.sendMode}`, `Expected turn: ${result.expectedTurnId === null ? "none (idle)" : terminalText(result.expectedTurnId ?? "unknown")}`);
  if (result.waitExpired) lines.push("Receipt wait expired; the original operation remains queryable.");
  if (result.problem !== null) lines.push(terminalText(result.problem));
  const exitCode = override ?? operationExit(result.state);
  return { kind: "known-session-operation", output: json ? `${JSON.stringify({ ...result, queryCommand: query })}\n` : `${lines.join("\n")}\n`, exitCode,
    ...(exitCode === 0 ? {} : { diagnostic: `${result.problem ?? (exitCode === 130 ? "Session operation wait interrupted." : "Session operation is pending, unknown or unsuccessful.")}\n${identity}` }),
    failureText: phase => `${identity}\nLocal ${phase} failed. Query the original operation; do not resend.`,
  };
};
