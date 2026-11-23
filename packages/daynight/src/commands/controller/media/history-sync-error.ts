import type { ArchiveRequestError } from "../archive-error.js";

const maxDiagnosticBytes = 16 * 1024;
type HistoryOperation = "GET status" | "PUT chunk";
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Describe the existing failure without reading its body again or changing retry classification. */
export const describeHistorySyncError = (error: ArchiveRequestError, operation: HistoryOperation): ArchiveRequestError => {
  const details = [String(error.status)];
  // Business error parsing has its own larger budget. Diagnostics use identifiers
  // only from a complete envelope within this separate limit.
  if (error.responseByteLength !== undefined && error.responseByteLength <= maxDiagnosticBytes
    && record(error.payload) && record(error.payload.error)) {
    const { code, requestId } = error.payload.error;
    if (typeof code === "string" && /^[a-z0-9_]{1,64}$/.test(code)) details.push(`code=${code}`);
    if (typeof requestId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(requestId)) details.push(`requestId=${requestId}`);
  }
  error.message = `Controller history synchronization ${operation} failed (${details.join("; ")}).`;
  return error;
};
