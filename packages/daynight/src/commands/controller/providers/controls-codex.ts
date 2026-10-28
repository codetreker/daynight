import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, opendir } from "node:fs/promises";
import { join } from "node:path";
import { ProviderControls, controlDeadline, controlError, uniqueOptions, sameControlValue, type SessionSetting } from "./controls.js";
import { record, string, NativeRpcError, type NativeRpc } from "./native-rpc.js";
type Command = { kind: "compact" } | { kind: "skill"; name: string; path: string } | { kind: "prompt"; body: string };
export class CodexControls {
  readonly store: ProviderControls;
  private native: Record<string, unknown> = {};
  private sandboxPolicies = new Map<string, Record<string, unknown>>();
  private models: Record<string, unknown>[] = [];
  private requirements: Record<string, unknown> | null = null;
  private commands = new Map<string, Command>();
  private pending = new Map<string, { patch: Record<string, unknown>; resolve(): void; reject(error: Error): void }>();
  private closed = false;
  constructor(private readonly rpc: NativeRpc, private readonly session: () => string, private readonly turn: () => string | null, private readonly cwd: string, private readonly home: string, changed: () => void, private readonly confirmed?: (operationId: string) => void, revisionFloor = "0") { this.store = new ProviderControls(changed, revisionFloor); }
  seed(value: unknown) { const raw = record(value); this.observe({ ...raw, ...(raw.sandbox ? { sandboxPolicy: raw.sandbox } : {}), ...(raw.reasoningEffort ? { effort: raw.reasoningEffort } : {}) }); }
  observe(value: unknown) {
    this.native = { ...this.native, ...record(value) }; const sandbox = record(this.native.sandboxPolicy); if (typeof sandbox.type === "string") this.sandboxPolicies.set(sandbox.type, structuredClone(sandbox)); this.describe();
    for (const [id, pending] of this.pending) if (Object.entries(pending.patch).every(([key, value]) => sameControlValue(this.native[key], value))) { this.pending.delete(id); pending.resolve(); this.confirmed?.(id); }
  }
  private describe(error: string | null = this.store.value.settingsError) {
    const model = string(this.native.model) || null, selected = this.models.find(item => item.model === model);
    const efforts = Array.isArray(selected?.supportedReasoningEfforts) ? selected.supportedReasoningEfforts.map(item => string(record(item).reasoningEffort)).filter(Boolean) : [];
    const settings: SessionSetting[] = [{ id: "model", category: "model", label: "Model", value: model, options: uniqueOptions(this.models.map(item => ({ value: string(item.model), label: string(item.displayName) || string(item.model) }))), mutable: this.models.length > 0, scope: "session", description: "Changes subsequent native steps when supported, and future turns." }];
    if (efforts.length) settings.push({ id: "effort", category: "reasoning", label: "Reasoning effort", value: string(this.native.effort) || string(selected?.defaultReasoningEffort) || null, options: uniqueOptions(efforts.map(value => ({ value, label: value }))), mutable: true, scope: "session", description: "The native model defines supported effort levels." });
    const approval = this.native.approvalPolicy, sandbox = record(this.native.sandboxPolicy);
    const allowed = (key: string, value: string) => !Array.isArray(this.requirements?.[key]) || (this.requirements![key] as unknown[]).includes(value);
    settings.push({ id: "approval", category: "permission", label: "Approval policy", value: typeof approval === "string" ? approval : null, options: [{ value: "untrusted", label: "Untrusted" }, { value: "on-request", label: "On request" }, { value: "never", label: "Never ask" }].filter(item => allowed("allowedApprovalPolicies", item.value)), mutable: this.requirements !== null && typeof approval === "string", scope: "next_turn", description: "Approval policy for subsequent turns. Sandbox restrictions remain independent." });
    const modes = { readOnly: "read-only", workspaceWrite: "workspace-write", dangerFullAccess: "danger-full-access" };
    settings.push({ id: "sandbox", category: "permission", label: "Sandbox", value: string(sandbox.type) || null, options: [{ value: "readOnly", label: "Read only" }, { value: "workspaceWrite", label: "Workspace write" }, { value: "dangerFullAccess", label: "Full access" }].filter(item => allowed("allowedSandboxModes", modes[item.value as keyof typeof modes])), mutable: this.requirements !== null && !!sandbox.type, scope: "next_turn", description: "Native sandbox for subsequent turns. Full access removes filesystem and network restrictions." });
    this.store.update({ settings, settingsError: error });
  }
  async refresh() {
    try {
      const models: Record<string, unknown>[] = [], cursors = new Set<string>(); let cursor: string | undefined;
      do {
        const result = record(await controlDeadline(this.rpc.request("model/list", { ...(cursor ? { cursor } : {}) }), "Codex model discovery"));
        if (!Array.isArray(result.data)) throw new Error("Invalid native model catalog.");
        models.push(...result.data.map(record).filter(item => item.hidden !== true && string(item.model)));
        cursor = string(result.nextCursor) || undefined; if (models.length > 500 || cursor && cursors.has(cursor)) throw new Error("Native model catalog exceeded its bound."); if (cursor) cursors.add(cursor);
      } while (cursor);
      this.models = models;
      try { const result = record(await this.rpc.request("configRequirements/read", {})); this.requirements = result.requirements === null ? {} : result.requirements && typeof result.requirements === "object" && !Array.isArray(result.requirements) ? record(result.requirements) : null; }
      catch { this.requirements = null; }
      this.describe(null);
    } catch (error) { this.models = []; this.requirements = null; this.describe(controlError(error)); }
    try {
      const next = new Map<string, Command>([["compact", { kind: "compact" }]]);
      const commands = [{ id: "compact", name: "compact", description: "Compact the current Codex thread", argumentHint: null as string | null, available: true }];
      const result = record(await controlDeadline(this.rpc.request("skills/list", { cwds: [this.cwd], forceReload: true }), "Codex command discovery"));
      if (!Array.isArray(result.data)) throw new Error("Invalid native skill directory.");
      for (const group of result.data.map(record)) for (const raw of Array.isArray(group.skills) ? group.skills : []) {
        const skill = record(raw), name = string(skill.name), path = string(skill.path);
        if (group.cwd !== this.cwd || skill.enabled !== true || !name || !path || next.size >= 450) continue;
        const id = `skill:${createHash("sha256").update(path).digest("hex")}`;
        next.set(id, { kind: "skill", name, path }); commands.push({ id, name, description: (string(skill.description) || "Codex skill").slice(0, 1000), argumentHint: "Instructions for this skill", available: true });
      }
      let directory; try { directory = await opendir(join(this.home, "prompts")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (directory) {
        let count = 0;
        for await (const item of directory) {
          if (++count > 1000) throw new Error("Native prompt directory exceeded its bound.");
          if (!item.isFile() || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}\.md$/.test(item.name) || next.size >= 500) continue;
          const file = await open(join(this.home, "prompts", item.name), constants.O_RDONLY | constants.O_NOFOLLOW);
          try { const stat = await file.stat(); if (!stat.isFile() || stat.size > 262144) continue; const text = await file.readFile("utf8"); if (Buffer.byteLength(text) > 262144) continue;
            const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ""), name = item.name.slice(0, -3), id = `prompt:${name}`;
            next.set(id, { kind: "prompt", body }); commands.push({ id, name: `prompts:${name}`, description: "Custom Codex prompt", argumentHint: "Raw arguments ($ARGUMENTS only)", available: true });
          } finally { await file.close(); }
        }
      }
      this.commands = next; this.store.update({ commands, commandsError: null });
    } catch (error) { this.commands.clear(); this.store.update({ commands: [], commandsError: controlError(error) }); }
  }
  async set(id: string, value: string, operationId: string, revision: string) {
    this.store.setting(id, value, revision); if (this.closed) throw new Error("Native session closed.");
    const patch: Record<string, unknown> = id === "model" ? { model: value } : id === "effort" ? { effort: value } : id === "approval" ? { approvalPolicy: value } : { sandboxPolicy: this.sandbox(value) };
    if (id === "model") { const selected = this.models.find(item => item.model === value), efforts = Array.isArray(selected?.supportedReasoningEfforts) ? selected.supportedReasoningEfforts.map(item => string(record(item).reasoningEffort)) : []; const effort = string(this.native.effort); if (!efforts.includes(effort) && selected?.defaultReasoningEffort) patch.effort = selected.defaultReasoningEffort; }
    const turnId = this.turn(); let liveApplied = false;
    if (turnId && ["model", "effort"].includes(id)) {
      const result = record(await this.rpc.request("turn/settings/update", { threadId: this.session(), turnId, ...patch }));
      if (result.status !== "applied") throw new NativeRpcError(-32602, "Native live model switching is unavailable. Wait for the current turn to finish.");
      liveApplied = true;
    }
    let resolve!: () => void, reject!: (error: Error) => void;
    const confirmation = new Promise<void>((done, fail) => { resolve = done; reject = fail; }); void confirmation.catch(() => {}); this.pending.set(operationId, { patch, resolve, reject });
    try { await this.rpc.request("thread/settings/update", { threadId: this.session(), ...patch }); }
    catch (error) { if (error instanceof NativeRpcError) this.pending.delete(operationId); if (liveApplied) { const message = `Codex applied this setting to the current turn, but future-turn settings are unconfirmed: ${controlError(error)}`; this.store.update({ settingsError: message }); throw new Error(message); } throw error; }
    await controlDeadline(confirmation, "Codex setting confirmation");
  }
  private sandbox(type: string) {
    const saved = this.sandboxPolicies.get(type); if (saved) return saved;
    const old = record(this.native.sandboxPolicy); if (old.type === type) return old;
    if (type === "dangerFullAccess") return { type };
    if (type === "readOnly") return { type, networkAccess: false };
    return { type, writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  }
  command(id: string, revision: string) { this.store.command(id, revision); const command = this.commands.get(id); if (!command) throw new NativeRpcError(-32602, "Command is no longer available."); return command; }
  close() { this.closed = true; for (const item of this.pending.values()) item.reject(new Error("Native Codex closed before setting confirmation.")); this.pending.clear(); }
}
