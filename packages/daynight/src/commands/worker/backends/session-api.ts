import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SESSION_PROTOCOL } from "../../../session/protocol.js";
import { parseRegistrationResponse, parseControllerGrantResponse, type RegistrationRequest, type ControllerGrantRequest, type ControllerGrantResponse } from "../../../session/controller-protocol.js";
import type { LocalTask, WebExecutionState } from "../types.js";
export const createWorkerSessionApi = (serverOrigin: string, serverToken: string) => {
  const request = async (target: string, body: unknown, signal: AbortSignal): Promise<unknown> => {
    const response = await fetch(`${serverOrigin}${target}`, { method: "POST", headers: { authorization: `Bearer ${serverToken}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
    const chunks: Uint8Array[] = []; let size = 0;
    if (response.body !== null) { const reader = response.body.getReader(); try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error("Session registration response exceeds its limit."); } chunks.push(value); } } finally { reader.releaseLock(); } }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!response.ok) throw new Error(`Session registration failed with HTTP ${response.status}; read back the original registration before replacing its identity.`);
    try { return JSON.parse(raw) as unknown; } catch { throw new Error("Session registration returned invalid JSON; the result is unconfirmed."); }
  };
  const prefix = (task: LocalTask): string => `/api/v1/projects/${task.projectId}/tasks/${task.taskId}/sessions`;
  return {
    verifySupport: async (provider: string, signal: AbortSignal): Promise<void> => {
      const response = await fetch(`${serverOrigin}/api/v1/session-capabilities`, { headers: { authorization: `Bearer ${serverToken}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
      if (!response.ok) throw new Error("This service has not confirmed Web session protocol support; no claim was submitted.");
      const value = await response.json() as { protocol?: unknown; schemaVersion?: unknown; projectionVersion?: unknown; providers?: unknown };
      if (value.protocol !== SESSION_PROTOCOL || value.schemaVersion !== 1 || value.projectionVersion !== 1 || !Array.isArray(value.providers) || !value.providers.includes(provider)) throw new Error("The service Web session protocol or provider is incompatible; no claim was submitted.");
    },
    register: async (task: LocalTask, execution: WebExecutionState, signal: AbortSignal) => {
      if (task.configuration?.agentControlMode !== "web") throw new Error("Session registration requires a supported web execution.");
      const input: RegistrationRequest = { protocol: SESSION_PROTOCOL, registrationId: execution.registrationId, claimId: task.claimId, workerId: task.workerId, worktreeId: task.worktreeId, provider: task.configuration.agent, controllerId: execution.controllerId, controllerInstanceId: execution.controllerInstanceId };
      const result = parseRegistrationResponse(await request(prefix(task), input, signal));
      const session = result.session;
      if (session.claimId !== task.claimId || session.identity.taskId !== task.taskId || session.identity.projectId !== task.projectId || session.identity.workerId !== task.workerId || session.identity.worktreeId !== task.worktreeId || session.identity.provider !== task.configuration.agent || session.identity.controllerId !== execution.controllerId || session.identity.controllerInstanceId !== execution.controllerInstanceId) throw new Error("Registered session does not match the frozen execution.");
      return session;
    },
    grant: async (task: LocalTask, execution: WebExecutionState, signal: AbortSignal, previous?: { generation: string; instanceId: string; recordId: string; stoppedAt: string }): Promise<ControllerGrantResponse> => {
      if (execution.sessionId === null) throw new Error("Controller authorization requires its registered session.");
      const input: ControllerGrantRequest = { protocol: SESSION_PROTOCOL, claimId: task.claimId, controllerId: execution.controllerId, controllerInstanceId: execution.controllerInstanceId, executionGeneration: execution.executionGeneration, kind: execution.launchSubmission === "not-submitted" ? "bootstrap" : "reconnect", previousGeneration: previous?.generation ?? null, stopProof: previous === undefined ? null : { recordId: previous.recordId, previousControllerInstanceId: previous.instanceId, stoppedAt: previous.stoppedAt } };
      const grant = parseControllerGrantResponse(await request(`${prefix(task)}/${execution.sessionId}/controller-grant`, input, signal));
      if (grant.sessionId !== execution.sessionId || grant.claimId !== task.claimId || grant.executionGeneration !== execution.executionGeneration || grant.controllerId !== execution.controllerId || grant.controllerInstanceId !== execution.controllerInstanceId) throw new Error("Controller grant does not match the frozen execution.");
      return grant;
    },
  };
};
export const writeControllerCredential = async (filename: string, grant: ControllerGrantResponse): Promise<void> => {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await chmod(path.dirname(filename), 0o700);
  const temporary = `${filename}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(grant)}\n`, { flag: "wx", mode: 0o600 }); await rename(temporary, filename); await chmod(filename, 0o600);
};
export type WorkerSessionApi = ReturnType<typeof createWorkerSessionApi>;
