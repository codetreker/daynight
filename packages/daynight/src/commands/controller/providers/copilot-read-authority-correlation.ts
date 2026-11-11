import { createHmac, timingSafeEqual } from "node:crypto";

const markerPrefix = "daynight-local-image-read-v1:", receiptPrefix = "daynight-local-image-refusal-v1:";
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const digest = (key: string, value: unknown): string => createHmac("sha256", key).update(JSON.stringify(value)).digest("hex");
const equal = (left: string, right: string): boolean => /^[a-f0-9]{64}$/.test(left) && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
export const copilotReadMarker = (key: string, sessionId: string, execution: string, sequence: number, proofDigest: string, path: string): string => {
  const identity = `${execution}:${sequence}:${proofDigest}`;
  return `${markerPrefix}${identity}:${digest(key, [sessionId, identity, path])}`;
};
type Refusal = { kind: "reject"; feedback?: string };
type Callback = { request: { kind: "read"; path: string; intention: string }; resolve(value: Refusal): void; timer: NodeJS.Timeout };

/** Live requests require issuance; historical refusals also authenticate native ID. */
export class CopilotReadCorrelation {
  private readonly issued = new Map<string, string>();
  private readonly callbacks = new WeakMap<object, Callback>();
  private readonly events = new Map<string, string>();
  private readonly history = new Map<string, string>();
  constructor(private readonly key: string, private readonly sessionId: string) {}
  issue(intention: string, path: string): void { this.issued.set(intention, path); }
  settled(intention: string): void { this.issued.delete(intention); }
  private validRequest(value: unknown): value is Callback["request"] {
    const request = record(value);
    if (request.kind !== "read" || typeof request.path !== "string" || typeof request.intention !== "string" || request.toolCallId !== undefined
      || Object.keys(request).some(key => !["kind", "path", "intention", "resolvedPath", "managedApprovalRequired"].includes(key))) return false;
    const parts = request.intention.slice(markerPrefix.length).split(":");
    if (!request.intention.startsWith(markerPrefix) || parts.length !== 4 || !/^[a-f0-9-]{36}$/.test(parts[0]!) || !/^[1-9][0-9]{0,15}$/.test(parts[1]!) || !/^[a-f0-9]{64}$/.test(parts[2]!)) return false;
    return equal(parts[3]!, digest(this.key, [this.sessionId, parts.slice(0, 3).join(":"), request.path]));
  }
  reject(request: unknown, context: unknown): Promise<Refusal> | undefined {
    if (record(context).sessionId !== this.sessionId || record(context).agentId !== undefined || !this.validRequest(request) || this.issued.get(request.intention) !== request.path || this.callbacks.has(request)) return;
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve({ kind: "reject" }), 1000);
      this.callbacks.set(request, { request, resolve, timer });
    });
  }
  private receipt(request: Callback["request"], requestId: string): string { return `${receiptPrefix}${digest(this.key, [this.sessionId, request.intention, request.path, requestId])}`; }
  prepareHistory(values: readonly unknown[]): void {
    const requests = new Map<string, Callback["request"]>();
    for (const value of values) {
      const event = record(value), data = record(event.data);
      if (event.agentId !== undefined || data.ownerSessionId !== undefined && data.ownerSessionId !== this.sessionId) continue;
      if (event.type === "permission.requested" && typeof data.requestId === "string" && this.validRequest(data.permissionRequest)) requests.set(data.requestId, data.permissionRequest);
      if (event.type !== "permission.completed" || typeof data.requestId !== "string") continue;
      const request = requests.get(data.requestId), result = record(data.result);
      if (request && result.kind === "denied-interactively-by-user" && result.feedback === this.receipt(request, data.requestId)) this.history.set(data.requestId, request.intention);
    }
  }
  suppress(value: unknown, history = false): boolean {
    const event = record(value), data = record(event.data);
    if (event.agentId !== undefined || data.ownerSessionId !== undefined && data.ownerSessionId !== this.sessionId) return false;
    if (typeof data.requestId !== "string" || !data.requestId || data.requestId.length > 256) return false;
    if (history) {
      const marker = this.history.get(data.requestId);
      return marker !== undefined && (event.type === "permission.completed" || event.type === "permission.requested" && this.validRequest(data.permissionRequest) && data.permissionRequest.intention === marker);
    }
    if (event.type === "permission.completed") return this.events.delete(data.requestId);
    if (event.type !== "permission.requested" || data.permissionRequest === null || typeof data.permissionRequest !== "object") return false;
    const callback = this.callbacks.get(data.permissionRequest);
    if (!callback) return false;
    this.callbacks.delete(data.permissionRequest); clearTimeout(callback.timer);
    this.events.set(data.requestId, callback.request.intention);
    callback.resolve({ kind: "reject", feedback: this.receipt(callback.request, data.requestId) });
    return true;
  }
}
