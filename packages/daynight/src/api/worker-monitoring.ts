import { fields, malformed, timestamp } from "./validation.js";

export type DirectReceipt = { readonly receivedAt: string; readonly expiresAt: string };

export const parseMonitoringReceipt = (value: unknown): DirectReceipt => {
  const r = fields(value, ["receivedAt", "expiresAt"]);
  if (Object.keys(r).length !== 2) return malformed();
  const result = { receivedAt: timestamp(r.receivedAt), expiresAt: timestamp(r.expiresAt) };
  const nanoseconds = (value: string): bigint => {
    const fraction = value.match(/\.(\d+)Z$/)?.[1] ?? "";
    return BigInt(Date.parse(value.slice(0, 19) + "Z")) * 1_000_000n + BigInt(fraction.padEnd(9, "0") || "0");
  };
  if (nanoseconds(result.expiresAt) - nanoseconds(result.receivedAt) !== 3_600_000_000_000n) return malformed();
  return result;
};
