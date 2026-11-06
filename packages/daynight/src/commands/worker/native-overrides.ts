import type { WorkerCloudNative } from "../../api/worker-configuration.js";
import type { AgentControlMode, WorkerConfigurationValue, WorkerRuntimeNative, WorkerRuntimeConfiguration } from "../../api/types.js";
import type { WorkerLocalNativeOverrides } from "./local-native.js";
import { parse as parseToml } from "smol-toml";
import { parseProviderArguments } from "../controller/providers/projection.js";
import { validateHerdrAgentArguments } from "./herdr/arguments.js";

export type EffectiveWorkerNative = {
  native: WorkerCloudNative;
  report: WorkerRuntimeNative;
};
const text = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim() === "" || !value.isWellFormed() || /\p{Cc}/u.test(value)) throw new TypeError(`Native ${field} must be nonempty text.`);
  return value;
};
const source = (local: string | undefined, cloud: string | null): WorkerConfigurationValue => local !== undefined ? { value: local, source: "local" } : cloud !== null ? { value: cloud, source: "cloud" } : { value: null, source: "native" };

/** Canonicalize only model and effort; leave permissions and other native options with their existing validators. */
export const normalizeWorkerNative = (native: WorkerCloudNative, mode: AgentControlMode, overrides: WorkerLocalNativeOverrides = {}, validateOtherArguments = true): EffectiveWorkerNative => {
  const args: string[] = [];
  let argumentModel: string | null = null, argumentEffort: string | null = null;
  for (let index = 0; index < native.args.length; index++) {
    const argument = text(native.args[index], "argument"), equals = argument.indexOf("=");
    const option = equals < 0 ? argument : argument.slice(0, equals);
    const value = (): string => text(equals < 0 ? native.args[++index] : argument.slice(equals + 1), option);
    if (option === "--model" || option === "-m") { argumentModel = value(); continue; }
    if (option === "--effort" || native.agent === "copilot" && option === "--reasoning-effort") { argumentEffort = value(); continue; }
    if (native.agent === "codex" && (option === "-c" || option === "--config")) {
      const raw = value();
      const match = /^\s*(?:"(model|model_reasoning_effort)"|'(model|model_reasoning_effort)'|(model|model_reasoning_effort))\s*=(.*)$/u.exec(raw);
      if (match !== null) {
        const field = match[1] ?? match[2] ?? match[3]!;
        let parsed: unknown;
        try { parsed = parseToml(`value=${match[4]}`).value; }
        catch { parsed = match[4]!.trim(); }
        const normalized = text(parsed, field);
        if (field === "model") argumentModel = normalized; else argumentEffort = normalized;
      } else args.push(argument, ...(equals < 0 ? [raw] : []));
      continue;
    }
    args.push(argument);
    // Consume unrelated paired values before inspecting them as possible options.
    if (equals < 0 && index + 1 < native.args.length && !native.args[index + 1]!.startsWith("-")) args.push(native.args[++index]!);
  }
  const model = source(overrides.agentModel, native.model ?? argumentModel);
  const reasoningEffort = source(overrides.agentReasoningEffort, argumentEffort);
  if (model.value !== null) text(model.value, "model");
  if (reasoningEffort.value !== null) {
    const levels = native.agent === "codex" ? ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] : native.agent === "claude" ? ["low", "medium", "high", "xhigh", "max"] : ["low", "medium", "high", "xhigh", "max"];
    if (!levels.includes(reasoningEffort.value)) throw new TypeError(`Unsupported ${native.agent} reasoning effort: ${reasoningEffort.value}.`);
    if (mode === "web" || native.agent === "claude") args.push("--effort", reasoningEffort.value);
    else if (native.agent === "copilot") args.push("--reasoning-effort", reasoningEffort.value);
    else args.push("-c", `model_reasoning_effort=${JSON.stringify(reasoningEffort.value)}`);
  }
  if (validateOtherArguments) {
    if (mode === "web") parseProviderArguments(native.agent, args); else validateHerdrAgentArguments(native.agent, args);
  }
  return { native: { agent: native.agent, model: model.value, args }, report: { agent: native.agent, model, reasoningEffort } };
};

/** Optional telemetry must not make a previously valid cloud configuration stop heartbeats. */
export const workerRuntimeConfigurationReport = (effective: {
  native: WorkerCloudNative | null;
  projects: readonly { projectId: string; native: WorkerCloudNative | null }[];
}, mode: AgentControlMode, local: WorkerLocalNativeOverrides, configurationSource: "local" | "cloud" = "cloud"): WorkerRuntimeConfiguration | undefined => {
  if (effective.projects.length > 1024) return undefined;
  const report = (native: WorkerCloudNative | null): WorkerRuntimeNative | null => {
    if (native === null) return null;
    const value = normalizeWorkerNative(native, mode, local).report;
    if (value.model.value !== null && Buffer.byteLength(value.model.value) > 256) return null;
    const provenance = (field: WorkerConfigurationValue): WorkerConfigurationValue => configurationSource === "local" && field.source === "cloud" ? { ...field, source: "local" } : field;
    return { ...value, model: provenance(value.model), reasoningEffort: provenance(value.reasoningEffort) };
  };
  return { schemaVersion: 1, native: report(effective.native), projects: effective.projects.map(project => ({ projectId: project.projectId, native: report(project.native) })) };
};
