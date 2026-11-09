import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { ApiError } from "../../../api/client.js";
import { OperationError } from "../../../api/operation.js";
import type { Operation } from "../../../api/operation.js";
import { canonicalId } from "../../../api/parse.js";
import { SESSION_COMMAND_BYTES } from "../../../api/task-session.js";
import type { TaskSessionInspection, TaskSessionOperationExpectation, TaskSessionOperationTarget } from "../../../api/task-session.js";
import { UsageError } from "../../../cli/context.js";
import type { CliContext } from "../../../cli/context.js";
import { resolveConfigurationPaths } from "../../../config/paths.js";
import { PublicDiagnosticError } from "../../../platform/diagnostics.js";
import { parseSessionCommand, SESSION_PROTOCOL } from "../../../session/protocol.js";
import type { SessionCommand, SessionOperation } from "../../../session/protocol.js";
import type { TaskCommandDependencies } from "../command.js";
import type { TaskSessionCommand } from "./registry.js";
import { readSessionText, validateSessionText } from "./input.js";
import { createOperationStore, operationRecordReceipt, sessionBodyHash } from "./operation-store.js";
import type { OperationStore, SessionOperationRecord } from "./operation-store.js";
import { renderSessionOperation } from "./output.js";
import type { SessionOperationResult } from "./output.js";

const parseId = (value: string, label: string, help: string): string => { const id = canonicalId(value); if (id === null) throw new UsageError(`${label} must be a hyphenated UUID.`, help); return id; };
const notFound = (error: unknown): boolean => error instanceof ApiError && error.status === 404 && error.code === "not_found" && error.phase === "response";
const pending = (state: string): boolean => ["accepted", "offered", "dispatching"].includes(state);
const expectation = (record: SessionOperationRecord): TaskSessionOperationExpectation => ({ claimId: record.fence.claimId, executionGeneration: record.fence.executionGeneration, kind: "send_message" });
const cancelled = (operation: Operation): boolean => operation.signal.aborted && operation.signal.reason instanceof OperationError && operation.signal.reason.kind === "cancelled";
const receiptWaitExpired = (error: unknown, deadline: number, operation: Operation): boolean =>
  !cancelled(operation) && performance.now() >= deadline && error instanceof ApiError && error.status !== 401 && error.status !== 403 &&
  error.cause instanceof OperationError && (error.cause.kind === "request_timeout" || error.cause.kind === "deadline");
const commandBody = (target: TaskSessionOperationTarget, fence: TaskSessionInspection["fence"], expectedTurnId: string | null, text: string): SessionCommand => {
  const command = parseSessionCommand({ protocol: SESSION_PROTOCOL, operationId: target.operationId, requestId: target.operationId, sessionId: target.sessionId, claimId: fence.claimId, executionGeneration: fence.executionGeneration, kind: "send_message", payload: { content: [{ type: "text", text }], expectedTurnId } });
  if (Buffer.byteLength(JSON.stringify(command), "utf8") > SESSION_COMMAND_BYTES) throw new UsageError("Complete Session command JSON exceeds 2 MiB.", "daynight task session send --help");
  return command;
};
const inspectTurn = (inspection: TaskSessionInspection): string | null => {
  const session = inspection.session;
  if (!inspection.currentBinding || inspection.source !== "live" || session.observation !== "observed" || session.registration !== "registered" || session.agentControlMode !== "web" || session.send.allowed !== true || session.error !== null) throw new Error("This Session does not allow sending.");
  if (session.activity === "idle" && session.send.mode === "start" && session.currentTurnId === null) return null;
  if (session.activity === "working" && session.send.mode === "steer" && session.currentTurnId !== null && session.currentTurnId.length > 0) return session.currentTurnId;
  throw new Error("This Session has no eligible original turn.");
};

export const run = async (command: TaskSessionCommand, context: CliContext, dependencies: TaskCommandDependencies): Promise<void> => {
  const help = `${command.path.join(" ")} --help`, send = command.command.name === "send", json = command.options.has("--json");
  const option = (name: string): string | undefined => command.options.get(name) as string | undefined;
  const rawOperation = option("--operation-id"), rawProject = option("--project");
  let projectId = rawProject === undefined ? undefined : parseId(rawProject, "project-id", help);
  const localRecovery = !send && command.values.length === 0 && rawOperation !== undefined && rawProject === undefined;
  if (!send && !localRecovery && (command.values.length !== 3 || rawOperation !== undefined)) throw new UsageError("Provide all three original IDs, or only --operation-id for local recovery.", help);
  const taskId = localRecovery ? undefined : parseId(command.values[0]!, "task-id", help);
  const sessionId = localRecovery ? undefined : parseId(command.values[1]!, "session-id", help);
  const operationId = parseId(send ? rawOperation ?? randomUUID() : localRecovery ? rawOperation! : command.values[2]!, "operation-id", help);
  const rawWait = option("--wait-seconds"), waitSeconds = rawWait === undefined ? 30 : Number(rawWait);
  if (rawWait !== undefined && (!/^[0-9]+$/.test(rawWait) || !Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 60)) throw new UsageError("--wait-seconds must be a decimal integer from 0 to 60.", help);
  const text = option("--text"), file = option("--file"), stdin = command.options.has("--stdin");
  if (send && [text !== undefined, file !== undefined, stdin].filter(Boolean).length !== 1) throw new UsageError("Select exactly one of --text, --file or --stdin.", help);
  if (text !== undefined) validateSessionText(text);
  try {
    await dependencies.runServerCommand(context, async session => {
      const { operation, serverUrl } = session;
      let result: SessionOperationResult | undefined, store: OperationStore | undefined, record: SessionOperationRecord | undefined;
      let exitOverride: 1 | 3 | 130 | undefined;
      let maySubmit = true;
      let pollDeadline: number | undefined;
      try {
        const body = send ? await readSessionText({ ...(text === undefined ? {} : { text }), ...(file === undefined ? {} : { file }), ...(stdin ? { stdin } : {}) }, operation.signal) : undefined;
        const actorId = (await session.api.getCurrentUser(true)).id;
        const api = session.api.withExpectedUserId(actorId), origin = new URL(serverUrl).origin;
        if (send || localRecovery) {
          store = await createOperationStore(resolveConfigurationPaths(context.homeDirectory()).stateDirectory, origin, actorId, operationId);
          record = await store.read();
        }
        if (localRecovery && record === undefined) throw new PublicDiagnosticError("No local operation record exists for this actor and server. Query with all three original IDs and --project.", 1, {});
        if (record !== undefined) {
          if (projectId !== undefined && projectId !== record.projectId || taskId !== undefined && taskId !== record.taskId || sessionId !== undefined && sessionId !== record.sessionId || body !== undefined && sessionBodyHash(body) !== record.bodySha256) throw new PublicDiagnosticError("Operation ID conflicts with the original local target or message hash. Query the original operation without resending.", 1, {});
          projectId = record.projectId;
        }
        if (projectId === undefined) projectId = (await dependencies.resolveProject({ serverUrl, api, operation, workingDirectory: context.workingDirectory() })).id;
        const target = record ?? { projectId, taskId: taskId!, sessionId: sessionId!, operationId };
        result = { schemaVersion: 1, origin, actorId, projectId: target.projectId, taskId: target.taskId, sessionId: target.sessionId, operationId, state: "unknown", operation: null, currentBinding: null, waitExpired: false, problem: null, ...(record === undefined ? {} : { sendMode: record.expectedTurnId === null ? "start" : "steer", expectedTurnId: record.expectedTurnId }) };
        const receive = (receipt: SessionOperation, currentBinding: boolean | null): void => { result = { ...result!, operation: receipt, state: receipt.state, currentBinding }; };
        const query = async (timeoutMs?: number): Promise<void> => {
          try { const read = await api.readTaskSessionOperation(result!, record === undefined ? send ? { kind: "send_message" } : undefined : expectation(record), timeoutMs); receive(read.operation, read.currentBinding); }
          catch (error) { if (!notFound(error)) throw error; result = { ...result!, state: "not_found", operation: null, currentBinding: null }; }
        };
        if (!send || record !== undefined) {
          if (record !== undefined && body !== undefined) commandBody(result, record.fence, record.expectedTurnId, body);
          if (send && waitSeconds > 0) pollDeadline = performance.now() + waitSeconds * 1_000;
          try { await query(pollDeadline === undefined ? undefined : pollDeadline - performance.now()); }
          catch (error) {
            if (pollDeadline !== undefined && receiptWaitExpired(error, pollDeadline, operation)) result = { ...result, waitExpired: true };
            else throw error;
          }
        } else {
          if (rawOperation !== undefined) {
            await query();
            if (result.state !== "not_found") {
              result = { ...result, problem: "This operation already exists. Its receipt does not prove acceptance of the supplied text. Use the original operation query." };
              maySubmit = false;
            }
          }
          if (maySubmit) {
            const inspection = await api.inspectTaskSession(projectId, taskId!, sessionId!);
            const expectedTurnId = inspectTurn(inspection), payload = commandBody(result, inspection.fence, expectedTurnId, body!);
            result = { ...result, sendMode: expectedTurnId === null ? "start" : "steer", expectedTurnId };
            operation.check();
            await store!.acquire();
            const concurrent = await store!.read();
            if (concurrent !== undefined) {
              if (concurrent.projectId !== projectId || concurrent.taskId !== taskId || concurrent.sessionId !== sessionId || concurrent.bodySha256 !== sessionBodyHash(body!)) throw new Error("Operation ID conflicts with the original record.");
              record = concurrent;
              result = { ...result, sendMode: concurrent.expectedTurnId === null ? "start" : "steer", expectedTurnId: concurrent.expectedTurnId };
              await query();
            } else {
              const now = new Date().toISOString();
              record = { schemaVersion: 1, origin, actorId, projectId, taskId: taskId!, sessionId: sessionId!, operationId, fence: inspection.fence, expectedTurnId, bodySha256: sessionBodyHash(body!), createdAt: now, updatedAt: now, phase: "prepared", receipt: null };
              await store!.write(record);
              operation.check();
              record = { ...record, phase: "dispatch_unknown", updatedAt: new Date().toISOString() };
              await store!.write(record);
              operation.check();
              result = { ...result, state: "unknown" };
              const submitted = await api.sendTaskSessionCommand(result, payload);
              receive(submitted.operation, null);
              try { await store!.write(operationRecordReceipt(record, submitted.operation)); }
              catch { result = { ...result, problem: "Server receipt received, but local receipt saving failed. Query the original operation; do not resend." }; exitOverride = 1; }
            }
          }
        }
        if (send && maySubmit && exitOverride === undefined && waitSeconds > 0 && pending(result.state)) {
          const deadline = pollDeadline ?? performance.now() + waitSeconds * 1_000;
          while (pending(result.state)) {
            const remaining = deadline - performance.now();
            if (remaining <= 0) { result = { ...result, waitExpired: true }; break; }
            await delay(Math.min(250, remaining), undefined, { signal: operation.signal });
            const requestBudget = deadline - performance.now();
            if (requestBudget <= 0) { result = { ...result, waitExpired: true }; break; }
            try { await query(requestBudget); }
            catch (error) {
              if (receiptWaitExpired(error, deadline, operation)) { result = { ...result, waitExpired: true }; break; }
              throw error;
            }
          }
        }
        if (cancelled(operation)) exitOverride = 130;
      } catch (error) {
        if (result === undefined) {
          if (cancelled(operation)) throw new PublicDiagnosticError("Session command interrupted before its original target was established.", 130, {});
          if (error instanceof UsageError || error instanceof PublicDiagnosticError) throw error;
          throw new PublicDiagnosticError("Session command preparation failed. Check authentication, input and private recovery storage.", 1, {});
        }
        exitOverride = cancelled(operation) ? 130 : error instanceof UsageError ? undefined : error instanceof ApiError && error.outcomeUnconfirmed && error.phase !== "protocol" ? 3 : 1;
        if (error instanceof UsageError) throw error;
        result = { ...result, problem: exitOverride === 130 ? "Session command interrupted. Query the original operation; do not resend." : error instanceof ApiError ? "Session request failed. The original operation remains query-only." : "Local Session operation preparation or persistence failed. Query the original operation; do not resend." };
      } finally {
        try { await store?.close(); }
        catch { if (result === undefined) throw new PublicDiagnosticError("Session recovery storage cleanup failed.", 1, {}); result = { ...result, problem: "Local recovery storage cleanup failed. Query the original operation." }; exitOverride = 1; }
      }
      return renderSessionOperation(result!, json, exitOverride);
    });
  } catch (error) {
    if (error instanceof PublicDiagnosticError || error instanceof UsageError) throw error;
    throw new PublicDiagnosticError("Session command failed. No automatic retry was made.", 1, {});
  }
};
