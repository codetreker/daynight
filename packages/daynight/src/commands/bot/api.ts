import { createHash } from "node:crypto";
import path from "node:path";
import { array, fields, id, malformed, text, timestamp } from "../../api/validation.js";

export type BotOverrides = { readonly workerId?: string; readonly cwd?: string; readonly provider?: "codex" | "claude" | "copilot" };
export type BotResult = { readonly state: "pending" | "ready" | "failed"; readonly code: string | null };
export type CleanupResult = { readonly state: "pending" | "completed" | "failed"; readonly code: string | null };
export type BotDeletion = { readonly deletionId: string; readonly requestedVersion: string; readonly workerCleanup: CleanupResult; readonly serverCleanup: CleanupResult };
type BotIdentity = { readonly id: string; readonly workerId: string; readonly version: string };
export type ActiveBot = BotIdentity & {
  readonly deletion: null; readonly ownerUserId: string; readonly name: string; readonly creationOrder: string;
  readonly requestedOverrides: BotOverrides;
  readonly resolvedConfiguration: { readonly workerId: string; readonly cwd: string; readonly provider: "codex" | "claude" | "copilot"; readonly model: string | null; readonly args: readonly string[] };
  readonly roleConfiguration: { readonly instructions: string; readonly revision: string; readonly digest: string } | null;
  readonly sessionId: string | null; readonly testExecutionId: string | null;
  readonly startupResult: BotResult; readonly createdAt: string; readonly updatedAt: string;
};
export type Bot = ActiveBot | (BotIdentity & { readonly deletion: BotDeletion });
export type CreateBotInput = { readonly id: string; readonly name: string; readonly overrides?: BotOverrides };
export type DeleteBotInput = { readonly ifVersion: string; readonly deletionId: string };
export const botVersion = (value: unknown): string => {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) return malformed();
  return value;
};
export const botName = (value: unknown): string => {
  const name = text(value).replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
  if (/\p{Cc}/u.test(text(value)) || [...name].length < 1 || [...name].length > 40) return malformed();
  return name;
};
export const botCwd = (value: unknown): string => {
  const cwd = text(value, true);
  if (/\p{Cc}/u.test(cwd) || !(path.posix.isAbsolute(cwd) || /^[A-Za-z]:[\\/]/.test(cwd) || /^\\\\[^\\]+\\[^\\]+/.test(cwd))) return malformed();
  return cwd;
};
export const botProvider = (value: unknown): "codex" | "claude" | "copilot" => value === "codex" || value === "claude" || value === "copilot" ? value : malformed();
const nullableText = (value: unknown): string | null => value === null ? null : text(value, true);
const result = <T extends string>(value: unknown, states: readonly T[]): { state: T; code: string | null } => {
  const data = fields(value, ["state", "code"]);
  if (typeof data.state !== "string" || !states.includes(data.state as T)) return malformed();
  const code = nullableText(data.code);
  if ((data.state === "failed") !== (code !== null)) return malformed();
  return { state: data.state as T, code };
};
export const parseBot = (value: unknown, expectedId?: string, ownerId?: string): Bot => {
  const data = fields(value, ["id", "workerId", "version", "deletion", "ownerUserId", "name", "creationOrder", "requestedOverrides", "resolvedConfiguration", "roleConfiguration", "sessionId", "testExecutionId", "startupResult", "createdAt", "updatedAt"]);
  const identity = { id: id(data.id), workerId: id(data.workerId), version: botVersion(data.version) };
  if (expectedId !== undefined && identity.id !== expectedId) return malformed();
  if (data.deletion !== null) {
    fields(value, ["id", "workerId", "version", "deletion"]);
    const deletion = fields(data.deletion, ["deletionId", "requestedVersion", "workerCleanup", "serverCleanup"]);
    const parsed: BotDeletion = { deletionId: id(deletion.deletionId), requestedVersion: botVersion(deletion.requestedVersion), workerCleanup: result(deletion.workerCleanup, ["pending", "completed", "failed"]), serverCleanup: result(deletion.serverCleanup, ["pending", "completed", "failed"]) };
    if (BigInt(parsed.requestedVersion) >= BigInt(identity.version)) return malformed();
    return { ...identity, deletion: parsed };
  }
  const overrides = fields(data.requestedOverrides, ["workerId", "cwd", "provider"]);
  const requestedOverrides: BotOverrides = { ...(overrides.workerId === undefined ? {} : { workerId: id(overrides.workerId) }), ...(overrides.cwd === undefined ? {} : { cwd: botCwd(overrides.cwd) }), ...(overrides.provider === undefined ? {} : { provider: botProvider(overrides.provider) }) };
  const config = fields(data.resolvedConfiguration, ["workerId", "cwd", "provider", "model", "args"]);
  const resolvedConfiguration = { workerId: id(config.workerId), cwd: botCwd(config.cwd), provider: botProvider(config.provider), model: nullableText(config.model), args: array(config.args, (item) => text(item)) };
  if (resolvedConfiguration.workerId !== identity.workerId || requestedOverrides.workerId !== undefined && requestedOverrides.workerId !== identity.workerId || requestedOverrides.cwd !== undefined && requestedOverrides.cwd !== resolvedConfiguration.cwd || requestedOverrides.provider !== undefined && requestedOverrides.provider !== resolvedConfiguration.provider) return malformed();
  let roleConfiguration: ActiveBot["roleConfiguration"] = null;
  if (data.roleConfiguration !== null) {
    const role = fields(data.roleConfiguration, ["instructions", "revision", "digest"]);
    roleConfiguration = { instructions: text(role.instructions, true), revision: text(role.revision, true), digest: text(role.digest, true) };
    if (Buffer.byteLength(roleConfiguration.instructions) > 65_536 || createHash("sha256").update(roleConfiguration.instructions).digest("hex") !== roleConfiguration.digest) return malformed();
  }
  const parsed: ActiveBot = { ...identity, deletion: null, ownerUserId: id(data.ownerUserId), name: botName(data.name), creationOrder: botVersion(data.creationOrder), requestedOverrides, resolvedConfiguration, roleConfiguration, sessionId: data.sessionId === null ? null : id(data.sessionId), testExecutionId: data.testExecutionId === null ? null : id(data.testExecutionId), startupResult: result(data.startupResult, ["pending", "ready", "failed"]), createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt) };
  if (parsed.name !== data.name || ownerId !== undefined && parsed.ownerUserId !== ownerId || (parsed.sessionId === null) !== (parsed.testExecutionId === null) || (parsed.sessionId === null) !== (parsed.roleConfiguration === null) || parsed.startupResult.state === "ready" && parsed.sessionId === null) return malformed();
  return parsed;
};
export const deletionState = (deletion: BotDeletion): "pending" | "completed" | "failed" => {
  if (deletion.workerCleanup.state === "failed" || deletion.serverCleanup.state === "failed") return "failed";
  return deletion.workerCleanup.state === "completed" && deletion.serverCleanup.state === "completed" ? "completed" : "pending";
};
