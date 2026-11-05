import { ApiError } from "../../api/client.js";
import { PublicDiagnosticError } from "../../platform/diagnostics.js";
import { terminalText } from "../../platform/terminal.js";
import type { ApiClient } from "../../api/client.js";
import type { Operation } from "../../api/operation.js";
import type { CliContext } from "../../cli/context.js";
import { renderWorkerDetail, renderWorkerList } from "./query-rendering.js";

export type WorkerQuery = { readonly kind: "list"; readonly json: boolean } | { readonly kind: "show"; readonly workerId: string; readonly json: boolean };
export type WorkerQueryDependencies = {
  runServerCommand: (context: CliContext, command: (session: { api: Pick<ApiClient, "listWorkers" | "getWorker">; operation: Operation }) => Promise<string>) => Promise<void>;
};
const defaults: WorkerQueryDependencies = {
  runServerCommand: async (context, command) => (await import("../server/runtime.js")).runServerCommand(context, command),
};

export const runWorkerQuery = async (request: WorkerQuery, context: CliContext, dependencies: WorkerQueryDependencies = defaults): Promise<void> => {
  try {
    await dependencies.runServerCommand(context, async ({ api, operation }) => {
      if (request.kind === "list") {
        const result = await api.listWorkers();
        operation.check();
        return request.json ? `${JSON.stringify(result)}\n` : renderWorkerList(result);
      }
      const result = await api.getWorker(request.workerId);
      operation.check();
      return request.json ? `${JSON.stringify(result)}\n` : renderWorkerDetail(result);
    });
  } catch (cause) {
    const loginRequired = cause instanceof Error && cause.message === "You are not logged in. Run daynight login to authenticate.";
    const error = {
      operation: `worker.${request.kind}`,
      ...(request.kind === "show" ? { workerId: request.workerId } : {}),
      ...(cause instanceof ApiError ? {
        phase: cause.phase,
        ...(cause.status === undefined ? {} : { status: cause.status }),
        ...(cause.code === undefined ? {} : { code: cause.code }),
        ...(cause.requestId === undefined ? {} : { serverRequestId: cause.requestId }),
      } : {}),
      ...(loginRequired ? { reason: "login_required" } : {}),
      outcomeUnconfirmed: false,
    };
    const message = request.json ? JSON.stringify({ error })
      : `${error.operation} failed${"status" in error ? ` (HTTP ${error.status})` : ""}${"code" in error ? `: ${terminalText(error.code!)}` : "."}${request.kind === "show" ? ` Worker ID: ${terminalText(request.workerId)}.` : ""}${loginRequired || cause instanceof ApiError && cause.status === 401 ? " Run daynight login to authenticate." : ""}`;
    throw new PublicDiagnosticError(message, 1, { cause });
  }
};
