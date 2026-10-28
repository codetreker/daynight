import type { CopilotSession } from "@github/copilot-sdk";
import { ProviderControls, controlDeadline, controlError, uniqueOptions, type SessionSetting } from "./controls.js";
import { record, string, NativeRpcError } from "./native-rpc.js";
export class CopilotControls {
  readonly store: ProviderControls;
  private toolApproval: string | null = null;
  private pending = new Map<string, { model: string; resolve(): void; reject(error: Error): void }>();
  private pollTimer: ReturnType<typeof setInterval> | undefined; private polling = false; private closed = false;
  constructor(private readonly native: CopilotSession, changed: () => void, private readonly confirmed?: (operationId: string) => void, revisionFloor = "0", private readonly skillDiscoveryError: string | null = null) { this.store = new ProviderControls(changed, revisionFloor); }
  private permissions(): SessionSetting { return { id: "tool_approval", category: "permission", label: "Tool approvals", value: this.toolApproval, mutable: typeof this.native.rpc.permissions.setApproveAll === "function", scope: "session", description: "Native tool approval policy. Existing grants, path and network permissions are independent.", options: [{ value: "ask", label: "Ask for approval" }, { value: "allow", label: "Allow tools" }] }; }
  async initialize(resume: boolean, unattended = false) {
    if (!resume && typeof this.native.rpc.permissions.setApproveAll === "function") {
      try { const result = await controlDeadline(this.native.rpc.permissions.setApproveAll({ enabled: unattended }), "Copilot permission initialization"); if (!result.success) throw new Error("Copilot did not confirm default tool permissions."); this.toolApproval = unattended ? "allow" : "ask"; }
      catch (error) { this.store.update({ settingsError: controlError(error) }); if (unattended) throw error; }
    }
    if (!resume && unattended && this.toolApproval !== "allow") throw new Error("Native Copilot cannot confirm unattended tool permissions.");
    await this.refresh();
  }
  async refresh(includeCommands = true) {
    try {
      const [current, listing] = await Promise.all([controlDeadline(this.native.rpc.model.getCurrent(), "Copilot current model"), controlDeadline(this.native.rpc.model.list(), "Copilot models")]);
      if (this.closed) return;
      if (!Array.isArray(listing.list) || listing.list.length > 500) throw new Error("Invalid Copilot model catalog.");
      const models = listing.list.map(record), metadata = models.find(model => model.id === current.modelId), supports = record(record(metadata?.capabilities).supports);
      const levels = metadata?.supportedReasoningEfforts ?? supports.reasoning_effort;
      const settings: SessionSetting[] = [{ id: "model", category: "model", label: "Model", value: current.modelId ?? null, mutable: models.length > 0, scope: "next_turn", description: "Native model switches can remain queued until the current turn finishes.", options: uniqueOptions(models.map(model => ({ value: string(model.id), label: string(model.name) || string(model.id) }))) }, this.permissions()];
      if (Array.isArray(levels) && levels.length) settings.push({ id: "effort", category: "reasoning", label: "Reasoning effort", value: current.reasoningEffort ?? null, mutable: true, scope: "next_turn", description: "Omitted effort follows native defaults. Changes apply to subsequent turns.", options: uniqueOptions(levels.filter(value => typeof value === "string").map(value => ({ value, label: value }))) });
      this.store.update({ settings, settingsError: null });
      for (const [id, pending] of this.pending) if (pending.model === current.modelId) { this.pending.delete(id); pending.resolve(); this.confirmed?.(id); }
      if (!this.pending.size && this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
    } catch (error) { if (!this.closed) this.store.update({ settings: [this.permissions()], settingsError: controlError(error) }); }
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
    if (id === "tool_approval") {
      const operation = this.native.rpc.permissions.setApproveAll({ enabled: value === "allow" }).then(result => { if (!result.success) throw new Error("Copilot did not confirm tool permission update."); if (this.closed) throw new Error("Native session closed."); this.toolApproval = value; this.store.update({ settings: [...this.store.value.settings.filter(item => item.id !== id), this.permissions()] }); this.confirmed?.(operationId); });
      try { await controlDeadline(operation, "Copilot permission update"); } catch (error) { this.toolApproval = null; this.store.update({ settings: [...this.store.value.settings.filter(item => item.id !== id), this.permissions()], settingsError: controlError(error) }); throw error; }
      return;
    }
    if (id === "effort") {
      await controlDeadline(this.native.rpc.model.setReasoningEffort({ reasoningEffort: value }), "Copilot effort update"); await this.refresh();
      if (this.store.value.settings.find(item => item.id === id)?.value !== value) throw new Error("Copilot did not confirm applied effort."); this.confirmed?.(operationId); return;
    }
    const response = await controlDeadline(this.native.rpc.model.switchTo({ modelId: value, deferIfModelChangeQueued: true }), "Copilot model update");
    let resolve!: () => void, reject!: (error: Error) => void;
    const confirmation = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; }); void confirmation.catch(() => {}); this.pending.set(operationId, { model: value, resolve, reject });
    await this.refresh();
    if (this.pending.has(operationId)) {
      if (!response.deferred) { this.pending.delete(operationId); throw new Error("Copilot model readback did not match the requested model."); }
      this.pollTimer ??= setInterval(() => { if (this.polling || this.closed) return; this.polling = true; void this.refresh(false).finally(() => { this.polling = false; }); }, 1000); this.pollTimer.unref();
    }
    await controlDeadline(confirmation, "Copilot queued model confirmation");
  }
  async invoke(id: string, args: string, revision: string): ReturnType<CopilotSession["rpc"]["commands"]["invoke"]> { const command = this.store.command(id, revision); if (this.closed) throw new NativeRpcError(-32602, "Native session closed."); const result = await controlDeadline(this.native.rpc.commands.invoke({ name: command.name, input: args }), "Copilot command"); if (result.runtimeSettingsChanged) await this.refresh(); return result; }
  close() { this.closed = true; if (this.pollTimer) clearInterval(this.pollTimer); for (const item of this.pending.values()) item.reject(new Error("Native Copilot closed before model confirmation.")); this.pending.clear(); }
}
