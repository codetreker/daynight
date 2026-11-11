import type { CopilotClient } from "@github/copilot-sdk";
import { ToolSelectionError, type ResolvedToolLaunch } from "../../../platform/tool-executables.js";
import { NativeCapabilityError } from "./native-selection.js";

/** SDK.start checks its protocol; status.get identifies the connected runtime. */
export const readCopilotRuntimeVersion = async (client: Pick<CopilotClient, "getStatus">, launch?: ResolvedToolLaunch): Promise<string> => {
  const status = await client.getStatus();
  if (!status || typeof status.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(status.version) || Buffer.byteLength(status.version) > 256 || !Number.isSafeInteger(status.protocolVersion) || status.protocolVersion < 1) {
    throw new NativeCapabilityError("capability_error", "Copilot runtime status is invalid or incompatible.");
  }
  if (launch?.runtimeProfile && status.version !== "1.0.105") throw new ToolSelectionError(launch.tool, launch.context, "launch", "incompatible_runtime");
  return status.version;
};
