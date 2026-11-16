import { createHash } from "node:crypto";
import { canonicalImageJson } from "../../../session/image-values.js";

/** Native-declared configuration only; neither outbound traffic nor qualification evidence. */
export type CopilotRouteObservation = Readonly<{ kind: "native_declared_route_v1"; sessionId: string; modelId: string; backendIdentity: string; generation: number }>;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value;

/** Read only these fields: credentials must not enter serialization, hashing or diagnostics. */
export const declaredCopilotRouteDigest = (endpoint: unknown, modelId: string): string | null => {
  try {
    const { type, wireApi, transport, baseUrl } = object(endpoint);
    if (!text(modelId) || typeof type !== "string" || !["openai", "azure", "anthropic"].includes(type) || typeof wireApi !== "string" || !["responses", "completions"].includes(wireApi) || typeof transport !== "string" || !["http", "websockets"].includes(transport) || typeof baseUrl !== "string" || baseUrl.length > 2048 || baseUrl.trim() !== baseUrl) return null;
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.hostname || /[%\\\s]/.test(baseUrl) || !/^\/[A-Za-z0-9/_-]*$/.test(url.pathname)) return null;
    return createHash("sha256").update(canonicalImageJson({ kind: "native_declared_route_v1", type, wireApi, transport, endpoint: url.href, modelId })).digest("hex");
  } catch { return null; }
};

export const parseCopilotRouteObservation = (value: unknown, sessionId: string): CopilotRouteObservation | null => {
  const row = object(value);
  if (row.kind !== "native_declared_route_v1" || row.sessionId !== sessionId || !text(row.modelId) || typeof row.backendIdentity !== "string" || !/^[a-f0-9]{64}$/.test(row.backendIdentity) || !Number.isSafeInteger(row.generation) || Number(row.generation) < 1) return null;
  return Object.freeze({ kind: "native_declared_route_v1", sessionId, modelId: row.modelId, backendIdentity: row.backendIdentity, generation: Number(row.generation) });
};

/** Generation closes local observation races; native provides no atomic snapshot RPC. */
export class CopilotRouteObserver {
  private generation = 0;
  private current: CopilotRouteObservation | null = null;
  private reading = false;
  invalidate(): void { this.generation++; this.current = null; }
  matches(value: unknown, sessionId: string): boolean {
    const expected = parseCopilotRouteObservation(value, sessionId);
    return !!expected && !!this.current && canonicalImageJson(expected) === canonicalImageJson(this.current);
  }
  async read(session: { sessionId: string; rpc: { model: { getCurrent(): Promise<{ modelId?: string }> }; provider: { getEndpoint(): Promise<unknown> } } }): Promise<CopilotRouteObservation | null> {
    if (this.reading) return null;
    this.reading = true; this.invalidate(); const generation = this.generation;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<CopilotRouteObservation | null> => {
      try {
        const before = await session.rpc.model.getCurrent();
        if (generation !== this.generation || !text(before.modelId)) return null;
        const endpoint = await session.rpc.provider.getEndpoint();
        if (generation !== this.generation) return null;
        const digest = declaredCopilotRouteDigest(endpoint, before.modelId);
        if (!digest) return null;
        const after = await session.rpc.model.getCurrent();
        if (generation !== this.generation || after.modelId !== before.modelId) return null;
        this.current = Object.freeze({ kind: "native_declared_route_v1", sessionId: session.sessionId, modelId: before.modelId, backendIdentity: digest, generation });
        return this.current;
      } catch { return null; } // Native errors may contain endpoint credentials.
    };
    try {
      // The SDK offers no cancellation for this RPC. Retain one pending read
      // after timeout instead of accumulating native waiters on each refresh.
      const pending = read().finally(() => { this.reading = false; });
      return await Promise.race([pending, new Promise<null>(resolve => { timer = setTimeout(() => { this.invalidate(); resolve(null); }, 5000); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
