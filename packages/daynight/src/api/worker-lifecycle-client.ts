import { randomUUID } from "node:crypto";
import { normalizeServerUrl } from "../config/server.js";
import { validateServerToken, validateTokenTransport } from "../config/server-token.js";
import { ApiError, type ApiPhase } from "./client.js";
import { createOperation, OperationError } from "./operation.js";
import { jsonObjectSources } from "./json-source.js";
import { parseServerError, ProtocolError } from "./parse.js";
import type { ServerError } from "./types.js";
import {
  WORKER_LIFECYCLE_HEADER, WORKER_LIFECYCLE_BYTES, lifecycleId, lifecycleRequestHash,
  parseLifecycleInstanceRequest, parseLifecycleIntentRequest, parseLifecycleActivationRequest, parseLifecycleObservationEnvelope, parseLifecycleResolveRequest,
  parseLifecycleResource, parseLifecycleInstanceReceipt, parseLifecycleIntentReceipt, parseLifecycleActivationReceipt, parseLifecycleObservationReceipt, parseLifecycleOperationResult,
  type LifecycleInstanceRequest, type LifecycleIntentRequest, type LifecycleActivationRequest, type LifecycleObservationEnvelope, type LifecycleResolveRequest,
  type LifecycleInstanceReceipt, type LifecycleIntentReceipt, type LifecycleActivationReceipt, type LifecycleOperationResult,
} from "./worker-lifecycle.js";

const confirm = (valid: boolean): void => { if (!valid) throw new ProtocolError("The Worker lifecycle receipt does not match the original request."); };
const sameInstance = (receipt: LifecycleInstanceReceipt, input: LifecycleInstanceRequest): void => {
  confirm(receipt.instanceId === input.instanceId);
};
const sameIntent = (receipt: LifecycleIntentReceipt, input: LifecycleIntentRequest): void => {
  confirm(receipt.action === input.action && receipt.desired === (input.action === "disable" ? "disabled" : "enabled") && BigInt(receipt.intentVersion) === BigInt(input.expectedVersion) + 1n);
};
const sameActivation = (receipt: LifecycleActivationReceipt, input: LifecycleActivationRequest): void => {
  confirm(receipt.action === ("action" in input ? input.action : "resume") && receipt.instanceId === input.instanceId && receipt.intentVersion === input.intentVersion && receipt.localEpoch === input.localEpoch && receipt.scopeGeneration === input.scopeGeneration);
};

export type WorkerLifecycleClientOptions = { serverUrl: string; serverToken?: string; userId: string; workerId: string; fetch?: typeof globalThis.fetch };
/** Each exchange sends once. Persist the original request before calling a mutation. */
export const createWorkerLifecycleClient = (options: WorkerLifecycleClientOptions) => {
  const origin = normalizeServerUrl(options.serverUrl), userId = lifecycleId(options.userId), workerId = lifecycleId(options.workerId);
  const token = options.serverToken === undefined ? undefined : validateServerToken(options.serverToken);
  if (token !== undefined) validateTokenTransport(origin);
  const fetch = options.fetch ?? globalThis.fetch;
  const exchange = async <T>(suffix: string, method: "GET" | "POST", parse: (value: unknown) => T, signal?: AbortSignal, body?: unknown, expectedStatus = 200): Promise<T> => {
    // A resource wraps the accepted 256 KiB observation with server timestamps and authority fields.
    const operation = createOperation({ ...(signal === undefined ? {} : { signal }), limits: { totalMs: 10_000, requestMs: 10_000, responseBytes: 2 * WORKER_LIFECYCLE_BYTES, totalBytes: 2 * WORKER_LIFECYCLE_BYTES } });
    const context = { operation: "worker.lifecycle", sentRequestId: randomUUID() };
    let phase: ApiPhase = "prepare", dispatched = false, status: number | undefined, serverError: ServerError | undefined, responseRequestId: string | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let responseBody: ReadableStream<Uint8Array> | null = null;
    let removeAbort = (): void => {};
    try {
      operation.check();
      const payload = body === undefined ? undefined : JSON.stringify(body);
      if (payload !== undefined && Buffer.byteLength(payload) > WORKER_LIFECYCLE_BYTES) throw new OperationError("request_limit");
      const aborted = new Promise<never>((_, reject) => {
        const onAbort = (): void => reject(operation.signal.reason);
        operation.signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => operation.signal.removeEventListener("abort", onAbort);
      });
      phase = "request";
      operation.check();
      dispatched = true;
      const response = await Promise.race([fetch(new URL(`/api/v1/me/workers/${workerId}/lifecycle${suffix}`, origin), {
        method, signal: operation.signal, redirect: "manual", cache: "no-store",
        headers: { Accept: "application/json", [WORKER_LIFECYCLE_HEADER]: "1", "X-Request-ID": context.sentRequestId, ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }), ...(payload === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(payload === undefined ? {} : { body: payload }),
      }).then(response => {
        if (operation.signal.aborted) { void response.body?.cancel().catch(() => {}); operation.check(); }
        return response;
      }), aborted]);
      responseBody = response.body;
      operation.check(); status = response.status;
      responseRequestId = response.headers.get("X-Request-ID") ?? undefined;
      phase = "protocol";
      if (status !== 401 && response.headers.get("Daynight-User-ID") !== userId) throw new ProtocolError("The authenticated Worker lifecycle principal changed or is missing.");
      if (status === expectedStatus && response.headers.get(WORKER_LIFECYCLE_HEADER) !== "1") throw new ProtocolError("The server did not confirm Worker lifecycle protocol version 1.");
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? "")) throw new ProtocolError();
      if (response.body === null) throw new ProtocolError();
      reader = response.body.getReader();
      phase = "response";
      const chunks: Uint8Array[] = [];
      for (;;) {
        const chunk = await Promise.race([reader.read(), aborted]);
        operation.check();
        if (chunk.done) break;
        operation.consume(chunk.value.byteLength); chunks.push(chunk.value);
      }
      phase = "protocol";
      const source = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      jsonObjectSources(source);
      const value: unknown = JSON.parse(source);
      if (status !== expectedStatus) {
        serverError = parseServerError(value);
        // Only an authenticated protocol refusal establishes non-submission.
        // Generic server failures, including lost database completion, remain unknown.
        const refused = status >= 400 && status < 500;
        throw new ApiError(context, "response", { cause: new Error("Worker lifecycle request failed."), status, serverError, outcomeUnconfirmed: method === "POST" && !refused, confirmedRefusal: refused, ...(responseRequestId === undefined ? {} : { responseRequestId }) });
      }
      return parse(value);
    } catch (cause) {
      if (cause instanceof ApiError) throw cause;
      throw new ApiError(context, phase, { cause, outcomeUnconfirmed: method === "POST" && dispatched, ...(status === undefined ? {} : { status }), ...(serverError === undefined ? {} : { serverError }), ...(responseRequestId === undefined ? {} : { responseRequestId }) });
    } finally {
      removeAbort();
      if (reader !== undefined) {
        const originalReader = reader;
        void originalReader.cancel().catch(() => {}).finally(() => { try { originalReader.releaseLock(); } catch { /* A timed-out read retains its cancellation responsibility. */ } });
      } else if (responseBody !== null) void responseBody.cancel().catch(() => {});
      operation.dispose();
    }
  };
  const target = <T extends { workerId: string; operationId?: string | null }>(receipt: T, operationId?: string): T => {
    confirm(receipt.workerId === workerId && (operationId === undefined || receipt.operationId === operationId)); return receipt;
  };
  const operationResult = (value: unknown, operationId: string): LifecycleOperationResult => {
    const result = parseLifecycleOperationResult(value); target(result.receipt, operationId); return result;
  };
  return {
    read: (signal?: AbortSignal) => exchange("", "GET", value => target(parseLifecycleResource(value)), signal),
    register: (request: LifecycleInstanceRequest, signal?: AbortSignal) => {
      const input = parseLifecycleInstanceRequest(request);
      return exchange("/instances", "POST", value => { const receipt = target(parseLifecycleInstanceReceipt(value), input.operationId); sameInstance(receipt, input); return receipt; }, signal, input);
    },
    intent: (request: LifecycleIntentRequest, signal?: AbortSignal) => {
      const input = parseLifecycleIntentRequest(request);
      return exchange("/operations", "POST", value => { const receipt = target(parseLifecycleIntentReceipt(value), input.operationId); sameIntent(receipt, input); return receipt; }, signal, input, 202);
    },
    operation: (operationId: string, signal?: AbortSignal) => exchange(`/operations/${lifecycleId(operationId)}`, "GET", value => operationResult(value, operationId), signal),
    resolve: (request: LifecycleResolveRequest, signal?: AbortSignal) => {
      const input = parseLifecycleResolveRequest(request), operationId = input.request.operationId;
      return exchange(`/operations/${operationId}/resolve`, "POST", value => {
        const result = operationResult(value, operationId);
        if (result.kind === "not_committed") confirm(result.receipt.requestKind === input.requestKind && result.receipt.requestHash === lifecycleRequestHash(input.requestKind, input.request));
        else if (input.requestKind === "instance") { confirm(result.kind === "instance"); if (result.kind === "instance") sameInstance(result.receipt, input.request); }
        else if (input.requestKind === "intent") { confirm(result.kind === "intent"); if (result.kind === "intent") sameIntent(result.receipt, input.request); }
        else if ("action" in input.request) { confirm(result.kind === "activation"); if (result.kind === "activation") sameActivation(result.receipt, input.request); }
        else { confirm(result.kind === "intent" && result.receipt.action === "resume" && result.receipt.intentVersion === input.request.intentVersion && result.activationOutcome !== "not_started"); if (result.kind === "intent" && result.activation !== null) sameActivation(result.activation, input.request); }
        return result;
      }, signal, input);
    },
    report: (request: LifecycleObservationEnvelope, signal?: AbortSignal) => {
      const input = parseLifecycleObservationEnvelope(request);
      return exchange("/observations", "POST", value => { const receipt = parseLifecycleObservationReceipt(value); confirm(receipt.instanceId === input.instanceId && receipt.intentVersion === input.intentVersion && receipt.reportSequence === input.reportSequence); return receipt; }, signal, input);
    },
    activate: (request: LifecycleActivationRequest, signal?: AbortSignal) => {
      const input = parseLifecycleActivationRequest(request);
      return exchange("/activations", "POST", value => { const receipt = target(parseLifecycleActivationReceipt(value), input.operationId); sameActivation(receipt, input); return receipt; }, signal, input);
    },
  };
};
export type WorkerLifecycleClient = ReturnType<typeof createWorkerLifecycleClient>;
