import type { Operation } from "../../api/operation.js";
import { validateServerToken, validateTokenTransport } from "../../config/server-token.js";

export class DeviceRequestTimeoutError extends Error {
  constructor(cause: unknown) { super("Device authorization HTTP request timed out.", { cause }); this.name = "DeviceRequestTimeoutError"; }
}

const CLIENT_ID = "daynight-cli";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
export type DeviceAuthorization = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
};
export type TokenResult = { token: string } | { pending: true; slowDown: boolean };

const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid device authorization response.");
  return value as Record<string, unknown>;
};
const textField = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\s\p{Cc}]/u.test(value)) throw new Error("Invalid device authorization response.");
  return value;
};
const seconds = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid device authorization response.");
  return value;
};
const verificationUrl = (value: unknown, origin: string, userCode?: string): string => {
  const raw = textField(value);
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error("Invalid device verification URL."); }
  const keys = [...url.searchParams.keys()];
  const validQuery = userCode === undefined ? url.search === "" : keys.length === 1 && keys[0] === "user_code" && url.searchParams.get("user_code") === userCode;
  if (raw.includes("\\") || url.origin !== origin || url.username !== "" || url.password !== "" || url.pathname !== "/device" || url.hash !== "" || !validQuery) throw new Error("Invalid device verification URL.");
  return url.href;
};

export const createDeviceClient = (origin: string, operation: Operation, fetch: typeof globalThis.fetch = globalThis.fetch) => {
  validateTokenTransport(origin);
  const request = async (path: "code" | "token" | "logout", fields?: Record<string, string>, token?: string, suppliedSignal?: AbortSignal): Promise<{ status: number; body: unknown }> => {
    operation.check();
    const signal = AbortSignal.any([operation.signal, ...(suppliedSignal === undefined ? [] : [suppliedSignal]), AbortSignal.timeout(Math.min(operation.limits.requestMs, Math.ceil(operation.remainingMs())))]);
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => reject(signal.reason);
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) abortListener();
    });
    let response: Response;
    const chunks: Uint8Array[] = [];
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let readFailure: unknown;
    let done = false;
    try {
      response = await Promise.race([fetch(new URL(`/api/v1/auth/device/${path}`, origin), {
        method: "POST", redirect: "manual", cache: "no-store", signal,
        headers: { Accept: "application/json", ...(fields === undefined ? {} : { "Content-Type": "application/x-www-form-urlencoded" }), ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) },
        ...(fields === undefined ? {} : { body: new URLSearchParams(fields).toString() }),
      }), aborted]);
      reader = response.body?.getReader();
      let bytes = 0;
      if (reader !== undefined) {
        void reader.closed.catch((cause: unknown) => { readFailure = cause; });
        for (;;) {
          const chunk = await Promise.race([reader.read(), aborted]);
          operation.check();
          if (chunk.done) { done = true; break; }
          bytes += chunk.value.byteLength;
          operation.consume(chunk.value.byteLength);
          if (bytes > 65_536) throw new Error("Device authorization response exceeds its size limit.");
          chunks.push(chunk.value);
        }
      }
    } catch (cause) {
      let failure = cause;
      try { operation.check(); }
      catch (operationFailure) { failure = operationFailure; }
      if (failure === cause && signal.aborted && signal.reason instanceof Error && signal.reason.name === "TimeoutError") failure = new DeviceRequestTimeoutError(cause);
      if (reader !== undefined && !done && readFailure === undefined) {
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([reader.cancel(failure), new Promise<never>((_resolve, reject) => {
            cleanupTimer = setTimeout(() => reject(new Error("Device response cleanup exceeded its 100 ms deadline.")), 100);
          })]);
        } catch (cleanupFailure) {
          if (cleanupFailure !== cause && cleanupFailure !== readFailure) failure = new AggregateError([failure, cleanupFailure], "Device authorization failed and response cleanup failed.", { cause: failure });
        } finally { if (cleanupTimer !== undefined) clearTimeout(cleanupTimer); }
      }
      throw failure;
    } finally {
      if (abortListener !== undefined) signal.removeEventListener("abort", abortListener);
      reader?.releaseLock();
    }
    operation.check();
    if (path === "logout" && [204, 401].includes(response.status)) return { status: response.status, body: undefined };
    if (response.status >= 300 && response.status < 400) throw new Error("Device authorization redirects are not allowed.");
    let body: unknown;
    try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new Error(`Invalid device authorization response (HTTP ${response.status}).`); }
    return { status: response.status, body };
  };
  const failure = (status: number, body: unknown): never => {
    const error = object(body).error;
    const errors: Record<string, string> = {
      access_denied: "Device authorization was denied.",
      expired_token: "Device authorization expired. Run daynight login again.",
      invalid_grant: "Device authorization is invalid or already used. Run daynight login again.",
      invalid_client: "This CLI is not accepted by the server.",
      slow_down: "Too many device authorization requests. Try daynight login later.",
    };
    throw new Error(typeof error === "string" && Object.hasOwn(errors, error) ? errors[error]! : `Device authorization failed (HTTP ${status}).`);
  };
  return {
    begin: async (): Promise<DeviceAuthorization> => {
      const { status, body } = await request("code", { client_id: CLIENT_ID });
      if (status !== 200) failure(status, body);
      const value = object(body);
      const userCode = textField(value.user_code);
      return {
        deviceCode: textField(value.device_code), userCode,
        verificationUri: verificationUrl(value.verification_uri, origin),
        ...(value.verification_uri_complete === undefined ? {} : { verificationUriComplete: verificationUrl(value.verification_uri_complete, origin, userCode) }),
        expiresIn: seconds(value.expires_in), interval: value.interval === undefined ? 5 : Math.min(600, seconds(value.interval)),
      };
    },
    poll: async (deviceCode: string, signal?: AbortSignal): Promise<TokenResult> => {
      const { status, body } = await request("token", { client_id: CLIENT_ID, grant_type: GRANT_TYPE, device_code: deviceCode }, undefined, signal);
      const value = object(body);
      if (status === 200) {
        if (value.token_type !== "Bearer") throw new Error("Invalid device authorization token type.");
        if (Object.hasOwn(value, "expires_in")) seconds(value.expires_in);
        return { token: validateServerToken(value.access_token) };
      }
      if (status === 400 && (value.error === "authorization_pending" || value.error === "slow_down")) return { pending: true, slowDown: value.error === "slow_down" };
      return failure(status, body);
    },
    logout: async (token: string): Promise<void> => {
      try {
        const { status } = await request("logout", undefined, validateServerToken(token));
        if (status !== 204 && status !== 401) throw new Error(`Credential revocation failed (HTTP ${status}).`);
      } catch (cause) {
        throw new Error("POST /api/v1/auth/device/logout did not confirm revocation. The local credential was preserved.", { cause });
      }
    },
  };
};
