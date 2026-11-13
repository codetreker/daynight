import type { CopilotSession } from "@github/copilot-sdk";
import { ProviderControls, controlDeadline, controlError, uniqueOptions, type SessionSetting } from "./controls.js";
import { record, string, NativeRpcError } from "./native-rpc.js";
import { assertNativeModelSelection, type NativeModelSelection } from "./native-selection.js";
import { IMAGE_LIMITS, type InputMime, type ProviderImageCapabilities } from "../../../session/image-values.js";
import { unknownCopilotGeometry, type CopilotImageProfile } from "./copilot-image-profile.js";
export class CopilotControls {
  readonly store: ProviderControls;
  private toolApproval: string | null = null;
  private pending = new Map<string, { model: string; resolve(): void; reject(error: Error): void }>();
  private pollTimer: ReturnType<typeof setInterval> | undefined; private polling = false; private closed = false;
  private capabilityModels: Record<string, unknown>[] = [];
  private currentModel: string | null = null;
  private unconfirmed = false;
  private unsettled: { id: string; value: string } | null = null;
  constructor(private readonly native: CopilotSession, changed: () => void, private readonly confirmed?: (operationId: string) => void, revisionFloor = "0", private readonly skillDiscoveryError: string | null = null, private readonly assertNativeDispatch?: () => void) { this.store = new ProviderControls(changed, revisionFloor); }
  imageCapabilities(profile: CopilotImageProfile | null, sessionId: string | null): Omit<ProviderImageCapabilities, "revision"> {
    const matches = this.capabilityModels.filter(item => item.id === this.currentModel), model = matches.length === 1 ? matches[0] : undefined;
    const vision = record(record(model?.capabilities).supports).vision, limits = record(record(record(model?.capabilities).limits).vision);
    const mime = limits.supported_media_types;
    const valid = Array.isArray(mime) && mime.every(value => typeof value === "string" && value.length > 0) && new Set(mime).size === mime.length && Number.isSafeInteger(limits.max_prompt_images) && Number(limits.max_prompt_images) > 0 && Number.isSafeInteger(limits.max_prompt_image_size) && Number(limits.max_prompt_image_size) > 0;
    const media = valid ? ["image/png", "image/jpeg", "image/webp"].filter(type => (mime as string[]).includes(type)) as InputMime[] : [];
    const stable = !this.closed && !this.unconfirmed && this.pending.size === 0 && this.store.value.settingsError === null;
    const geometry = profile?.geometry ?? unknownCopilotGeometry;
    const send = !profile || !sessionId || !stable || !model || typeof vision !== "boolean" ? "unknown" : !vision ? "unsupported" : !valid ? "unknown" : !media.length ? "unsupported" : geometry.known ? "supported" : "unknown";
    return { expectedNativeSessionId: sessionId, modelId: this.currentModel, controlsRevision: this.store.value.revision, send, steer: send === "unsupported" ? "unsupported" : "unknown",
      reasonCode: !profile ? "profile_disabled" : send === "unsupported" ? "model_unsupported" : "capability_unknown",
      inputMediaTypes: send === "supported" ? media : [], maxImageBytes: String(valid ? Math.min(Number(limits.max_prompt_image_size), IMAGE_LIMITS.imageBytes) : IMAGE_LIMITS.imageBytes), maxMessageImageBytes: String(IMAGE_LIMITS.messageBytes), maxImagesPerMessage: valid ? Math.min(Number(limits.max_prompt_images), IMAGE_LIMITS.images) : IMAGE_LIMITS.images,
      geometry };
  }
  invalidateImages(): void { this.unconfirmed = true; }
  private permissions(): SessionSetting { return { id: "tool_approval", category: "permission", label: "Tool approvals", value: this.toolApproval, mutable: typeof this.native.rpc.permissions.setApproveAll === "function", scope: "session", description: "Native tool approval policy. Existing grants, path and network permissions are independent.", options: [{ value: "ask", label: "Ask for approval" }, { value: "allow", label: "Allow tools" }] }; }
  async initialize(resume: boolean, unattended = false) {
    if (!resume && unattended) {
      if (typeof this.native.rpc.permissions.configure !== "function") throw new Error("Native Copilot cannot configure unattended full access.");
      this.assertNativeDispatch?.();
      // SDK sessions have independent path and URL managers; runtime flags and
      // setApproveAll alone do not authorize access outside the task worktree.
      const result = await controlDeadline(this.native.rpc.permissions.configure({ approveAllToolPermissionRequests: true, approveAllReadPermissionRequests: true, paths: { unrestricted: true }, urls: { unrestricted: true } }), "Copilot full access initialization");
      if (!result.success) throw new Error("Copilot did not confirm unattended full access.");
      this.toolApproval = "allow";
    } else if (!resume && typeof this.native.rpc.permissions.setApproveAll === "function") {
      this.assertNativeDispatch?.();
      try { const result = await controlDeadline(this.native.rpc.permissions.setApproveAll({ enabled: false }), "Copilot permission initialization"); if (!result.success) throw new Error("Copilot did not confirm default tool permissions."); this.toolApproval = "ask"; }
      catch (error) { this.store.update({ settingsError: controlError(error) }); }
    }
    if (!resume && unattended && this.toolApproval !== "allow") throw new Error("Native Copilot cannot confirm unattended tool permissions.");
    await this.refresh();
  }
  async validateSelection(requested: NativeModelSelection): Promise<void> {
    const [current, listing] = await Promise.all([controlDeadline(this.native.rpc.model.getCurrent(), "Copilot current model"), controlDeadline(this.native.rpc.model.list(), "Copilot models")]);
    if (!Array.isArray(listing.list) || listing.list.length > 500) throw new Error("Invalid Copilot native model catalog.");
    assertNativeModelSelection("Copilot", requested, { model: current.modelId ?? null, effort: current.reasoningEffort ?? null, models: listing.list.map(value => {
      const item = record(value), levels = item.supportedReasoningEfforts ?? record(record(item.capabilities).supports).reasoning_effort;
      return { id: string(item.id), efforts: Array.isArray(levels) ? levels.filter((value): value is string => typeof value === "string") : null };
    }) });
  }
  async refresh(includeCommands = true) {
    try {
      const [current, listing] = await Promise.all([controlDeadline(this.native.rpc.model.getCurrent(), "Copilot current model"), controlDeadline(this.native.rpc.model.list(), "Copilot models")]);
      if (this.closed) return;
      if (!Array.isArray(listing.list) || listing.list.length > 500) throw new Error("Invalid Copilot model catalog.");
      const models = listing.list.map(record), metadata = models.find(model => model.id === current.modelId), supports = record(record(metadata?.capabilities).supports);
      this.capabilityModels = models; this.currentModel = current.modelId ?? null;
      const levels = metadata?.supportedReasoningEfforts ?? supports.reasoning_effort;
      const settings: SessionSetting[] = [{ id: "model", category: "model", label: "Model", value: current.modelId ?? null, mutable: models.length > 0, scope: "next_turn", description: "Native model switches can remain queued until the current turn finishes.", options: uniqueOptions(models.map(model => ({ value: string(model.id), label: string(model.name) || string(model.id) }))) }, this.permissions()];
      if (Array.isArray(levels) && levels.length) settings.push({ id: "effort", category: "reasoning", label: "Reasoning effort", value: current.reasoningEffort ?? null, mutable: true, scope: "next_turn", description: "Omitted effort follows native defaults. Changes apply to subsequent turns.", options: uniqueOptions(levels.filter(value => typeof value === "string").map(value => ({ value, label: value }))) });
      for (const [id, pending] of this.pending) if (pending.model === current.modelId) { this.pending.delete(id); pending.resolve(); this.confirmed?.(id); }
      if (this.unsettled && (this.unsettled.id === "model" ? current.modelId === this.unsettled.value : this.unsettled.id === "effort" ? current.reasoningEffort === this.unsettled.value : this.toolApproval === this.unsettled.value)) this.unsettled = null;
      if (!this.pending.size && !this.unsettled) this.unconfirmed = false;
      this.store.update({ settings, settingsError: null });
      if (!this.pending.size && this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
    } catch (error) { this.capabilityModels = []; this.currentModel = null; this.unconfirmed = true; if (!this.closed) this.store.update({ settings: [this.permissions()], settingsError: controlError(error) }); }
    if (!includeCommands) return;
    try {
      if (this.skillDiscoveryError) throw new Error(this.skillDiscoveryError);
      await controlDeadline(this.native.rpc.skills.ensureLoaded(), "Copilot skill loading"); const { skills } = await controlDeadline(this.native.rpc.skills.list(), "Copilot skill listing");
      if (this.closed) return;
      const commands = skills.filter(skill => skill.enabled && skill.userInvocable).map(skill => ({ id: skill.name, name: skill.commandName ?? skill.name, description: (skill.description || "Copilot skill").slice(0, 1000), argumentHint: skill.argumentHint?.slice(0, 1000) || null, available: true }));
      if (commands.length > 500) throw new Error("Copilot command directory exceeded its bound."); this.store.update({ commands, commandsError: null });
    } catch (error) { if (!this.closed) this.store.update({ commands: [], commandsError: controlError(error) }); }
  }
  async set(id: string, value: string, operationId: string, revision: string) {
    this.store.setting(id, value, revision); if (this.closed) throw new Error("Native session closed.");
    this.invalidateImages(); this.unsettled = { id, value };
    this.assertNativeDispatch?.();
    if (id === "tool_approval") {
      const operation = this.native.rpc.permissions.setApproveAll({ enabled: value === "allow" }).then(result => { if (!result.success) throw new Error("Copilot did not confirm tool permission update."); if (this.closed) throw new Error("Native session closed."); this.toolApproval = value; this.store.update({ settings: [...this.store.value.settings.filter(item => item.id !== id), this.permissions()] }); this.confirmed?.(operationId); });
      try { await controlDeadline(operation, "Copilot permission update"); } catch (error) { this.toolApproval = null; this.store.update({ settings: [...this.store.value.settings.filter(item => item.id !== id), this.permissions()], settingsError: controlError(error) }); throw error; }
      await this.refresh(false); return;
    }
    if (id === "effort") {
      await controlDeadline(this.native.rpc.model.setReasoningEffort({ reasoningEffort: value }), "Copilot effort update"); await this.refresh(false);
      if (this.store.value.settings.find(item => item.id === id)?.value !== value) throw new Error("Copilot did not confirm applied effort."); this.confirmed?.(operationId); return;
    }
    const response = await controlDeadline(this.native.rpc.model.switchTo({ modelId: value, deferIfModelChangeQueued: true }), "Copilot model update");
    let resolve!: () => void, reject!: (error: Error) => void;
    const confirmation = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; }); void confirmation.catch(() => {}); this.pending.set(operationId, { model: value, resolve, reject });
    await this.refresh(false);
    if (this.pending.has(operationId)) {
      if (!response.deferred) { this.pending.delete(operationId); throw new Error("Copilot model readback did not match the requested model."); }
      this.pollTimer ??= setInterval(() => { if (this.polling || this.closed) return; this.polling = true; void this.refresh(false).finally(() => { this.polling = false; }); }, 1000); this.pollTimer.unref();
    }
    await controlDeadline(confirmation, "Copilot queued model confirmation");
  }
  async invoke(id: string, args: string, revision: string): ReturnType<CopilotSession["rpc"]["commands"]["invoke"]> { const command = this.store.command(id, revision); if (this.closed) throw new NativeRpcError(-32602, "Native session closed."); this.assertNativeDispatch?.(); const result = await controlDeadline(this.native.rpc.commands.invoke({ name: command.name, input: args }), "Copilot command"); if (result.runtimeSettingsChanged) await this.refresh(); return result; }
  close() { this.closed = true; if (this.pollTimer) clearInterval(this.pollTimer); for (const item of this.pending.values()) item.reject(new Error("Native Copilot closed before model confirmation.")); this.pending.clear(); }
}
