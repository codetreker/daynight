import path from "node:path";
import { openLifecycleStore, LifecycleAdmissionError, type LifecycleBinding } from "../worker/lifecycle-store.js";
import { NativeDispatchRejectedError } from "./providers/native-rpc.js";
import { parseControllerLifecycleBinding } from "./launch-ticket.js";

/** Frozen original Worker identity carried across an owned helper process. */
export type NativeLifecycleFence = { readonly file: string; readonly binding: LifecycleBinding };
export const freezeNativeLifecycleFence = (value: unknown): NativeLifecycleFence => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Native lifecycle fence is missing.");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).sort().join() !== "binding,file" || typeof data.file !== "string" || !path.isAbsolute(data.file) || /[\0\r\n]/.test(data.file)) throw new Error("Native lifecycle fence is invalid.");
  return Object.freeze({ file: data.file, binding: Object.freeze({ ...parseControllerLifecycleBinding(data.binding) }) });
};

/** Only an explicit closed admission proves refusal; I/O failures stay unknown. */
export const assertProviderNativeDispatch = (assertion?: () => void): void => {
  try { assertion?.(); }
  catch (error) {
    if (error instanceof LifecycleAdmissionError) throw new NativeDispatchRejectedError(error.message);
    throw error;
  }
};

/** Read the original database at the final native boundary, including after awaits. */
export const assertNativeLifecycleAdmission = (fence: NativeLifecycleFence): void => {
  const { binding } = fence;
  const store = openLifecycleStore({ file: fence.file, identity: { serverOrigin: binding.serverOrigin, userId: binding.userId, workerId: binding.workerId }, allowCreate: false });
  try { assertProviderNativeDispatch(() => store.assertAdmission(binding)); }
  finally { store.close(); }
};
