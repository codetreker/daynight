import { expect, test, vi } from "vitest";
import { ClaudeControls, type ClaudeControlQuery } from "../../../src/commands/controller/providers/controls-claude.js";
import { parseProviderImageCapabilities } from "../../../src/session/image-values.js";
import type { ClaudeRuntimeProfile } from "../../../src/commands/controller/providers/claude-live.js";
import { NativeRpcTimeoutError } from "../../../src/commands/controller/providers/native-rpc.js";

const profile: ClaudeRuntimeProfile = { sdkVersion: "0.3.247", cliVersion: "2.1.247", executable: "/private/sdk/cli.js", backend: "anthropic" };
const fixture = async () => {
  const native = { supportedModels: async () => [{ value: "default", resolvedModel: "claude-sonnet-5-5", displayName: "Default" }, { value: "claude-sonnet-5-5", displayName: "Sonnet" }], supportedCommands: async () => [], reloadSkills: async () => {}, getSettings: vi.fn(async () => ({ applied: { model: null, effort: null } })), setModel: async () => {}, setPermissionMode: async () => {}, applyFlagSettings: async () => {} } as unknown as ClaudeControlQuery;
  const controls = new ClaudeControls(native, null, undefined, () => {}); await controls.refresh(); return { controls, native };
};
const disabled = { send: "unknown", steer: "unsupported", reasonCode: "capability_unknown", inputMediaTypes: [], maxImageBytes: "0", maxMessageImageBytes: "0", maxImagesPerMessage: 0, geometry: { version: 1, known: false, maxWidth: 0, maxHeight: 0, maxPixels: 0, maxFrames: 0 } };
test("the actual default alias resolves through native evidence without qualifying image input", async () => {
  const { controls } = await fixture(), capability = controls.imageCapabilities(null, profile, true);
  expect(capability).toEqual({ expectedNativeSessionId: null, modelId: "claude-sonnet-5-5", controlsRevision: controls.store.value.revision, ...disabled });
  expect(parseProviderImageCapabilities(JSON.parse(JSON.stringify({ revision: "1", ...capability })))).toEqual({ revision: "1", ...capability });
});
test.each(["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"])("native version and model readback do not qualify image input: %s", async modelId => {
  const { controls, native } = await fixture();
  vi.mocked(native.getSettings!).mockResolvedValue({ applied: { model: modelId, effort: null } });
  await controls.refresh();
  expect(controls.imageCapabilities("session", profile, true)).toEqual({ expectedNativeSessionId: "session", modelId, controlsRevision: controls.store.value.revision, ...disabled });
});
test("an unavailable image component preserves model identity and reports its own refusal", async () => {
  const { controls } = await fixture();
  expect(controls.imageCapabilities("session", profile, false)).toEqual({ expectedNativeSessionId: "session", modelId: "claude-sonnet-5-5", controlsRevision: controls.store.value.revision, ...disabled, reasonCode: "component_unsupported" });
});
test.each([{ sdkVersion: "0.3.248" }, { cliVersion: "2.1.319" }, { backend: "unknown" }, { backend: "bedrock" }, { backend: "vertex" }])("unknown runtime or backend tuple stays disabled: %j", async changed => {
  const { controls } = await fixture(), capability = controls.imageCapabilities("session", { ...profile, ...changed } as ClaudeRuntimeProfile, true);
  expect(capability).toMatchObject({ send: "unknown", reasonCode: "capability_unknown", inputMediaTypes: [], geometry: { known: false } });
  expect(parseProviderImageCapabilities({ revision: "1", ...capability }).send).toBe("unknown");
});
test("a failed model readback cannot retain the preceding model's visual capability", async () => {
  const { controls, native } = await fixture(); controls.observe({ type: "system", subtype: "init", model: "claude-sonnet-5-5" });
  vi.mocked(native.getSettings!).mockRejectedValue(new Error("unavailable"));
  await expect(controls.set("model", "claude-sonnet-5-5", "operation", controls.store.value.revision)).rejects.toThrow();
  expect(controls.imageCapabilities("session", profile, true)).toMatchObject({ send: "unknown", geometry: { known: false } });
});

test("a model mutation withdraws image capability before native settlement and keeps it unknown after response loss", async () => {
  const { controls, native } = await fixture(), before = controls.store.value.revision;
  let reject!: (error: Error) => void;
  native.setModel = () => new Promise((_resolve, fail) => { reject = fail; });
  const setting = controls.set("model", "claude-sonnet-5-5", "operation", before); void setting.catch(() => {});
  const pending = controls.imageCapabilities("session", profile, true);
  try {
    expect(pending).toMatchObject({ modelId: null, send: "unknown", geometry: { known: false } }); expect(pending.controlsRevision).not.toBe(before);
    controls.observe({ type: "system", subtype: "init", model: "claude-sonnet-5-5" });
    expect(controls.imageCapabilities("session", profile, true).send).toBe("unknown");
  }
  finally { reject(new NativeRpcTimeoutError("setModel")); await expect(setting).rejects.toThrow("unknown"); }
  expect(controls.imageCapabilities("session", profile, true)).toMatchObject({ modelId: null, send: "unknown", geometry: { known: false } });
  vi.mocked(native.getSettings!).mockResolvedValue({ applied: { model: "claude-sonnet-5-5", effort: null } });
  await controls.refresh(); expect(controls.imageCapabilities("session", profile, true)).toMatchObject({ modelId: "claude-sonnet-5-5", ...disabled }); controls.close();
});
