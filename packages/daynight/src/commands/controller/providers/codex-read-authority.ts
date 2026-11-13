import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseLocalImageCheckpoint, type LocalImageCheckpoint } from "../markdown/local-source-proof.js";
import { record } from "./native-rpc.js";
import type { CodexRpc } from "./codex-rpc.js";
import type { NativeReadPolicy } from "./types.js";

type Request = CodexRpc["request"];
type AuthorityOptions = { cwd: string; request: Request; publish(policy: NativeReadPolicy | null): void; drain?(): Promise<void>; assertNativeDispatch?(): void };
type Startup = { initialized: unknown; remoteControl: unknown; response: unknown; nativeSessionId: string; nativeCwd: string };
type StartedReceipt = { responded: boolean; response: unknown; notified: boolean; notification: unknown };
const forbidden = () => Object.assign(new Error("Native Codex local Read authority is unavailable."), { code: "source_forbidden" });
const exactKeys = (value: unknown, keys: readonly string[]): boolean => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const singleton = (value: unknown, expected: string): boolean => Array.isArray(value) && value.length === 1 && value[0] === expected;
const unrestricted = (sandbox: unknown): boolean => exactKeys(sandbox, ["type"]) && record(sandbox).type === "dangerFullAccess";
const permissionSnapshot = (value: unknown, cwd: string, sandboxKey: string): boolean => {
  const raw = record(value);
  return raw.cwd === cwd && raw.approvalPolicy === "never" && unrestricted(raw[sandboxKey]) && raw.activePermissionProfile === null;
};
const nullableText = (value: unknown): boolean => value === null || typeof value === "string";
const integer = (value: unknown): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const hookEvents = new Set(["preModelRequest", "postModelRequest", "preToolUse", "permissionRequest", "postToolUse", "preCompact", "postCompact", "sessionStart", "sessionEnd", "userPromptSubmit", "subagentStart", "subagentStop", "stop", "interrupt"]);
const hookSources = new Set(["system", "user", "project", "mdm", "sessionFlags", "plugin", "cloudRequirements", "cloudManagedConfig", "legacyManagedConfigFile", "legacyManagedConfigMdm"]);
const hookFields = ["key", "eventName", "handlerType", "matcher", "timeoutSec", "statusMessage", "additionalContextLimit", "sourcePath", "source", "pluginId", "environmentId", "displayOrder", "enabled", "isManaged", "currentHash", "trustStatus"];
const knownHook = (value: unknown): boolean => {
  const hook = record(value), handlerFields = hook.handlerType === "command" ? ["command", "async"] : hook.handlerType === "mcpTool" ? ["server", "tool"] : ["prompt", "agent"].includes(String(hook.handlerType)) ? [] : null;
  if (!handlerFields || !exactKeys(value, [...hookFields, ...handlerFields])) return false;
  if (!["key", "sourcePath", "currentHash"].every(key => typeof hook[key] === "string" && hook[key])
    || !hookEvents.has(String(hook.eventName)) || !hookSources.has(String(hook.source))
    || !["managed", "untrusted", "trusted", "modified"].includes(String(hook.trustStatus))
    || !["matcher", "statusMessage", "pluginId", "environmentId"].every(key => nullableText(hook[key]))
    || !integer(hook.timeoutSec) || !integer(hook.displayOrder) || hook.additionalContextLimit !== null && !integer(hook.additionalContextLimit)
    || typeof hook.enabled !== "boolean" || typeof hook.isManaged !== "boolean") return false;
  return hook.handlerType === "command" ? typeof hook.command === "string" && typeof hook.async === "boolean"
    : hook.handlerType === "mcpTool" ? typeof hook.server === "string" && typeof hook.tool === "string" : true;
};
const hooksPermit = (value: unknown, cwd: string): boolean => {
  const data = record(value).data;
  if (!exactKeys(value, ["data"]) || !Array.isArray(data) || data.length !== 1) return false;
  const entry = record(data[0]);
  return exactKeys(entry, ["cwd", "hooks", "warnings", "errors"]) && entry.cwd === cwd
    && Array.isArray(entry.warnings) && entry.warnings.length === 0 && Array.isArray(entry.errors) && entry.errors.length === 0
    && Array.isArray(entry.hooks) && entry.hooks.every(value => knownHook(value) && !(record(value).enabled && record(value).eventName === "preToolUse"));
};
const readMethods = new Set(["thread/read", "thread/turns/list", "thread/items/list", "model/list", "configRequirements/read", "config/read", "skills/list", "hooks/list", "remoteControl/status/read"]);
const unchangedRequests: Record<string, readonly string[]> = {
  "thread/settings/update": ["threadId", "model", "effort"],
  "turn/settings/update": ["threadId", "turnId", "model", "effort"],
  "turn/start": ["threadId", "clientUserMessageId", "input", "effort"],
  "turn/steer": ["threadId", "expectedTurnId", "clientUserMessageId", "input"],
  "turn/interrupt": ["threadId", "turnId"],
  "thread/compact/start": ["threadId"],
};
const invalidatingNotifications = new Set(["thread/closed", "thread/environment/connected", "thread/environment/disconnected", "error", "configWarning", "item/commandExecution/requestApproval", "item/fileChange/requestApproval"]);

/** Pinned to Codex 0.167.0's local, unrestricted, exclusively owned stdio thread. */
export class CodexReadAuthority {
  private readonly execution = randomUUID();
  private generation = 0;
  private invalid = false;
  private installed = false;
  private policy: NativeReadPolicy | null = null;
  private nativeCwd = "";
  private startedReceipt: StartedReceipt | undefined;
  constructor(private readonly options: AuthorityOptions) { options.publish(null); }

  static supports(initialized: unknown): boolean {
    const userAgent = record(initialized).userAgent;
    return typeof userAgent === "string" && /^daynight\/0\.167\.0 \(/.test(userAgent);
  }

  install(startup: Startup): void {
    if (this.invalid || this.installed) return;
    if (this.startedReceipt && (!this.startedReceipt.responded || this.startedReceipt.response !== startup.response)) { this.invalidate(); return; }
    const remote = record(startup.remoteControl), response = record(startup.response), thread = record(response.thread);
    const environments = thread.environments, environment = Array.isArray(environments) && environments.length === 1 ? record(environments[0]) : {};
    if (!CodexReadAuthority.supports(startup.initialized)
      || remote.status !== "disabled" || remote.environmentId !== null
      || !startup.nativeSessionId || !startup.nativeCwd || thread.id !== startup.nativeSessionId || thread.sessionId !== startup.nativeSessionId || thread.cwd !== startup.nativeCwd
      || !permissionSnapshot(response, startup.nativeCwd, "sandbox") || !singleton(response.runtimeWorkspaceRoots, startup.nativeCwd)
      || !exactKeys(environment, ["environmentId", "cwd", "runtimeWorkspaceRoots"]) || environment.environmentId !== "local"
      || environment.cwd !== startup.nativeCwd || !singleton(environment.runtimeWorkspaceRoots, startup.nativeCwd)) { this.invalidate(); return; }
    this.installed = true;
    this.nativeCwd = startup.nativeCwd;
    const generation = ++this.generation;
    const verify = () => { if (this.invalid || generation !== this.generation) throw forbidden(); };
    const policy: NativeReadPolicy = Object.freeze({ nativeSessionId: startup.nativeSessionId, cwd: this.options.cwd, revision: `codex:0.167.0:${this.execution}:${generation}`, verify,
      authorizeCheckpoint: async (checkpoint: LocalImageCheckpoint) => {
        verify();
        try {
          const checked = parseLocalImageCheckpoint(checkpoint);
          if (checked.proof.root.cwd !== this.options.cwd) throw forbidden();
          // Each response admits only this checkpoint. Plugin/hook refreshes do
          // not create a reusable permission to read the next source block.
          const result = await this.options.request("hooks/list", { threadId: startup.nativeSessionId });
          verify();
          if (!hooksPermit(result, this.nativeCwd)) throw forbidden();
        } catch { this.invalidate(); throw forbidden(); }
      },
    });
    this.policy = policy;
    this.options.publish(policy);
  }

  invalidate(): void {
    if (this.invalid) return;
    this.invalid = true; ++this.generation; this.policy = null; this.startedReceipt = undefined;
    this.options.publish(null);
  }

  async request(method: string, params: unknown, onLateResponse?: Parameters<Request>[2]): Promise<unknown> {
    const allowed = unchangedRequests[method], raw = record(params);
    const unchanged = readMethods.has(method) || allowed && raw.threadId === this.policy?.nativeSessionId && Object.keys(raw).every(key => allowed.includes(key));
    if (this.installed && !unchanged) {
      this.invalidate();
      await this.options.drain?.();
      this.options.assertNativeDispatch?.();
    }
    let started: StartedReceipt | undefined;
    if (method === "thread/start" && !this.installed && !this.invalid) {
      if (this.startedReceipt) this.invalidate();
      else started = this.startedReceipt = { responded: false, response: undefined, notified: false, notification: undefined };
    }
    const pending = onLateResponse ? this.options.request(method, params, onLateResponse) : this.options.request(method, params);
    if (!started) return pending;
    try {
      const response = await pending;
      started.response = response; started.responded = true;
      if (started.notified) this.verifyStartedReceipt(started);
      return response;
    } catch (error) { this.invalidate(); throw error; }
  }

  private verifyStartedReceipt(started: StartedReceipt): void {
    // 0.167.0 emits the response's exact thread snapshot with turns cleared:
    // https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/app-server/src/request_processors/thread_summary.rs#L220-L223
    const expected = { ...record(record(started.response).thread), turns: [] };
    const observed = { ...record(record(started.notification).thread) };
    if (!exactKeys(started.notification, ["thread"]) || !isDeepStrictEqual(observed, expected)) this.invalidate();
  }

  observe(method: string, params: unknown): void {
    if (this.invalid) return;
    const raw = record(params);
    if (method === "remoteControl/status/changed") { if (raw.status !== "disabled") this.invalidate(); return; }
    if (method === "thread/started") {
      const started = this.startedReceipt;
      if (started) {
        if (started.responded && record(raw.thread).id !== record(record(started.response).thread).id) return;
        if (started.notified) { this.invalidate(); return; }
        started.notification = params; started.notified = true;
        if (started.responded) this.verifyStartedReceipt(started);
      } else if (!this.policy || record(raw.thread).id === this.policy.nativeSessionId) this.invalidate();
      return;
    }
    // Identity verification awaits realpath after the startup receipt. A newer
    // native restriction during that await must win over the older receipt.
    if (!this.policy) { if (method === "thread/settings/updated" || invalidatingNotifications.has(method)) this.invalidate(); return; }
    if (typeof raw.threadId === "string" && raw.threadId !== this.policy.nativeSessionId) return;
    if (method === "thread/settings/updated") {
      if (!permissionSnapshot(raw.threadSettings, this.nativeCwd, "sandboxPolicy")) this.invalidate();
    } else if (invalidatingNotifications.has(method)) this.invalidate();
  }
}
