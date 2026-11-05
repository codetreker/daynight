import type { StartupObservation } from "../../session/startup.js";
import { NativeRpcError, NativeRpcTimeoutError } from "./providers/native-rpc.js";

export class ControllerStartupError extends Error {
  constructor(readonly observation: StartupObservation, message: string, options?: ErrorOptions) { super(message, options); }
}

/** Only native rejection establishes failure; transport and unclassified errors retain uncertainty. */
export const startupFailure = (error: unknown): StartupObservation => {
  if (error instanceof ControllerStartupError) return error.observation;
  if (error instanceof NativeRpcError) return { state: "failed", reasonCode: "native_rejected" };
  if (error instanceof NativeRpcTimeoutError) return { state: "unknown", reasonCode: "native_timeout" };
  return { state: "unknown", reasonCode: "native_transport_unknown" };
};

export { startupSummary } from "../../session/startup.js";
