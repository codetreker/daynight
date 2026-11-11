import type { FrozenToolObservation } from "./types.js";

/** Observations accompany the exact recipe checked at that time; they never resolve a tool. */
export const parseFrozenToolObservation = (value: unknown): FrozenToolObservation => {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).sort().join() !== "checkedAt,version") throw new Error("Frozen tool observation is invalid.");
  const { version, checkedAt } = value as Record<string, unknown>;
  if (typeof version !== "string" || version.trim() === "" || !version.isWellFormed() || /\p{Cc}/u.test(version) || Buffer.byteLength(version) > 256
    || typeof checkedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(checkedAt) || !Number.isFinite(Date.parse(checkedAt))) throw new Error("Frozen tool observation is invalid.");
  return { version, checkedAt };
};
