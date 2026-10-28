import type { Query, PermissionMode, Options } from "@anthropic-ai/claude-agent-sdk";
import { ProviderControls, controlDeadline, controlError, uniqueOptions, type SessionSetting } from "./controls.js";
import { record, string, NativeRpcError } from "./native-rpc.js";
export type ClaudeControlQuery = Pick<Query, "setModel" | "setPermissionMode" | "supportedModels" | "supportedCommands" | "reloadSkills" | "applyFlagSettings"> & { getSettings?: () => Promise<unknown> };
const modes = ["default", "acceptEdits", "dontAsk", "plan", "bypassPermissions"] as const;
const excluded = new Set(["clear", "context", "debug", "extra-usage", "heapdump", "loop", "schedule", "usage", "cost", "stats", "resume", "fork", "model", "permissions", "login", "logout", "exit", "quit", "agents", "mcp", "config", "settings"]);
export class ClaudeControls {
  readonly store: ProviderControls;
  private closed = false;
  private models: Record<string, unknown>[] = [];
  private model: string | null; private permission: string | null = null; private effort: string | null | undefined;
  private effortDefault: boolean;
  constructor(private readonly native: ClaudeControlQuery, model: string | null, effort: string | undefined, changed: () => void, private readonly confirmed?: (id: string) => void, private readonly resumed = false, revisionFloor = "0") { this.store = new ProviderControls(changed, revisionFloor); this.model = resumed ? null : model ?? "default"; this.effortDefault = effort === undefined; }
  observe(raw: unknown) {
    if (this.closed) return;
    const message = record(raw);
    if (message.type !== "system") return;
    if (typeof message.permissionMode === "string") this.permission = message.permissionMode;
    // Preserve the native default selection instead of replacing it with a resolved alias.
    if (message.subtype === "init" && this.model !== "default" && typeof message.model === "string") this.model = this.catalogModel(message.model);
    this.describe();
  }
  private catalogModel(actual: string): string {
    if (this.models.some(model => model.value === actual)) return actual;
    // Alias matching requires native catalog evidence; a requested alias alone
    // does not establish which model the native runtime actually applied.
    const matches = this.models.filter(model => model.value !== "default" && model.resolvedModel === actual);
    const selected = matches.find(model => model.value === this.model);
    return string(selected?.value) || (matches.length === 1 ? string(matches[0]!.value) : "") || actual;
  }
  private describe(error: string | null = this.store.value.settingsError) {
    if (this.closed) return;
    const settings: SessionSetting[] = [{ id: "model", category: "model", label: "Model", value: this.model, options: uniqueOptions(this.models.map(model => ({ value: string(model.value), label: string(model.displayName) || string(model.value) }))), mutable: this.models.length > 0 && typeof this.native.setModel === "function", scope: "session", description: "Applies to subsequent native requests. Default follows Claude Code." }, { id: "permissions", category: "permission", label: "Permissions", value: this.permission, options: modes.filter(value => value !== "bypassPermissions" || typeof this.native.applyFlagSettings === "function").map(value => ({ value, label: value === "default" ? "Ask for permissions" : value === "acceptEdits" ? "Accept edits" : value === "dontAsk" ? "Deny unapproved tools" : value === "bypassPermissions" ? "Full access (YOLO)" : "Plan" })), mutable: typeof this.native.setPermissionMode === "function", scope: "session", description: "Native permission mode. Full access runs tools without asking and disables the sandbox." }];
    const metadata = this.models.find(model => model.value === this.model || model.resolvedModel === this.model);
    if (metadata?.supportsEffort && Array.isArray(metadata.supportedEffortLevels) && this.effort !== undefined && this.native.getSettings) settings.push({ id: "effort", category: "reasoning", label: "Reasoning effort", value: this.effortDefault ? "default" : this.effort, options: uniqueOptions([{ value: "default", label: "Native default" }, ...metadata.supportedEffortLevels.filter(value => typeof value === "string").map(value => ({ value, label: value }))]), mutable: true, scope: "session", description: "Applies to subsequent native requests. Native default clears the effort override." });
    this.store.update({ settings, settingsError: error });
  }
  private async readSettings() {
    if (!this.native.getSettings) { this.effort = undefined; return; }
    const applied = record(record(await controlDeadline(this.native.getSettings(), "Claude settings readback")).applied);
    if (applied.effort !== null && typeof applied.effort !== "string") throw new Error("Claude did not report applied effort.");
    this.effort = applied.effort; this.effortDefault = applied.effort === null;
    if (this.model !== "default" && typeof applied.model === "string") this.model = this.catalogModel(applied.model);
  }
  async refresh() {
    try { const models: unknown = await controlDeadline(this.native.supportedModels(), "Claude model discovery"); if (!Array.isArray(models) || models.length > 500) throw new Error("Invalid Claude model catalog."); this.models = models.map(record); await this.readSettings(); this.describe(null); }
    catch (error) { this.effort = undefined; this.describe(controlError(error)); }
    try {
      await controlDeadline(this.native.reloadSkills(), "Claude skills refresh"); const entries: unknown = await controlDeadline(this.native.supportedCommands(), "Claude commands");
      if (!Array.isArray(entries) || entries.length > 4096) throw new Error("Invalid Claude command directory.");
      const commands = new Map<string, { id: string; name: string; description: string; argumentHint: string | null; available: boolean }>();
      for (const raw of entries) { const entry = record(raw), name = string(entry.name); if (!name || name.length > 128 || !/^[^\s/]+$/u.test(name) || excluded.has(name)) continue; const id = `claude:${name}`; commands.set(id, { id, name, description: (string(entry.description) || "Claude command").slice(0, 1000), argumentHint: string(entry.argumentHint).slice(0, 1000) || null, available: true }); }
      if (commands.size > 500) throw new Error("Claude command directory exceeded its bound."); this.store.update({ commands: [...commands.values()], commandsError: null });
    } catch (error) { this.store.update({ commands: [], commandsError: controlError(error) }); }
  }
  async set(id: string, value: string, operationId: string, revision: string) {
    this.store.setting(id, value, revision); if (this.closed) throw new Error("Native session closed.");
    const apply = async () => {
      if (id === "model") { await this.native.setModel(value); this.model = value; await this.readSettings(); }
      else if (id === "effort") { await this.native.applyFlagSettings({ effortLevel: value === "default" ? null : value as NonNullable<Options["effort"]> }); this.effortDefault = value === "default"; await this.readSettings(); if (value !== "default" && this.effort !== value) throw new Error("Claude did not apply the requested effort."); }
      else {
        if (value !== "bypassPermissions" && this.native.applyFlagSettings) await this.native.applyFlagSettings({ sandbox: null });
        await this.native.setPermissionMode(value as PermissionMode); this.permission = value; this.describe();
        if (value === "bypassPermissions") await this.native.applyFlagSettings({ sandbox: { enabled: false } });
      }
      if (this.closed) throw new Error("Native session closed before control confirmation.");
      this.describe(null); this.confirmed?.(operationId);
    };
    await controlDeadline(apply(), "Claude setting update");
  }
  close() { this.closed = true; }
  command(id: string, revision: string) { return this.store.command(id, revision); }
}
