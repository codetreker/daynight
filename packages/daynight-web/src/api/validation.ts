import type { ExecutionPlatform, TaskStatus } from "./types";

export const malformed = (): never => {
  throw new Error("The server returned an invalid response.");
};

export const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return malformed();
  return value as Record<string, unknown>;
};

export const string = (value: unknown): string => {
  if (typeof value !== "string") return malformed();
  return value;
};

export const nonemptyString = (value: unknown): string => {
  const parsed = string(value);
  if (parsed.trim() === "" || parsed.includes("\0")) return malformed();
  return parsed;
};

export const boolean = (value: unknown): boolean => {
  if (typeof value !== "boolean") return malformed();
  return value;
};

export const count = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return malformed();
  return value;
};

export const canonicalId = (value: string): string | null =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : null;

export const id = (value: unknown): string => {
  const parsed = canonicalId(string(value));
  if (parsed === null) return malformed();
  return parsed;
};

export const timestamp = (value: unknown): string => {
  const parsed = string(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(parsed)) return malformed();
  const milliseconds = Date.parse(parsed);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 19) !== parsed.slice(0, 19)) {
    return malformed();
  }
  return parsed;
};

export const nullableTimestamp = (value: unknown): string | null => value === null ? null : timestamp(value);

export const array = <T>(value: unknown, parse: (item: unknown) => T): T[] => {
  if (!Array.isArray(value)) return malformed();
  return value.map(parse);
};

export const ids = (value: unknown): string[] => {
  const values = array(value, id);
  if (new Set(values).size !== values.length) return malformed();
  return values;
};

export const executionPlatform = (value: unknown): ExecutionPlatform => {
  if (value !== "windows" && value !== "linux" && value !== "macos") return malformed();
  return value;
};

export const requiredPlatform = (value: unknown): ExecutionPlatform | null => value === null ? null : executionPlatform(value);

export const status = (value: unknown): TaskStatus => {
  if (value !== "todo" && value !== "in_progress" && value !== "done") return malformed();
  return value;
};
