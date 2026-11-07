import { afterEach, describe, expect, it } from "vitest";
import { parseBot, type BotDefinition } from "../../../src/commands/worker/bots/types.js";
import { normalizeWorkerNative } from "../../../src/commands/worker/native-overrides.js";
import { parseProviderArguments } from "../../../src/commands/controller/providers/projection.js";
import { assertNativeModelSelection } from "../../../src/commands/controller/providers/native-selection.js";
import { cleanupBotStores, createBotStoreFixture, bot, owner, id } from "./bot-store.fixtures.js";
import { createMemoryDatabase } from "../../helpers/sqlite.js";

const selection = { schemaVersion: 1, modelSource: "explicit", reasoningEffortSource: "preference", configurationGeneration: "a".repeat(64), catalogGeneration: id(20) };
const selected = () => {
  const original = bot() as BotDefinition;
  return { ...original, requestedOverrides: { model: "model-a" }, resolvedConfiguration: { ...original.resolvedConfiguration, model: "model-a", reasoningEffort: "none", selection: { ...selection } } };
};
afterEach(cleanupBotStores);

describe("Bot frozen model selection", () => {
  it("retains explicit request fields and the exact selection through inventory persistence", () => {
    const f = createBotStoreFixture(() => createMemoryDatabase());
    const original = selected();
    f.store.observe(owner, original as BotDefinition, 1);
    expect(f.store.get(owner, id(3))?.definition).toEqual(original);
    expect(() => f.store.observe(owner, { ...original, version: "2", resolvedConfiguration: { ...original.resolvedConfiguration, reasoningEffort: "high" } } as BotDefinition, 2)).toThrow(/configuration/);
    expect(() => f.store.observe(owner, { ...original, version: "2", resolvedConfiguration: { ...original.resolvedConfiguration, selection: { ...selection, modelSource: "local" } } } as BotDefinition, 2)).toThrow(/configuration/);
  });

  it("preserves a legacy configuration without adding new fields", () => {
    expect(parseBot(bot(), owner)).toEqual(bot());
  });

  it("retains an explicit null effort in a new configuration", () => {
    const original = selected();
    original.resolvedConfiguration.reasoningEffort = null as unknown as string;
    original.resolvedConfiguration.selection.reasoningEffortSource = "native";
    expect(parseBot(original, owner)).toEqual(original);
  });

  it.each([
    { selection: null },
    { selection: { ...selection, schemaVersion: 2 } },
    { selection: { ...selection, modelSource: "invented" } },
    { selection: { ...selection, reasoningEffortSource: ["preference"] } },
    { selection: { ...selection, configurationGeneration: "short" } },
    { selection: { ...selection, catalogGeneration: "short" } },
    { reasoningEffort: "" },
    { reasoningEffort: "x".repeat(65) },
    { reasoningEffort: "high\n" },
    { reasoningEffort: null },
    { selection: { ...selection, modelSource: "unknown" } },
  ])("refuses malformed selection metadata instead of silently dropping it: %j", patch => {
    const original = selected();
    expect(() => parseBot({ ...original, resolvedConfiguration: { ...original.resolvedConfiguration, ...patch } }, owner)).toThrow();
  });

  it("requires the new selection and effort fields together", () => {
    const original = selected();
    const { reasoningEffort: _effort, ...withoutEffort } = original.resolvedConfiguration;
    const { selection: _selection, ...withoutSelection } = original.resolvedConfiguration;
    expect(() => parseBot({ ...original, resolvedConfiguration: withoutEffort }, owner)).toThrow();
    expect(() => parseBot({ ...original, resolvedConfiguration: withoutSelection }, owner)).toThrow();
  });
});

describe("Native effort transport", () => {
  it.each(["codex", "claude", "copilot"] as const)("preserves dynamically reported %s efforts for native validation", provider => {
    const normalized = normalizeWorkerNative({ agent: provider, model: "native-model", args: ["--effort", "older"] }, "web", { agentReasoningEffort: "native-new-level" }, true, true);
    expect(normalized.native.args).toEqual(["--effort", "native-new-level"]);
    expect(parseProviderArguments(provider, normalized.native.args, true).effort).toBe("native-new-level");
    expect(() => assertNativeModelSelection(provider, { model: "native-model", effort: "native-new-level" }, { model: "native-model", effort: "native-new-level", models: [{ id: "native-model", efforts: ["native-new-level"] }] })).not.toThrow();
    expect(() => parseProviderArguments(provider, normalized.native.args)).toThrow(/Unsupported/);
    expect(() => assertNativeModelSelection(provider, { model: "native-model", effort: "native-new-level" }, { model: "native-model", models: [{ id: "native-model", efforts: ["low"] }] })).toThrow(/support/);
  });
  it("maps Copilot none through both native launch modes", () => {
    expect(normalizeWorkerNative({ agent: "copilot", model: "m", args: [] }, "web", { agentReasoningEffort: "none" }).native.args).toEqual(["--effort", "none"]);
    expect(normalizeWorkerNative({ agent: "copilot", model: "m", args: [] }, "herdr", { agentReasoningEffort: "none" }).native.args).toEqual(["--reasoning-effort", "none"]);
  });
});
