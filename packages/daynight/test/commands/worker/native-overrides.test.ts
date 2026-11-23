import { describe, expect, it } from "vitest";
import { parseWorkerLocalConfiguration } from "../../../src/commands/worker/configuration-source.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { normalizeWorkerNative, workerRuntimeConfigurationReport } from "../../../src/commands/worker/native-overrides.js";
import { parseWorkerConfiguration } from "../../../src/commands/worker/config.js";

const paths = resolveWorkerPaths("/tmp/daynight-override-home");

describe("Worker local native overrides", () => {
  it("retains both independent overrides after cloud registration", () => {
    const local = parseWorkerLocalConfiguration('worker:\n  agentModel: local-model\n  agentReasoningEffort: high\n', paths);
    expect(local).toMatchObject({ agentModel: "local-model", agentReasoningEffort: "high" });
  });

  it("also applies local fields in legacy configuration validation", () => {
    expect(parseWorkerConfiguration('worker:\n  agent: codex\n  agentControlMode: web\n  agentModel: local-model\n  agentReasoningEffort: high\n', paths)).toMatchObject({ model: "local-model", args: ["--effort", "high"] });
  });

  it.each(["null", '""', '"  "', "false", "42"])("rejects explicit invalid local values: %s", value => {
    for (const field of ["agentModel", "agentReasoningEffort"]) {
      expect(() => parseWorkerLocalConfiguration(`worker:\n  ${field}: ${value}\n`, paths)).toThrow(field);
    }
  });

  it("rejects contradictory legacy and local model values", () => {
    expect(() => parseWorkerLocalConfiguration("worker:\n  model: old\n  agentModel: new\n", paths)).toThrow("model");
    expect(parseWorkerLocalConfiguration("worker:\n  model: new\n  agentModel: new\n", paths)).toMatchObject({ agentModel: "new" });
    expect(parseWorkerLocalConfiguration("worker:\n  model: null\n  agentModel: new\n", paths)).toMatchObject({ agentModel: "new" });
  });
});

describe("Worker effective native configuration", () => {
  for (const agent of ["codex", "claude", "copilot"] as const) {
    it(`${agent} combines independent overrides and restores cloud values after removal`, () => {
      const effortArgs = ["--effort", "medium"];
      const cloud = { agent, model: "cloud-model", args: effortArgs };
      for (const agentModel of [undefined, "local-model"]) for (const agentReasoningEffort of [undefined, "high"]) {
        const overrides = { ...(agentModel === undefined ? {} : { agentModel }), ...(agentReasoningEffort === undefined ? {} : { agentReasoningEffort }) };
        const value = normalizeWorkerNative(cloud, overrides);
        expect(value.native.model).toBe(agentModel ?? "cloud-model");
        expect(value.report).toEqual({ agent, model: { value: agentModel ?? "cloud-model", source: agentModel ? "local" : "cloud" }, reasoningEffort: { value: agentReasoningEffort ?? "medium", source: agentReasoningEffort ? "local" : "cloud" } });
        expect(normalizeWorkerNative(value.native, {}).native).toEqual(value.native);
      }
      expect(normalizeWorkerNative(cloud, {}).native).toEqual(cloud);
      expect(normalizeWorkerNative({ agent, model: null, args: [] }, {}).report).toEqual({ agent, model: { value: null, source: "native" }, reasoningEffort: { value: null, source: "native" } });
    });
  }

  it("normalizes argument model and effort duplicates before applying local values", () => {
    const value = normalizeWorkerNative({ agent: "codex", model: "cloud", args: ["--model", "arg-model", "-c", 'model="config-model"', "--effort", "low", "--effort", "medium", "--sandbox", "read-only"] }, { agentModel: "local", agentReasoningEffort: "high" });
    expect(value.native).toEqual({ agent: "codex", model: "local", args: ["--sandbox", "read-only", "--effort", "high"] });
  });

  it("keeps unrelated Codex TOML configuration and normalizes quoted keys", () => {
    const value = normalizeWorkerNative({ agent: "codex", model: null, args: ["--config", '"model"="from-args"', "-c", "features.search=true", "--config=model_reasoning_effort='low'", "-c", 'model_reasoning_effort="medium"'] }, { agentReasoningEffort: "high" }, false);
    expect(value.native).toEqual({ agent: "codex", model: "from-args", args: ["-c", "features.search=true", "--effort", "high"] });
  });

  it("rejects invalid values for the actual provider and malformed model arguments", () => {
    expect(() => normalizeWorkerNative({ agent: "copilot", model: null, args: [] }, { agentReasoningEffort: "ultra" })).toThrow("copilot");
    expect(() => normalizeWorkerNative({ agent: "claude", model: null, args: [] }, { agentReasoningEffort: "minimal" })).toThrow("claude");
    expect(() => normalizeWorkerNative({ agent: "codex", model: null, args: ["-c", "model=3"] }, {})).toThrow("model");
    expect(() => normalizeWorkerNative({ agent: "codex", model: null, args: ["--model"] }, {})).toThrow("model");
  });

  it("retains Claude xhigh and maps Herdr effort syntax for Web assistant defaults", () => {
    expect(normalizeWorkerNative({ agent: "claude", model: null, args: [] }, { agentReasoningEffort: "xhigh" }).native.args).toEqual(["--effort", "xhigh"]);
    expect(normalizeWorkerNative({ agent: "copilot", model: null, args: ["--reasoning-effort", "high"] }, {}).native.args).toEqual(["--effort", "high"]);
    expect(normalizeWorkerNative({ agent: "codex", model: null, args: ["-c", 'model_reasoning_effort="high"'] }, {}).native.args).toEqual(["--effort", "high"]);
  });

  it("bounds optional source telemetry without rejecting a legacy cloud target", () => {
    const native = { agent: "codex" as const, model: "x".repeat(257), args: [] };
    expect(workerRuntimeConfigurationReport({ native, projects: [] }, {})).toEqual({ schemaVersion: 1, native: null, projects: [] });
    expect(workerRuntimeConfigurationReport({ native, projects: Array.from({ length: 1025 }, (_, index) => ({ projectId: String(index), native })) }, {})).toBeUndefined();
  });
});
