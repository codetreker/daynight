import { createHash } from "node:crypto";
import type { ResolvedToolLaunch } from "../../../platform/tool-executables.js";
import { canonicalImageJson } from "../../../session/image-values.js";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const name = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._/-]{1,128}$/.test(value);
export type CodexDeclaredConfiguration = Readonly<{ model: string; modelProvider: string; backendIdentity: string }>;
export type CodexConfigObservation = Readonly<{ kind: "native_declared_config_v1"; nativeSessionId: string; model: string; modelProvider: string; backendIdentity: string; generation: number }>;

/** Project only declared routing fields. Headers and credentials never enter the digest. */
export const declaredCodexConfiguration = (response: unknown): CodexDeclaredConfiguration | null => {
  try {
    const config = object(object(response).config), provider = config.model_provider;
    if (!name(provider) || !name(config.model)) return null;
    const selected = object(object(config.model_providers)[provider]);
    const baseUrl = selected.base_url, wireApi = selected.wire_api, supportsWebsockets = selected.supports_websockets;
    if (typeof baseUrl !== "string" || baseUrl.length > 2048 || baseUrl.trim() !== baseUrl || wireApi !== "responses" || supportsWebsockets !== undefined && typeof supportsWebsockets !== "boolean") return null;
    const url = new URL(baseUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || /[%\\\s]/.test(baseUrl) || !/^\/[A-Za-z0-9/_-]*$/.test(url.pathname)) return null;
    const backendIdentity = createHash("sha256").update(canonicalImageJson({ kind: "native_declared_config_v1", modelProvider: provider, endpoint: url.href, wireApi, supportsWebsockets: supportsWebsockets ?? null })).digest("hex");
    return Object.freeze({ model: config.model, modelProvider: provider, backendIdentity });
  } catch { return null; }
};

/**
 * Called only after verifyToolLaunch; fallback and interpreter identities remain unknown.
 * A direct native entry is a Windows .exe or, on macOS, a Mach-O file whose
 * executablePath is already the realpath of a symlinked launcher.
 */
export const codexExecutableDigest = (launch: ResolvedToolLaunch | undefined, commandFile: string, platform: NodeJS.Platform = process.platform): string | null => {
  const nativeEntry = platform === "win32" ? /\.exe$/i.test(commandFile) : platform === "darwin";
  if (!nativeEntry || !launch || launch.tool !== "codex" || launch.context !== "web" || launch.interpreterPath || launch.command.prefixArgs.length || launch.runtimeProfile || commandFile !== launch.executablePath) return null;
  const matches = launch.artifacts.filter(item => ["entry", "runtime"].includes(item.role) && item.realPath === commandFile);
  return matches.length === 1 ? matches[0]!.sha256 : null;
};

const safeStart = (params: unknown, cwd: string): { model?: string } | null => {
  const input = object(params), config = object(input.config);
  if (input.cwd !== cwd || input.threadId !== undefined || input.modelProvider !== undefined || input.model !== undefined && !name(input.model)) return null;
  const allowed = new Set(["features.default_mode_request_user_input", "model_reasoning_effort", "shell_environment_policy.set.PATH", "shell_environment_policy.set.DN_CONFIG_DIR"]);
  if (Object.keys(config).some(key => !allowed.has(key))) return null;
  return typeof input.model === "string" ? { model: input.model } : {};
};

/** A new thread retains its initial route baseline; current global config cannot rebind it. */
export class CodexConfigObserver {
  private generation = 0;
  private pending = false;
  private current: CodexConfigObservation | null = null;
  private baseline: { nativeSessionId: string; modelProvider: string; backendIdentity: string; cwd: string } | null = null;
  private prepared: { configuration: CodexDeclaredConfiguration; model: string; generation: number } | null = null;
  private readonly environmentKnown: boolean;
  constructor(private readonly readConfiguration: () => Promise<unknown>, private readonly cwd: string, environment: NodeJS.ProcessEnv) {
    this.environmentKnown = !Object.keys(environment).some(key => {
      const name = process.platform === "win32" ? key.toUpperCase() : key;
      return ["OPENAI_BASE_URL", "OPENAI_API_BASE"].includes(name) && !!environment[key];
    });
  }
  invalidate(): void { this.generation++; this.current = null; }
  close(): void { this.invalidate(); this.baseline = null; this.prepared = null; }
  matches(observation: CodexConfigObservation | null): boolean { return observation !== null && observation === this.current; }
  private async read(): Promise<CodexDeclaredConfiguration | null> {
    if (!this.environmentKnown || this.pending) return null;
    this.pending = true; const generation = this.generation;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Native RPC cancellation is unavailable. Keep a single pending read after
    // the observation deadline; late raw responses are discarded without logging.
    const pending = (async () => {
      try { const raw = await this.readConfiguration(); return generation === this.generation ? declaredCodexConfiguration(raw) : null; }
      catch { return null; }
      finally { this.pending = false; }
    })();
    try { return await Promise.race([pending, new Promise<null>(resolve => { timer = setTimeout(() => { this.invalidate(); resolve(null); }, 5000); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  async prepare(params: unknown): Promise<void> {
    this.close(); const start = safeStart(params, this.cwd), generation = this.generation;
    if (!start) return;
    const configuration = await this.read();
    if (configuration && generation === this.generation) this.prepared = { configuration, model: start.model ?? configuration.model, generation };
  }
  async bind(nativeSessionId: string, response: unknown): Promise<CodexConfigObservation | null> {
    const prepared = this.prepared, selected = object(response); this.prepared = null;
    if (!prepared || prepared.generation !== this.generation || !nativeSessionId || typeof selected.cwd !== "string" || selected.model !== prepared.model || selected.modelProvider !== prepared.configuration.modelProvider) return null;
    const next = await this.read();
    if (!next || prepared.generation !== this.generation || next.modelProvider !== prepared.configuration.modelProvider || next.backendIdentity !== prepared.configuration.backendIdentity) return null;
    this.baseline = { nativeSessionId, modelProvider: next.modelProvider, backendIdentity: next.backendIdentity, cwd: selected.cwd };
    return this.publish(prepared.model);
  }
  private publish(model: string): CodexConfigObservation {
    const { nativeSessionId, modelProvider, backendIdentity } = this.baseline!;
    this.current = Object.freeze({ kind: "native_declared_config_v1", nativeSessionId, modelProvider, backendIdentity, model, generation: this.generation });
    return this.current;
  }
  async refresh(selection: { model: string | null; modelProvider: string | null; cwd: string | null }): Promise<CodexConfigObservation | null> {
    this.invalidate(); const generation = this.generation, baseline = this.baseline;
    if (!baseline || !name(selection.model) || selection.modelProvider !== baseline.modelProvider || selection.cwd !== baseline.cwd) return null;
    const next = await this.read();
    if (!next || generation !== this.generation || this.baseline !== baseline || next.modelProvider !== baseline.modelProvider || next.backendIdentity !== baseline.backendIdentity) return null;
    return this.publish(selection.model);
  }
}
