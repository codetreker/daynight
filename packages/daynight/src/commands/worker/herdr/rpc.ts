import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import path from "node:path";
import type { Operation } from "../../../api/operation.js";

export const HERDR_MAX_REQUEST_BYTES = 1_048_576;
export const HERDR_MAX_RESPONSE_BYTES = 16 * 1_048_576;

export type HerdrRpcSubmission = "not-submitted" | "unknown";
export type HerdrRpcResult = { readonly type: string; readonly [key: string]: unknown };

/** API error codes need method-specific interpretation; a structured error can follow remote submission. */
export class HerdrRpcError extends Error {
  readonly method: string;
  readonly requestId: string;
  readonly submission: HerdrRpcSubmission;
  readonly code: string | null;
  readonly apiMessage: string | null;

  constructor(message: string, options: {
    method: string;
    requestId: string;
    submission: HerdrRpcSubmission;
    code?: string;
    apiMessage?: string;
    cause?: unknown;
  }) {
    super(message, { cause: options.cause });
    this.name = "HerdrRpcError";
    this.method = options.method;
    this.requestId = options.requestId;
    this.submission = options.submission;
    this.code = options.code === undefined ? null : options.code;
    this.apiMessage = options.apiMessage === undefined ? null : options.apiMessage;
  }
}

export const herdrIpcAddress = (endpoint: string, platform: NodeJS.Platform = process.platform): string => {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (typeof endpoint !== "string" || !pathApi.isAbsolute(endpoint) || endpoint.includes("\0")) {
    throw new TypeError("The Herdr endpoint must be an absolute logical path without NUL characters.");
  }
  return platform === "win32" ? `\\\\.\\pipe\\${endpoint}` : endpoint;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const encodeRequest = (id: string, method: string, params: Record<string, unknown>): Buffer => {
  if (typeof method !== "string" || method.trim() === "" || /[\r\n\0]/.test(method)) {
    throw new TypeError("The Herdr RPC method must be nonempty text without line breaks or NUL characters.");
  }
  if (!record(params)) throw new TypeError("The Herdr RPC parameters must be an object.");
  const json = JSON.stringify({ id, method, params }, (_key, value: unknown) => {
    if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint" ||
      (typeof value === "number" && !Number.isFinite(value))) {
      throw new TypeError("Herdr RPC parameters must contain JSON values without omitted or nonfinite entries.");
    }
    return value;
  });
  // Herdr bounds the bytes preceding the newline, not the framing byte itself.
  // https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/api/server.rs#L750-L765
  if (Buffer.byteLength(json, "utf8") > HERDR_MAX_REQUEST_BYTES) throw new RangeError("The Herdr RPC request exceeds the 1 MiB limit.");
  return Buffer.from(`${json}\n`, "utf8");
};

export const createHerdrRpcClient = (endpoint: string) => {
  const address = herdrIpcAddress(endpoint);
  return {
    request: async (method: string, params: Record<string, unknown>, operation: Operation): Promise<HerdrRpcResult> => {
      const requestId = randomUUID();
      let submission: HerdrRpcSubmission = "not-submitted";
      const failure = (message: string, cause: unknown): HerdrRpcError =>
        new HerdrRpcError(message, { method, requestId, submission, cause });
      let request: Buffer;
      let timeoutMs: number;
      let deadline: number;
      try {
        operation.check();
        request = encodeRequest(requestId, method, params);
        deadline = performance.now() + Math.min(operation.remainingMs(), operation.limits.requestMs);
        timeoutMs = Math.max(1, Math.ceil(deadline - performance.now()));
      } catch (cause) {
        throw failure(`Herdr RPC ${method} could not be prepared.`, cause);
      }
      return new Promise<HerdrRpcResult>((resolve, reject) => {
        const socket = new Socket();
        const chunks: Buffer[] = [];
        const responseLimit = Math.min(HERDR_MAX_RESPONSE_BYTES, operation.limits.responseBytes);
        let responseBytes = 0;
        let outcome: { result: HerdrRpcResult } | { error: HerdrRpcError } | undefined;
        const finish = (next: NonNullable<typeof outcome>): void => {
          if (outcome !== undefined) return;
          outcome = next;
          socket.destroy();
        };
        const fail = (message: string, cause: unknown): void => { finish({ error: failure(message, cause) }); };
        const onAbort = (): void => { fail(`Herdr RPC ${method} was cancelled.`, operation.signal.reason); };
        const check = (): void => {
          operation.check();
          if (performance.now() >= deadline) throw new Error("The Herdr RPC request deadline elapsed.");
        };
        const timer = setTimeout(() => {
          fail(`Herdr RPC ${method} deadline exceeded.`, new Error("The Herdr RPC request deadline elapsed."));
        }, timeoutMs);
        const onConnect = (): void => {
          if (outcome !== undefined) return;
          try {
            check();
            // A write failure cannot establish that the remote app received no bytes.
            submission = "unknown";
            socket.write(request, (cause) => {
              if (cause !== undefined && cause !== null) fail(`Herdr RPC ${method} could not complete its request write.`, cause);
            });
          } catch (cause) {
            fail(`Herdr RPC ${method} could not submit its request.`, cause);
          }
        };
        const onData = (chunk: Buffer): void => {
          if (outcome !== undefined) return;
          try {
            check();
            responseBytes += chunk.length;
            if (responseBytes > responseLimit) throw new RangeError("The Herdr RPC response exceeds its byte limit.");
            operation.consume(chunk.length);
            if (outcome !== undefined) return;
            const newline = chunk.indexOf(0x0a);
            if (newline < 0) { chunks.push(chunk); return; }
            const bytes = Buffer.concat([...chunks, chunk.subarray(0, newline)]);
            const frame = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
            const response: unknown = JSON.parse(frame);
            if (!record(response) || response.id !== requestId || Object.hasOwn(response, "result") === Object.hasOwn(response, "error")) {
              throw new Error("The Herdr RPC response must match its request ID and contain exactly one result or error.");
            }
            if (Object.hasOwn(response, "error")) {
              const body = response.error;
              if (!record(body) || typeof body.code !== "string" || body.code === "" || typeof body.message !== "string") {
                throw new Error("The Herdr RPC error response is malformed.");
              }
              finish({ error: new HerdrRpcError(`Herdr RPC ${method} returned ${body.code}: ${body.message}`, {
                method, requestId, submission, code: body.code, apiMessage: body.message, cause: body,
              }) });
              return;
            }
            if (!record(response.result) || typeof response.result.type !== "string" || response.result.type === "") {
              throw new Error("The Herdr RPC result must be an object with a type tag.");
            }
            finish({ result: response.result as HerdrRpcResult });
          } catch (cause) {
            fail(`Herdr RPC ${method} returned an invalid response.`, cause);
          }
        };
        const onError = (cause: Error): void => { fail(`Herdr RPC ${method} connection failed.`, cause); };
        const onEnd = (): void => { fail(`Herdr RPC ${method} closed before a complete response line.`, new Error("The Herdr IPC peer ended the response.")); };
        const onClose = (): void => {
          clearTimeout(timer);
          operation.signal.removeEventListener("abort", onAbort);
          socket.removeListener("connect", onConnect);
          socket.removeListener("data", onData);
          socket.removeListener("error", onError);
          socket.removeListener("end", onEnd);
          const completed = outcome;
          if (completed === undefined) {
            reject(failure(`Herdr RPC ${method} closed before a complete response line.`, new Error("The Herdr IPC connection closed.")));
          } else if ("error" in completed) reject(completed.error);
          else resolve(completed.result);
        };
        socket.once("connect", onConnect);
        socket.on("data", onData);
        socket.on("error", onError);
        socket.once("end", onEnd);
        socket.once("close", onClose);
        operation.signal.addEventListener("abort", onAbort, { once: true });
        if (operation.signal.aborted) onAbort();
        if (outcome === undefined) {
          try { socket.connect({ path: address }); }
          catch (cause) { fail(`Herdr RPC ${method} could not connect.`, cause); }
        }
      });
    },
  };
};

export type HerdrRpcClient = ReturnType<typeof createHerdrRpcClient>;
