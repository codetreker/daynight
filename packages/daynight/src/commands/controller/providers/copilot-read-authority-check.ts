import { createHash, randomBytes } from "node:crypto";
import { posix } from "node:path";
import { parseLocalImageCheckpoint, type LocalImageCheckpoint } from "../markdown/local-source-proof.js";

export const copilotReadRefused = () => Object.assign(new Error("Native Copilot local Read authority is unavailable."), { code: "source_forbidden" });
const refuse = (): never => { throw copilotReadRefused(); };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : refuse();
const parse = (value: string): Record<string, unknown> => {
  if (typeof value !== "string" || Buffer.byteLength(value) > 1_048_576) return refuse();
  return object(JSON.parse(value));
};
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export type CopilotAuthorityNative = {
  sessionInvokeJson(sessionId: string, method: string, params: string | null): Promise<string>;
  sessionRoutePermissionJson(sessionId: string, params: string): Promise<string>;
  sessionAuthMetadataJson(sessionId: string): string;
  hookSessionSnapshot(sessionId: string): Promise<string>;
  hookProcessorCallbackRegistrations(sessionId: string): unknown;
};

/** Only lexical paths represented by the opener's uninterrupted ordinary chain. */
export function copilotSourcePath(value: unknown, cwd: string): string {
  const { stage, proof } = parseLocalImageCheckpoint(value);
  if (!posix.isAbsolute(cwd) || posix.normalize(cwd) !== cwd || proof.root.cwd !== cwd || proof.root.identity.kind !== "posix" || proof.root.traversal.length) return refuse();
  const requested = proof.requested.path;
  const prefix = cwd === "/" ? "/" : `${cwd}/`;
  const relative = posix.isAbsolute(requested) ? requested.startsWith(prefix) ? requested.slice(prefix.length) : refuse() : requested;
  const parts = relative.split("/");
  if (!parts.length || parts.some(part => !part || part === "." || part === "..")) return refuse();
  if (stage !== "initial") {
    if (proof.traversal.length !== parts.length) return refuse();
    let parent = proof.root.identity;
    for (let i = 0; i < parts.length; i++) {
      const step = proof.traversal[i]!;
      if (step.kind !== "open" || step.name !== parts[i] || !same(step.parent, parent) || step.directory !== (i < parts.length - 1) || step.object.kind !== "posix") return refuse();
      parent = step.object;
    }
    if (!same(parent, proof.opened)) return refuse();
  }
  return `${prefix}${relative}`;
}

async function metadata(native: CopilotAuthorityNative, sessionId: string, cwd: string): Promise<void> {
  const response = parse(await native.sessionInvokeJson(sessionId, "session.metadata.snapshot", null));
  const value = object(response.result);
  if (response.ok !== true || value.sessionId !== sessionId || value.workingDirectory !== cwd || value.isRemote !== false) refuse();
}
async function mode(native: CopilotAuthorityNative, sessionId: string): Promise<void> {
  const envelope = parse(await native.sessionInvokeJson(sessionId, "session.permissions.getMode", null));
  if (envelope.ok !== true || !["manual", "allow-all"].includes(String(object(envelope.result).mode))) refuse();
}
/** This native output is AuthIdentity (credential-free), not AuthInfo ingress. */
export function copilotAuthIdentity(native: CopilotAuthorityNative, sessionId: string): string {
  const value = parse(native.sessionAuthMetadataJson(sessionId));
  const keys = ["type", "host", "login", "envVar", "registrationId", "copilotUser"];
  if (Object.keys(value).some(key => !keys.includes(key)) || typeof value.type !== "string" || typeof value.host !== "string" || !value.host) return refuse();
  if (!["user", "gh-cli", "token", "env", "token-provider"].includes(value.type)) return refuse();
  if (typeof value.login !== "string" || !value.login) return refuse();
  return createHash("sha256").update(JSON.stringify([value.type, value.host, value.login, value.envVar ?? null, value.registrationId ?? null])).digest("hex");
}
export async function bindCopilotRead(native: CopilotAuthorityNative, sessionId: string, cwd: string): Promise<string> {
  await metadata(native, sessionId, cwd);
  // Correlation also reads completed image refusals when the current mode is
  // unsupported. Source admission still checks the live mode at every stage.
  return copilotAuthIdentity(native, sessionId);
}
export async function copilotCorrelationKey(native: CopilotAuthorityNative, sessionId: string): Promise<string> {
  const name = "daynight/local-read-authority-v1";
  const read = async () => {
    const result = parse(await native.sessionInvokeJson(sessionId, "session.metadata.getClientMetadata", null));
    if (result.ok !== true) return refuse();
    return object(result.result)[name];
  };
  const previous = await read();
  if (previous !== undefined) { if (typeof previous !== "string" || !/^[a-f0-9]{64}$/.test(previous)) return refuse(); return previous; }
  const key = randomBytes(32).toString("hex");
  // An uncertain write is never replayed or replaced with a different key.
  try { await native.sessionInvokeJson(sessionId, "session.metadata.updateClientMetadata", JSON.stringify({ set: { [name]: key } })); } catch { /* Read back the original write. */ }
  if (await read() !== key) return refuse();
  return key;
}

/** Pinned to 1.0.105's complete path-policy result; no inode/content inference. */
export async function checkCopilotRead(native: CopilotAuthorityNative, sessionId: string, cwd: string, checkpoint: LocalImageCheckpoint, authIdentity?: string, intention = "Read a local image referenced by this session."): Promise<void> {
  try {
    const path = copilotSourcePath(checkpoint, cwd);
    await metadata(native, sessionId, cwd);
    await mode(native, sessionId);
    if (authIdentity !== undefined && copilotAuthIdentity(native, sessionId) !== authIdentity) refuse();
    const snapshot = parse(await native.hookSessionSnapshot(sessionId));
    if (snapshot.sessionId !== sessionId || snapshot.cwd !== cwd || !Array.isArray(snapshot.hooks) || snapshot.hookCount !== snapshot.hooks.length
      || snapshot.repositoryLoaded !== true || !Array.isArray(snapshot.warnings) || snapshot.warnings.length || !Array.isArray(snapshot.repositoryDiagnostics)) return refuse();
    if (snapshot.repositoryDiagnostics.some(item => { const row = object(item); return row.failed !== false || !Array.isArray(row.warnings) || row.warnings.length || !Array.isArray(row.errors) || row.errors.length; })) refuse();
    for (const item of snapshot.hooks) {
      const hook = object(item), spec = parse(String(hook.specJson));
      // Other events may affect reads. Their original handlers remain installed.
      if (!["sessionStart", "sessionEnd"].includes(String(hook.eventName)) || spec.eventName !== hook.eventName || typeof spec.enabled !== "boolean") refuse();
    }
    const callbacks = native.hookProcessorCallbackRegistrations(sessionId);
    if (!Array.isArray(callbacks) || callbacks.length) refuse();
    const envelope = parse(await native.sessionInvokeJson(sessionId, "session.contentExclusion.checkPaths", JSON.stringify({ paths: [path] })));
    const strict = object(envelope.result);
    if (envelope.ok !== true || strict.available !== true || !Array.isArray(strict.checks) || strict.checks.length !== 1) return refuse();
    const check = object(strict.checks[0]);
    if (check.path !== path || check.excluded !== false) refuse();
    await mode(native, sessionId);
    // This exclusively owned root SDK session has no parent-agent delegate.
    // Its permission service retains the SDK callbacks and managed policy.
    const route = parse(await native.sessionRoutePermissionJson(sessionId, JSON.stringify({ mode: "request", permissionRequest: { kind: "read", path, intention }, conventions: "posix", hookSessionId: sessionId })));
    if (route.route !== "result" || object(route.result).kind !== "approved") refuse();
    await metadata(native, sessionId, cwd);
    if (authIdentity !== undefined && copilotAuthIdentity(native, sessionId) !== authIdentity) refuse();
  } catch { refuse(); }
}
