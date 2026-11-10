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
test("the actual default alias resolves through native catalog evidence and survives image capability parsing", async () => {
  const { controls } = await fixture(), capability = controls.imageCapabilities(null, profile, true);
  expect(capability).toMatchObject({ modelId: "claude-sonnet-5-5", send: "supported", steer: "unsupported", maxImageBytes: "3750000", geometry: { known: true, maxWidth: 3000, maxHeight: 3000, maxFrames: 1 } });
  expect(parseProviderImageCapabilities(JSON.parse(JSON.stringify({ revision: "1", ...capability })))).toEqual({ revision: "1", ...capability });
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
  await controls.refresh(); expect(controls.imageCapabilities("session", profile, true).send).toBe("supported"); controls.close();
});
