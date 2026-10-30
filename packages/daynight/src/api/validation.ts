import { isNonemptyText, isText } from "../platform/text.js";

export class ProtocolError extends Error {
  constructor(message = "The server returned an invalid response.") { super(message); this.name = "ProtocolError"; }
}
export const malformed = (): never => { throw new ProtocolError(); };
export const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return malformed();
  return value as Record<string, unknown>;
};
export const text = (value: unknown, nonempty = false): string => {
  if (!isText(value) || (nonempty && !isNonemptyText(value))) return malformed();
  return value;
};
export const bool = (value: unknown): boolean => typeof value === "boolean" ? value : malformed();
export const count = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : malformed();
export const resourceVersion = (value: unknown): bigint => typeof value === "bigint" && value >= 1n && value <= 9_223_372_036_854_775_807n ? value : malformed();
export const canonicalId = (value: string): string | null => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : null;
export const id = (value: unknown): string => {
  const parsed = text(value);
  if (canonicalId(parsed) !== parsed) return malformed();
  return parsed;
};
export const timestamp = (value: unknown): string => {
  const parsed = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(parsed)) return malformed();
  const milliseconds = Date.parse(parsed);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 19) !== parsed.slice(0, 19)) return malformed();
  return parsed;
};
export const nullableTimestamp = (value: unknown): string | null => value === null ? null : timestamp(value);
export const array = <T>(value: unknown, parse: (item: unknown) => T): T[] => Array.isArray(value) ? value.map((item) => parse(item)) : malformed();

export const fields = (value: unknown, names: readonly string[]): Record<string, unknown> => {
  const data = record(value);
  if (Object.keys(data).some((key) => !names.includes(key))) return malformed();
  return data;
};
