import { describe, expect, it } from "vitest";
import { assertNativeModelSelection } from "../../../src/commands/controller/providers/native-selection.js";

describe("native model selection validation", () => {
  const models = [{ id: "native-model", aliases: ["alias"], efforts: ["low", "high"] }];
  it("accepts an evidenced native alias and supported effort", () => {
    expect(() => assertNativeModelSelection("claude", { model: "alias", effort: "high" }, { models, model: "native-model", effort: "high" })).not.toThrow();
  });
  it("validates inherited native effort when only the model is overridden", () => {
    expect(() => assertNativeModelSelection("codex", { model: "native-model" }, { models, model: "native-model", effort: "medium" })).toThrow("inherited");
  });
  it("refuses ambiguous default aliases with conflicting model capabilities", () => {
    expect(() => assertNativeModelSelection("claude", { model: null, effort: "high" }, { models: [...models, { id: "different", aliases: ["alias"], efforts: ["low"] }], model: "alias", effort: "high" })).toThrow("ambiguous");
  });
  it.each([
    [{ model: "unknown", effort: "high" }, { models, model: "native-model", effort: "high" }, "model"],
    [{ model: null, effort: "high" }, { models, model: null, effort: "high" }, "unknown"],
    [{ model: "native-model", effort: "medium" }, { models, model: "native-model", effort: "medium" }, "effort"],
    [{ model: "native-model", effort: "high" }, { models, model: "native-model", effort: "low" }, "apply"],
    [{ model: "native-model" }, { models, model: "other", effort: null }, "model"],
    [{ model: null, effort: "high" }, { models: [], model: "native-model", effort: "high" }, "model"],
  ] as const)("rejects an unproved or incompatible selection %#", (requested, actual, reason) => {
    expect(() => assertNativeModelSelection("codex", requested, actual)).toThrow(reason);
  });
});
