/** Missing evidence belongs to a legacy writer and never establishes non-dispatch. */
export type NativeInitialization = { readonly version: 1; readonly state: "not_dispatched" | "dispatching" };

export const parseNativeInitialization = (value: unknown): NativeInitialization => {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join() !== "state,version"
    || !("version" in value) || value.version !== 1 || !("state" in value)
    || value.state !== "not_dispatched" && value.state !== "dispatching") {
    throw new Error("Native initialization dispatch evidence is invalid.");
  }
  return value as NativeInitialization;
};
