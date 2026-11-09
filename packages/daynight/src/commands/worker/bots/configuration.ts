import type { WorkerCloudNative } from "../../../api/worker-configuration.js";
import { normalizeWorkerNative } from "../native-overrides.js";
import type { BotConfiguration } from "./types.js";

/** Convert the frozen selection once; current Worker defaults never participate. */
export const botNativeConfiguration = (configuration: BotConfiguration): WorkerCloudNative => {
  const native = { agent: configuration.provider, model: configuration.model, args: [...configuration.args] };
  // Legacy launch tickets retain their original argument shape across upgrades.
  if (configuration.selection === undefined) return native;
  const normalized = normalizeWorkerNative(native, "web", configuration.reasoningEffort == null ? {} : { agentReasoningEffort: configuration.reasoningEffort }, true, true);
  // A null final effort delegates to native defaults, even if the report carried
  // an older argument value. Normalization places its single effort pair last.
  const args = configuration.reasoningEffort === null && normalized.report.reasoningEffort.value !== null
    ? normalized.native.args.slice(0, -2) : normalized.native.args;
  return { agent: configuration.provider, model: configuration.model, args };
};
