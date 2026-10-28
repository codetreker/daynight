import { afterEach, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ProviderControls } from "../../../src/commands/controller/providers/controls.js";
import { CodexControls } from "../../../src/commands/controller/providers/controls-codex.js";
import { ClaudeControls, type ClaudeControlQuery } from "../../../src/commands/controller/providers/controls-claude.js";
import { CopilotControls } from "../../../src/commands/controller/providers/controls-copilot.js";
import type { NativeRpc } from "../../../src/commands/controller/providers/native-rpc.js";
import type { CopilotSession } from "@github/copilot-sdk";
afterEach(() => vi.useRealTimers());
function codex(floor = "0") {
  let turn: string | null = null;
  const request = vi.fn(async (method: string, _params: unknown): Promise<unknown> => {
    if (method === "model/list") return { data: [{ model: "model-a", displayName: "Model A", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], defaultReasoningEffort: "low" }, { model: "model-b", displayName: "Model B", supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "low" }] };
    if (method === "configRequirements/read") return { requirements: { allowedApprovalPolicies: ["on-request", "never"], allowedSandboxModes: ["read-only", "workspace-write"] } };
    if (method === "skills/list") return { data: [{ cwd: "/work", skills: [{ name: "review", path: "/work/.agents/review/SKILL.md", enabled: true, description: "Review code" }] }] };
    if (method === "turn/settings/update") return { status: "applied" };
    return {};
  });
  const confirmed = vi.fn(), controls = new CodexControls({ request } as unknown as NativeRpc, () => "thread", () => turn, "/work", "/does-not-exist", vi.fn(), confirmed, floor);
  controls.seed({ model: "model-a", reasoningEffort: "high", approvalPolicy: "on-request", sandbox: { type: "workspaceWrite", writableRoots: ["/allowed"], networkAccess: true } });
  return { controls, request, confirmed, setTurn(value: string | null) { turn = value; } };
}
test("Codex catalogs preserve native policy restrictions and revise only changed descriptors", async () => {
  const f = codex(); await f.controls.refresh(); const revision = f.controls.store.value.revision;
  await f.controls.refresh(); expect(f.controls.store.value.revision).toBe(revision);
  expect(f.controls.store.value.settings.find(s => s.id === "sandbox")?.options.map(s => s.value)).toEqual(["readOnly", "workspaceWrite"]);
  expect(f.controls.store.value.commands.map(c => c.name)).toEqual(["compact", "review"]);
  await expect(f.controls.set("model", "model-b", randomUUID(), "1")).rejects.toThrow("changed");
});
test("Codex settings remain unconfirmed until matching native notification, including live model updates", async () => {
  const f = codex(); await f.controls.refresh(); f.setTurn("turn"); const id = randomUUID();
  let done = false; const setting = f.controls.set("model", "model-b", id, f.controls.store.value.revision).then(() => { done = true; });
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith("thread/settings/update", { threadId: "thread", model: "model-b", effort: "low" }));
  expect(done).toBe(false); expect(f.controls.store.value.settings[0]?.value).toBe("model-a");
  f.controls.observe({ model: "model-b", effort: "low" }); await setting;
  expect(f.confirmed).toHaveBeenCalledWith(id); expect(f.request).toHaveBeenCalledWith("turn/settings/update", { threadId: "thread", turnId: "turn", model: "model-b", effort: "low" });
  expect(f.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
});
test("Codex unknown settings time out without replay and accept late native confirmation", async () => {
  vi.useFakeTimers(); const f = codex(); await f.controls.refresh(); const id = randomUUID();
  const pending = f.controls.set("approval", "never", id, f.controls.store.value.revision); const rejected = expect(pending).rejects.toThrow("not confirmed");
  await vi.advanceTimersByTimeAsync(30001); await rejected;
  expect(f.request.mock.calls.filter(([method]) => method === "thread/settings/update")).toHaveLength(1);
  f.controls.observe({ approvalPolicy: "never" }); expect(f.confirmed).toHaveBeenCalledWith(id);
});
test("Codex rejects unavailable live switching before changing future-turn settings", async () => {
  const f = codex(); await f.controls.refresh(); f.setTurn("turn"); f.request.mockImplementationOnce(async () => ({ status: "targetUnavailable" }));
  await expect(f.controls.set("model", "model-b", randomUUID(), f.controls.store.value.revision)).rejects.toThrow("unavailable");
  expect(f.request.mock.calls.some(([method]) => method === "thread/settings/update")).toBe(false);
});
test("Codex remembers exact native sandbox roots and treats equivalent key order as confirmed", async () => {
  const f = codex(); await f.controls.refresh(); let pending = f.controls.set("sandbox", "readOnly", randomUUID(), f.controls.store.value.revision);
  await Promise.resolve(); f.controls.observe({ sandboxPolicy: { networkAccess: false, type: "readOnly" } }); await pending;
  pending = f.controls.set("sandbox", "workspaceWrite", randomUUID(), f.controls.store.value.revision);
  await Promise.resolve(); expect(f.request.mock.calls.at(-1)?.[1]).toEqual({ threadId: "thread", sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/allowed"], networkAccess: true } });
  f.controls.observe({ sandboxPolicy: { networkAccess: true, writableRoots: ["/allowed"], type: "workspaceWrite" } }); await pending;
});
function claude(floor = "0", resumed = false) {
  let model = "native-default", effort: string | null = null;
  const native = { supportedModels: vi.fn(async () => [{ value: "default", displayName: "Default", supportsEffort: true, supportedEffortLevels: ["low", "high"] }, { value: "model-b", displayName: "Model B" }]), supportedCommands: vi.fn(async () => [{ name: "review", description: "Review code" }, { name: "compact", description: "Compact" }, { name: "logout", description: "Logout" }]), reloadSkills: vi.fn(async () => ({})), getSettings: vi.fn(async () => ({ applied: { model, effort } })), setModel: vi.fn(async (value: string) => { model = value; }), setPermissionMode: vi.fn(async () => {}), applyFlagSettings: vi.fn(async (settings: { effortLevel?: string | null }) => { if (settings.effortLevel !== undefined) effort = settings.effortLevel; }) };
  const confirmed = vi.fn(), controls = new ClaudeControls(native as unknown as ClaudeControlQuery, null, undefined, vi.fn(), confirmed, resumed, floor); controls.observe({ type: "system", subtype: "init", model, permissionMode: "default" });
  return { controls, native, confirmed };
}
test("Claude resume describes native applied effort without a launch override", async () => {
  const f = claude("0", true);
  f.native.getSettings.mockResolvedValue({ applied: { model: "default", effort: "high" } });
  await f.controls.refresh();
  expect(f.controls.store.value.settings.find(s => s.id === "effort")?.value).toBe("high");
  expect(f.native.applyFlagSettings).not.toHaveBeenCalled();
  f.native.getSettings.mockResolvedValue({ applied: { model: "default", effort: null } });
  await f.controls.refresh();
  expect(f.controls.store.value.settings.find(s => s.id === "effort")?.value).toBe("default");
});
test("Claude keeps native defaults, filters CLI-only commands, and reads applied effort", async () => {
  const f = claude(); await f.controls.refresh(); expect(f.controls.store.value.settings[0]?.value).toBe("default"); expect(f.controls.store.value.commands.map(c => c.name)).toEqual(["review", "compact"]);
  expect(f.controls.store.value.settings.find(s => s.id === "effort")?.value).toBe("default");
  await f.controls.set("effort", "high", randomUUID(), f.controls.store.value.revision); expect(f.native.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: "high" });
  await f.controls.set("effort", "default", randomUUID(), f.controls.store.value.revision); expect(f.native.applyFlagSettings).toHaveBeenLastCalledWith({ effortLevel: null });
});
test("Claude maps confirmed resolved model IDs to catalog aliases without retaining a mismatched request", async () => {
  const f = claude();
  f.native.supportedModels.mockResolvedValue([
    { value: "default", displayName: "Default", resolvedModel: "claude-sonnet-5" },
    { value: "sonnet", displayName: "Sonnet", resolvedModel: "claude-sonnet-5" },
    { value: "haiku", displayName: "Haiku", resolvedModel: "claude-haiku-5" },
  ] as never);
  await f.controls.refresh();
  f.native.getSettings.mockResolvedValue({ applied: { model: "claude-sonnet-5", effort: null } });
  await f.controls.set("model", "sonnet", randomUUID(), f.controls.store.value.revision);
  expect(f.controls.store.value.settings[0]?.value).toBe("sonnet");
  f.controls.observe({ type: "system", subtype: "init", model: "claude-sonnet-5" });
  expect(f.controls.store.value.settings[0]?.value).toBe("sonnet");
  f.native.getSettings.mockResolvedValue({ applied: { model: "claude-haiku-5", effort: null } });
  await f.controls.set("model", "sonnet", randomUUID(), f.controls.store.value.revision);
  expect(f.controls.store.value.settings[0]?.value).toBe("haiku");
});
test("Claude does not report permissions before native confirmation and applies sandbox in safe order", async () => {
  const f = claude(); await f.controls.refresh(); let confirm!: () => void;
  f.native.setPermissionMode.mockImplementationOnce(() => new Promise<void>(resolve => { confirm = resolve; }));
  const pending = f.controls.set("permissions", "bypassPermissions", randomUUID(), f.controls.store.value.revision);
  await vi.waitFor(() => expect(confirm).toBeTypeOf("function")); expect(f.controls.store.value.settings.find(s => s.id === "permissions")?.value).toBe("default");
  expect(f.native.applyFlagSettings).not.toHaveBeenCalled(); confirm(); await pending;
  expect(f.native.applyFlagSettings).toHaveBeenLastCalledWith({ sandbox: { enabled: false } });
  await f.controls.set("permissions", "default", randomUUID(), f.controls.store.value.revision);
  expect(f.native.applyFlagSettings).toHaveBeenLastCalledWith({ sandbox: null });
});
function copilot(floor = "0") {
  let modelId = "model-a", effort: string | undefined;
  const rpc = { model: { getCurrent: vi.fn(async () => ({ modelId, reasoningEffort: effort })), list: vi.fn(async () => ({ list: [{ id: "model-a", name: "A", supportedReasoningEfforts: ["low", "high"] }, { id: "model-b", name: "B", supportedReasoningEfforts: ["low"] }] })), switchTo: vi.fn(async () => ({ deferred: true })), setReasoningEffort: vi.fn(async ({ reasoningEffort }: { reasoningEffort: string }) => { effort = reasoningEffort; return { reasoningEffort }; }) }, permissions: { setApproveAll: vi.fn(async () => ({ success: true })) }, skills: { ensureLoaded: vi.fn(async () => ({})), list: vi.fn(async () => ({ skills: [{ name: "review", description: "Review", enabled: true, userInvocable: true }, { name: "hidden", description: "Hidden", enabled: true, userInvocable: false }] })) }, commands: { invoke: vi.fn(async () => ({ kind: "text", text: "native command result" })) } };
  const confirmed = vi.fn(), controls = new CopilotControls({ rpc } as unknown as CopilotSession, vi.fn(), confirmed, floor);
  return { controls, rpc, confirmed, applyModel(value: string) { modelId = value; } };
}
test("Copilot restored permission and omitted effort remain unknown instead of guessed defaults", async () => {
  const f = copilot(); await f.controls.initialize(true); expect(f.rpc.permissions.setApproveAll).not.toHaveBeenCalled();
  expect(f.controls.store.value.settings.find(s => s.id === "tool_approval")?.value).toBeNull(); expect(f.controls.store.value.settings.find(s => s.id === "effort")?.value).toBeNull();
  expect(f.controls.store.value.commands.map(c => c.id)).toEqual(["review"]);
});
test("Copilot deferred model selection retains actual value and confirms only after native readback", async () => {
  vi.useFakeTimers(); const f = copilot(); await f.controls.initialize(false); const id = randomUUID(); let done = false;
  const pending = f.controls.set("model", "model-b", id, f.controls.store.value.revision).then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(1); expect(done).toBe(false); expect(f.controls.store.value.settings[0]?.value).toBe("model-a");
  f.applyModel("model-b"); await vi.advanceTimersByTimeAsync(1000); await pending;
  expect(f.confirmed).toHaveBeenCalledWith(id); expect(f.rpc.model.switchTo).toHaveBeenCalledOnce(); f.controls.close();
});
test("Copilot permission rejection leaves an unknown value and commands use native invocation", async () => {
  const f = copilot(); await f.controls.initialize(false); f.rpc.permissions.setApproveAll.mockResolvedValueOnce({ success: false });
  await expect(f.controls.set("tool_approval", "allow", randomUUID(), f.controls.store.value.revision)).rejects.toThrow("confirm");
  expect(f.controls.store.value.settings.find(s => s.id === "tool_approval")?.value).toBeNull();
  await f.controls.invoke("review", "scope", f.controls.store.value.revision); expect(f.rpc.commands.invoke).toHaveBeenCalledWith({ name: "review", input: "scope" });
});

test("Codex partial live update remains unknown and reports the applied current-turn effect", async () => {
  const f = codex(); await f.controls.refresh(); f.setTurn("turn");
  const { NativeRpcError } = await import("../../../src/commands/controller/providers/native-rpc.js");
  f.request.mockImplementation(async method => { if (method === "turn/settings/update") return { status: "applied" }; throw new NativeRpcError(-32602, "Future turn policy rejected"); });
  const rejected = f.controls.set("model", "model-b", randomUUID(), f.controls.store.value.revision);
  await expect(rejected).rejects.not.toBeInstanceOf(NativeRpcError);
  expect(f.controls.store.value.settingsError).toContain("current turn"); expect(f.confirmed).not.toHaveBeenCalled();
});
test("Copilot disposal observes rejection while deferred model readback remains in flight", async () => {
  const f = copilot(); await f.controls.initialize(false); let resolve!: (value: { modelId: string; reasoningEffort: undefined }) => void;
  f.rpc.model.getCurrent.mockImplementationOnce(() => new Promise(ok => { resolve = ok; }));
  const pending = f.controls.set("model", "model-b", randomUUID(), f.controls.store.value.revision); const rejected = expect(pending).rejects.toThrow("closed");
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function")); f.controls.close();
  await new Promise(ok => setTimeout(ok, 0)); resolve({ modelId: "model-a", reasoningEffort: undefined }); await rejected;
});


test.each(["codex", "claude", "copilot"] as const)("%s controls start above the persisted revision floor without integer rounding", async provider => {
  const floor = "9007199254740993", f = provider === "codex" ? codex(floor) : provider === "claude" ? claude(floor) : copilot(floor);
  expect(BigInt(f.controls.store.value.revision)).toBeGreaterThan(BigInt(floor));
  await f.controls.refresh();
  expect(BigInt(f.controls.store.value.revision)).toBeGreaterThan(BigInt(floor));
  expect(() => f.controls.store.requireRevision(floor)).toThrow("changed");
  f.controls.close();
});
test("control revision floors reject malformed and exhausted native counters", () => {
  expect(new ProviderControls(vi.fn()).value.revision).toBe("1");
  for (const floor of ["-1", "01", "not-a-number", "9223372036854775807"]) expect(() => new ProviderControls(vi.fn(), floor)).toThrow();
});
