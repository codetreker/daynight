import { afterEach, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ProviderControls } from "../../../src/commands/controller/providers/controls.js";
import { CodexControls } from "../../../src/commands/controller/providers/controls-codex.js";
import { ClaudeControls, type ClaudeControlQuery } from "../../../src/commands/controller/providers/controls-claude.js";
import { CopilotControls } from "../../../src/commands/controller/providers/controls-copilot.js";
import type { NativeRpc } from "../../../src/commands/controller/providers/native-rpc.js";
import type { CopilotSession } from "@github/copilot-sdk";
afterEach(() => vi.useRealTimers());
function codex(floor = "0", guard?: () => void) {
  let turn: string | null = null;
  const request = vi.fn(async (method: string, _params: unknown): Promise<unknown> => {
    if (method === "model/list") return { data: [{ model: "model-a", displayName: "Model A", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], defaultReasoningEffort: "low" }, { model: "model-b", displayName: "Model B", supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "low" }] };
    if (method === "configRequirements/read") return { requirements: { allowedApprovalPolicies: ["on-request", "never"], allowedSandboxModes: ["read-only", "workspace-write"] } };
    if (method === "skills/list") return { data: [{ cwd: "/work", skills: [{ name: "review", path: "/work/.agents/review/SKILL.md", enabled: true, description: "Review code" }] }] };
    if (method === "turn/settings/update") return { status: "applied" };
    return {};
  });
  const confirmed = vi.fn(), controls = new CodexControls({ request } as unknown as NativeRpc, () => "thread", () => turn, "/work", "/does-not-exist", vi.fn(), confirmed, floor, guard);
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
test("Codex startup rejects incompatible effort and a failed native catalog read", async () => {
  const f = codex(); await f.controls.refresh();
  expect(() => f.controls.validateSelection({ model: "model-a", effort: "high" })).not.toThrow();
  expect(() => f.controls.validateSelection({ model: "model-b", effort: "high" })).toThrow("model");
  expect(() => f.controls.validateSelection({ model: null, effort: "medium" })).toThrow("effort");
  f.request.mockRejectedValue(new Error("catalog unavailable")); await f.controls.refresh();
  expect(() => f.controls.validateSelection({ model: "model-a" })).toThrow("catalog");
});
test("Codex validates hidden models across catalog pages while keeping them out of the picker", async () => {
  const f = codex();
  f.controls.seed({ model: "hidden-model", reasoningEffort: "high" });
  f.request.mockImplementation(async (method, params) => {
    if (method !== "model/list") return { data: [] };
    const { cursor, includeHidden } = params as { cursor?: string; includeHidden?: boolean };
    return cursor === undefined ? { data: [{ model: "visible-model", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }], nextCursor: "second" }
      : { data: includeHidden ? [{ model: "hidden-model", hidden: true, supportedReasoningEfforts: [{ reasoningEffort: "high" }] }] : [], nextCursor: null };
  });
  await f.controls.refresh();
  expect(() => f.controls.validateSelection({ model: "hidden-model", effort: "high" })).not.toThrow();
  expect(f.controls.store.value.settings.find(setting => setting.id === "model")?.options.map(option => option.value)).toEqual(["visible-model"]);
  expect(f.request.mock.calls.filter(([method]) => method === "model/list").every(([, params]) => (params as { includeHidden?: boolean }).includeHidden === true)).toBe(true);
  f.request.mockRejectedValue(new Error("catalog unavailable")); await f.controls.refresh();
  expect(() => f.controls.validateSelection({ model: "hidden-model", effort: "high" })).toThrow("catalog");
});
test("Codex counts hidden catalog entries toward its bound", async () => {
  const f = codex(); await f.controls.refresh();
  f.request.mockImplementation(async method => method === "model/list" ? { data: Array.from({ length: 501 }, (_, index) => ({ model: `hidden-${index}`, hidden: true })), nextCursor: null } : { data: [] });
  await f.controls.refresh();
  expect(f.controls.store.value.settingsError).toContain("bound");
  expect(() => f.controls.validateSelection({ model: "model-a" })).toThrow("catalog");
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
test("Codex does not issue future-turn settings after a fence during a live update", async () => {
  const failure = new Error("accounting failure"); let fenced = false, release!: (value: unknown) => void;
  const f = codex("0", () => { if (fenced) throw failure; }); await f.controls.refresh(); f.setTurn("turn");
  f.request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const pending = f.controls.set("model", "model-b", randomUUID(), f.controls.store.value.revision);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  fenced = true; release({ status: "applied" });
  await expect(pending).rejects.toBe(failure);
  expect(f.request.mock.calls.filter(([method]) => method === "turn/settings/update")).toHaveLength(1);
  expect(f.request.mock.calls.some(([method]) => method === "thread/settings/update")).toBe(false);
  expect(f.confirmed).not.toHaveBeenCalled();
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
function claude(floor = "0", resumed = false, guard?: () => void) {
  let model = "native-default", effort: string | null = null;
  const native = { supportedModels: vi.fn(async () => [{ value: "default", displayName: "Default", supportsEffort: true, supportedEffortLevels: ["low", "high"] }, { value: "model-b", displayName: "Model B" }]), supportedCommands: vi.fn(async () => [{ name: "review", description: "Review code" }, { name: "compact", description: "Compact" }, { name: "logout", description: "Logout" }]), reloadSkills: vi.fn(async () => ({})), getSettings: vi.fn(async () => ({ applied: { model, effort } })), setModel: vi.fn(async (value: string) => { model = value; }), setPermissionMode: vi.fn(async () => {}), applyFlagSettings: vi.fn(async (settings: { effortLevel?: string | null }) => { if (settings.effortLevel !== undefined) effort = settings.effortLevel; }) };
  const confirmed = vi.fn(), controls = new ClaudeControls(native as unknown as ClaudeControlQuery, null, undefined, vi.fn(), confirmed, resumed, floor, guard); controls.observe({ type: "system", subtype: "init", model, permissionMode: "default" });
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
test("Claude startup does not accept a downgraded effort or an unobserved model", async () => {
  const f = claude();
  f.native.supportedModels.mockResolvedValue([{ value: "default", resolvedModel: "native-default", supportsEffort: true, supportedEffortLevels: ["low", "high"] }] as never);
  f.native.getSettings.mockResolvedValue({ applied: { model: "native-default", effort: "low" } });
  await f.controls.refresh();
  expect(() => f.controls.validateSelection({ model: null, effort: "high" })).toThrow("apply");
  expect(() => f.controls.validateSelection({ model: null, effort: "low" })).not.toThrow();
  f.native.getSettings.mockRejectedValue(new Error("settings unavailable")); await f.controls.refresh();
  expect(() => f.controls.validateSelection({ model: "default" })).toThrow("unknown");
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
test("Claude does not issue a later permission update after a fence while sandbox change is pending", async () => {
  const failure = new Error("accounting failure"); let fenced = false, release!: () => void;
  const f = claude("0", false, () => { if (fenced) throw failure; }); await f.controls.refresh();
  f.native.applyFlagSettings.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const pending = f.controls.set("permissions", "default", randomUUID(), f.controls.store.value.revision);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  fenced = true; release(); await expect(pending).rejects.toBe(failure);
  expect(f.native.applyFlagSettings).toHaveBeenCalledOnce();
  expect(f.native.setPermissionMode).not.toHaveBeenCalled();
  expect(f.confirmed).not.toHaveBeenCalled();
});
function copilot(floor = "0", guard?: () => void) {
  let modelId = "model-a", effort: string | undefined;
  const rpc = { model: { getCurrent: vi.fn(async () => ({ modelId, reasoningEffort: effort })), list: vi.fn(async () => ({ list: [{ id: "model-a", name: "A", supportedReasoningEfforts: ["low", "high"] }, { id: "model-b", name: "B", supportedReasoningEfforts: ["low"] }] })), switchTo: vi.fn(async () => ({ deferred: true })), setReasoningEffort: vi.fn(async ({ reasoningEffort }: { reasoningEffort: string }) => { effort = reasoningEffort; return { reasoningEffort }; }) }, permissions: { setApproveAll: vi.fn(async () => ({ success: true })) }, skills: { ensureLoaded: vi.fn(async () => ({})), list: vi.fn(async () => ({ skills: [{ name: "review", description: "Review", enabled: true, userInvocable: true }, { name: "hidden", description: "Hidden", enabled: true, userInvocable: false }] })) }, commands: { invoke: vi.fn(async () => ({ kind: "text", text: "native command result" })) } };
  const confirmed = vi.fn(), controls = new CopilotControls({ rpc } as unknown as CopilotSession, vi.fn(), confirmed, floor, null, guard);
  return { controls, rpc, confirmed, applyModel(value: string) { modelId = value; } };
}
test("Copilot restored permission and omitted effort remain unknown instead of guessed defaults", async () => {
  const f = copilot(); await f.controls.initialize(true); expect(f.rpc.permissions.setApproveAll).not.toHaveBeenCalled();
  expect(f.controls.store.value.settings.find(s => s.id === "tool_approval")?.value).toBeNull(); expect(f.controls.store.value.settings.find(s => s.id === "effort")?.value).toBeNull();
  expect(f.controls.store.value.commands.map(c => c.id)).toEqual(["review"]);
});
test("Copilot startup rejects missing readback, unsupported effort and catalog failures", async () => {
  const f = copilot();
  await expect(f.controls.validateSelection({ model: null, effort: "high" })).rejects.toThrow("apply");
  f.rpc.model.getCurrent.mockResolvedValue({ modelId: "model-a", reasoningEffort: "high" });
  await expect(f.controls.validateSelection({ model: "model-a", effort: "high" })).resolves.toBeUndefined();
  f.rpc.model.getCurrent.mockResolvedValue({ modelId: "model-b", reasoningEffort: "high" });
  await expect(f.controls.validateSelection({ model: null, effort: "high" })).rejects.toThrow("support");
  f.rpc.model.list.mockRejectedValue(new Error("catalog unavailable"));
  await expect(f.controls.validateSelection({ model: null })).rejects.toThrow("catalog unavailable");
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
test("Copilot rejects settings and command RPCs after the dispatch fence", async () => {
  const failure = new Error("accounting failure"); let fenced = false;
  const f = copilot("0", () => { if (fenced) throw failure; }); await f.controls.initialize(false);
  f.rpc.permissions.setApproveAll.mockClear(); fenced = true;
  await expect(f.controls.set("tool_approval", "allow", randomUUID(), f.controls.store.value.revision)).rejects.toBe(failure);
  await expect(f.controls.invoke("review", "scope", f.controls.store.value.revision)).rejects.toBe(failure);
  expect(f.rpc.permissions.setApproveAll).not.toHaveBeenCalled(); expect(f.rpc.commands.invoke).not.toHaveBeenCalled();
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
