import type { JsonValue } from "../../api/assistant-task-types.js";
import { canonicalId } from "../../api/parse.js";

export const assistantTaskId = (value: string): string => {
  const parsed = canonicalId(value);
  if (parsed === null || parsed !== value || value === "00000000-0000-0000-0000-000000000000") throw new Error("Expected a nonzero canonical lowercase UUID.");
  return value;
};
export const assistantTaskInteger = (value: string, zero = false): string => {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n || !zero && value === "0") throw new Error("Expected an exact decimal int64 string.");
  return value;
};
export const assistantTaskJson = (value: string): JsonValue => JSON.parse(value, (_key, item: unknown) => {
  if (typeof item === "number" && (!Number.isFinite(item) || Number.isInteger(item) && !Number.isSafeInteger(item))) throw new Error("JSON numbers must be finite and integer values must be exactly representable.");
  return item;
}) as JsonValue;
