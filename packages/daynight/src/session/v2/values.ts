// Browser-safe values shared by producers and readers. v1 retains its own parser.
export const SESSION_V2_PROTOCOL = "daynight.session.v2" as const;
export const SESSION_PROTOCOL_HEADER = "Daynight-Session-Protocol" as const;
export const SESSION_V2_LIMITS = {
  leaseTtlMs: 30_000, leaseRenewMs: 10_000, inputMaxBytes: 16 * 1024, inputTimeoutMs: 10_000,
  archiveMaxBytes: 64 * 1024 * 1024, recordingMaxBytes: 60 * 1024 * 1024, metadataMaxBytes: 4 * 1024 * 1024,
  maxRuns: 1000, maxRowBytes: 16 * 1024, maxTextRuns: 1000,
  frameMaxBytes: 256 * 1024, maxFrames: 100_000, maxSegments: 1000, maxGaps: 1000, maxDimension: 1000,
  sampleIntervalMs: 350, checkpointIntervalMs: 5000, maxRetainedWorktrees: 20,
  pendingSourceMaxBytes: 2 * 1024 * 1024 * 1024, minimumFreeBytes: 1024 * 1024 * 1024,
  viewerPendingFrames: 1, viewerStallMs: 10_000, uploadRetryMinMs: 5000, uploadRetryMaxMs: 300_000,
} as const;
export type SessionV2ErrorCode = "permission_denied" | "stale_fence" | "target_changed" | "lease_expired" | "input_busy" | "automation_suspended" | "unsupported_protocol" | "unsupported_content_kind" | "input_unknown" | "recording_limit" | "source_corrupt" | "stop_unknown" | "archive_pending" | "recording_not_enabled" | "ended_before_first_sample" | "upload_failed" | "invalid_payload";
export const ERROR_CODES: readonly SessionV2ErrorCode[] = ["permission_denied", "stale_fence", "target_changed", "lease_expired", "input_busy", "automation_suspended", "unsupported_protocol", "unsupported_content_kind", "input_unknown", "recording_limit", "source_corrupt", "stop_unknown", "archive_pending", "recording_not_enabled", "ended_before_first_sample", "upload_failed", "invalid_payload"];
export class SessionV2Error extends Error {
  constructor(readonly code: SessionV2ErrorCode = "invalid_payload") { super(`Invalid Daynight Session v2 value: ${code}.`); this.name = "SessionV2Error"; }
}
export const fail = (code?: SessionV2ErrorCode): never => { throw new SessionV2Error(code); };
export const utf8 = new TextEncoder();
export const exact = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== keys.length || keys.some(key => !Object.hasOwn(data, key))) return fail();
  return data;
};
export const text = (value: unknown, maxBytes = 256, allowEmpty = false): string => {
  if (typeof value !== "string" || !value.isWellFormed() || (!allowEmpty && !value.length) || utf8.encode(value).length > maxBytes) return fail();
  return value;
};
export const nativeText = (value: unknown): string => { const result = text(value); return /\p{Cc}/u.test(result) || !result.trim() ? fail() : result; };
export const uuid = (value: unknown): string => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value) ? value : fail();
export const seq = (value: unknown, zero = false): string => typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value) && (zero || value !== "0") && BigInt(value) <= 9223372036854775807n ? value : fail();
export const integer = (value: unknown, min: number, max: number): number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : fail();
export const bool = (value: unknown): boolean => typeof value === "boolean" ? value : fail();
export const literal = <T extends string | number | boolean>(value: unknown, expected: T): T => value === expected ? expected : fail();
export const choice = <T extends string>(value: unknown, choices: readonly T[]): T => typeof value === "string" && choices.includes(value as T) ? value as T : fail();
export const nullable = <T>(value: unknown, parse: (value: unknown) => T): T | null => value === null ? null : parse(value);
export const list = <T>(value: unknown, parse: (value: unknown) => T, max = 1000, min = 0): T[] => Array.isArray(value) && value.length >= min && value.length <= max ? value.map(parse) : fail();
export const unique = <T>(values: T[], key: (value: T) => string): T[] => new Set(values.map(key)).size === values.length ? values : fail();
export const hash = (value: unknown): string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : fail();
export const timestamp = (value: unknown): string => {
  const result = text(value, 24);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(result)) return fail();
  const date = new Date(result);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== result.slice(0, 19)) return fail();
  return result;
};
export const errorCode = (value: unknown): SessionV2ErrorCode => choice(value, ERROR_CODES);
export const byteLength = (value: unknown, max = SESSION_V2_LIMITS.archiveMaxBytes): string => { const result = seq(value); return BigInt(result) <= BigInt(max) ? result : fail(); };
export const origin = (value: unknown): string => {
  const result = text(value, 2048); let url: URL; try { url = new URL(result); } catch { return fail(); }
  return ["http:", "https:"].includes(url.protocol) && url.origin === result && (/^[a-z0-9._-]+$/.test(url.hostname) || /^\[[0-9a-f:]+\]$/.test(url.hostname)) ? result : fail();
};
export const selectSessionProtocol = (selection: string | null | undefined): "daynight.session.v1" | typeof SESSION_V2_PROTOCOL => {
  if (selection === null || selection === undefined) return "daynight.session.v1";
  if (selection === "daynight.session.v1" || selection === SESSION_V2_PROTOCOL) return selection;
  return fail("unsupported_protocol");
};

/** Reject duplicate decoded keys, invalid Unicode and non-JSON values before object parsing. */
export const decodeStrictSessionJson = (input: string | Uint8Array, maxBytes = SESSION_V2_LIMITS.archiveMaxBytes): unknown => {
  let source: string;
  if (typeof input === "string") { if (!input.isWellFormed() || utf8.encode(input).length > maxBytes) return fail(); source = input; }
  else { if (input.length > maxBytes) return fail(); try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input); } catch { return fail(); } }
  let at = 0;
  const space = () => { while (/[\x20\t\r\n]/.test(source[at] ?? "") && at < source.length) at++; };
  const string = (): string => {
    const begin = at++;
    while (at < source.length) {
      const c = source[at++];
      if (c === '"') { let parsed: unknown; try { parsed = JSON.parse(source.slice(begin, at)); } catch { return fail(); } return text(parsed, maxBytes, true); }
      if (c === "\\") at++;
    }
    return fail();
  };
  const value = (depth: number): unknown => {
    if (depth > 64) return fail(); space(); const c = source[at];
    if (c === '"') return string();
    if (c === "{") {
      at++; space(); const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      if (source[at] === "}") { at++; return out; }
      for (;;) {
        space(); if (source[at] !== '"') return fail(); const key = string();
        if (Object.hasOwn(out, key)) return fail(); space(); if (source[at++] !== ":") return fail(); out[key] = value(depth + 1); space();
        const end = source[at++]; if (end === "}") return out; if (end !== ",") return fail();
      }
    }
    if (c === "[") {
      at++; space(); const out: unknown[] = []; if (source[at] === "]") { at++; return out; }
      for (;;) { out.push(value(depth + 1)); space(); const end = source[at++]; if (end === "]") return out; if (end !== ",") return fail(); }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(at));
    if (!token) return fail(); at += token[0].length; const parsed: unknown = JSON.parse(token[0]);
    return typeof parsed === "number" && !Number.isFinite(parsed) ? fail() : parsed;
  };
  const result = value(0); space(); if (at !== source.length) return fail(); return result;
};

/** v2 object keys are ASCII; arrays retain their protocol ordering. */
export const canonicalSessionJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(text(value, SESSION_V2_LIMITS.archiveMaxBytes, true));
  if (typeof value === "number") return String(integer(value, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER));
  if (Array.isArray(value)) return `[${value.map(canonicalSessionJson).join(",")}]`;
  if (!value || typeof value !== "object") return fail();
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalSessionJson(record[key])}`).join(",")}}`;
};
export const hashSessionBytes = async (input: string | Uint8Array): Promise<string> => {
  const bytes = typeof input === "string" ? utf8.encode(input) : Uint8Array.from(input);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
};
