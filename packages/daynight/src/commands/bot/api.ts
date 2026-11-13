import { createHash } from "node:crypto";
import path from "node:path";
import { array, fields, id, malformed, text, timestamp } from "../../api/validation.js";

export type BotOverrides = { readonly workerId?: string; readonly cwd?: string; readonly provider?: "codex" | "claude" | "copilot"; readonly model?: string; readonly reasoningEffort?: string };
export type BotSelectionSource = "explicit" | "preference" | "local" | "cloud" | "native" | "unknown";
export type BotSelection = { readonly schemaVersion: 1; readonly modelSource: BotSelectionSource; readonly reasoningEffortSource: BotSelectionSource; readonly configurationGeneration?: string; readonly catalogGeneration?: string };
export type BotConfiguration = { readonly workerId: string; readonly cwd: string; readonly provider: "codex" | "claude" | "copilot"; readonly model: string | null; readonly args: readonly string[]; readonly reasoningEffort?: string | null; readonly selection?: BotSelection };
export type BotResult = { readonly state: "pending" | "ready" | "failed"; readonly code: string | null };
export type CleanupResult = { readonly state: "pending" | "completed" | "failed"; readonly code: string | null };
export type BotDeletion = { readonly deletionId: string; readonly requestedVersion: string; readonly workerCleanup: CleanupResult; readonly serverCleanup: CleanupResult };
type BotIdentity = { readonly id: string; readonly workerId: string; readonly version: string };
export type ActiveBot = BotIdentity & {
  readonly deletion: null; readonly ownerUserId: string; readonly name: string; readonly creationOrder: string; readonly attentionCount?: number;
  readonly requestedOverrides: BotOverrides;
  readonly resolvedConfiguration: BotConfiguration;
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
export const botNativeChoice = (value: unknown, limit: number): string => {
  const parsed = text(value, true);
  return !/\p{Cc}/u.test(parsed) && Buffer.byteLength(parsed) <= limit ? parsed : malformed();
};
export const botOverrides = (value: unknown): BotOverrides => {
  const data = fields(value, ["workerId", "cwd", "provider", "model", "reasoningEffort"]);
  return { ...(data.workerId === undefined ? {} : { workerId: id(data.workerId) }), ...(data.cwd === undefined ? {} : { cwd: botCwd(data.cwd) }), ...(data.provider === undefined ? {} : { provider: botProvider(data.provider) }), ...(data.model === undefined ? {} : { model: botNativeChoice(data.model, 256) }), ...(data.reasoningEffort === undefined ? {} : { reasoningEffort: botNativeChoice(data.reasoningEffort, 64) }) };
};
const selection = (value: unknown, model: string | null, effort: string | null): BotSelection => {
  const data = fields(value, ["schemaVersion", "modelSource", "reasoningEffortSource", "configurationGeneration", "catalogGeneration"]);
  if (data.schemaVersion !== 1) return malformed();
  const source = (value: unknown, selected: string | null): BotSelectionSource => {
    if (typeof value !== "string" || !["explicit", "preference", "local", "cloud", "native", "unknown"].includes(value) || value === "unknown" && selected !== null || value !== "native" && value !== "unknown" && selected === null) return malformed();
    return value as BotSelectionSource;
  };
  const configurationGeneration = data.configurationGeneration === undefined ? undefined : text(data.configurationGeneration);
  if (configurationGeneration !== undefined && !/^[a-f0-9]{64}$/.test(configurationGeneration)) return malformed();
  return { schemaVersion: 1, modelSource: source(data.modelSource, model), reasoningEffortSource: source(data.reasoningEffortSource, effort), ...(configurationGeneration === undefined ? {} : { configurationGeneration }), ...(data.catalogGeneration === undefined ? {} : { catalogGeneration: id(data.catalogGeneration) }) };
};
const nullableText = (value: unknown): string | null => value === null ? null : text(value, true);
const result = <T extends string>(value: unknown, states: readonly T[]): { state: T; code: string | null } => {
  const data = fields(value, ["state", "code"]);
  if (typeof data.state !== "string" || !states.includes(data.state as T)) return malformed();
  const code = nullableText(data.code);
  if ((data.state === "failed") !== (code !== null)) return malformed();
  return { state: data.state as T, code };
};
export const parseBot = (value: unknown, expectedId?: string, ownerId?: string): Bot => {
  const data = fields(value, ["id", "workerId", "version", "deletion", "ownerUserId", "name", "creationOrder", "attentionCount", "requestedOverrides", "resolvedConfiguration", "roleConfiguration", "sessionId", "testExecutionId", "startupResult", "createdAt", "updatedAt"]);
  const identity = { id: id(data.id), workerId: id(data.workerId), version: botVersion(data.version) };
  if (expectedId !== undefined && identity.id !== expectedId) return malformed();
  if (data.deletion !== null) {
    fields(value, ["id", "workerId", "version", "deletion"]);
    const deletion = fields(data.deletion, ["deletionId", "requestedVersion", "workerCleanup", "serverCleanup"]);
    const parsed: BotDeletion = { deletionId: id(deletion.deletionId), requestedVersion: botVersion(deletion.requestedVersion), workerCleanup: result(deletion.workerCleanup, ["pending", "completed", "failed"]), serverCleanup: result(deletion.serverCleanup, ["pending", "completed", "failed"]) };
    if (BigInt(parsed.requestedVersion) >= BigInt(identity.version)) return malformed();
    return { ...identity, deletion: parsed };
  }
  if (data.attentionCount !== undefined && (typeof data.attentionCount !== "number" || !Number.isSafeInteger(data.attentionCount) || data.attentionCount < 0)) return malformed();
  const requestedOverrides = botOverrides(data.requestedOverrides);
  const config = fields(data.resolvedConfiguration, ["workerId", "cwd", "provider", "model", "args", "reasoningEffort", "selection"]);
  const model = config.model === null ? null : config.selection === undefined ? nullableText(config.model) : botNativeChoice(config.model, 256);
  const reasoningEffort = config.reasoningEffort === undefined ? undefined : config.reasoningEffort === null ? null : botNativeChoice(config.reasoningEffort, 64);
  if ((config.selection === undefined) !== (reasoningEffort === undefined)) return malformed();
  const resolvedConfiguration: BotConfiguration = { workerId: id(config.workerId), cwd: botCwd(config.cwd), provider: botProvider(config.provider), model, args: array(config.args, (item) => text(item)), ...(reasoningEffort === undefined ? {} : { reasoningEffort, selection: selection(config.selection, model, reasoningEffort) }) };
  if (resolvedConfiguration.workerId !== identity.workerId || Object.entries(requestedOverrides).some(([key, value]) => resolvedConfiguration[key as keyof BotOverrides] !== value)) return malformed();
  if (requestedOverrides.model !== undefined && resolvedConfiguration.selection?.modelSource !== "explicit" || requestedOverrides.reasoningEffort !== undefined && resolvedConfiguration.selection?.reasoningEffortSource !== "explicit") return malformed();
  let roleConfiguration: ActiveBot["roleConfiguration"] = null;
  if (data.roleConfiguration !== null) {
    const role = fields(data.roleConfiguration, ["instructions", "revision", "digest"]);
    roleConfiguration = { instructions: text(role.instructions, true), revision: text(role.revision, true), digest: text(role.digest, true) };
    if (Buffer.byteLength(roleConfiguration.instructions) > 65_536 || createHash("sha256").update(roleConfiguration.instructions).digest("hex") !== roleConfiguration.digest) return malformed();
  }
  const parsed: ActiveBot = { ...identity, deletion: null, ownerUserId: id(data.ownerUserId), name: botName(data.name), creationOrder: botVersion(data.creationOrder), ...(data.attentionCount === undefined ? {} : { attentionCount: data.attentionCount as number }), requestedOverrides, resolvedConfiguration, roleConfiguration, sessionId: data.sessionId === null ? null : id(data.sessionId), testExecutionId: data.testExecutionId === null ? null : id(data.testExecutionId), startupResult: result(data.startupResult, ["pending", "ready", "failed"]), createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt) };
  if (parsed.name !== data.name || ownerId !== undefined && parsed.ownerUserId !== ownerId || (parsed.sessionId === null) !== (parsed.testExecutionId === null) || (parsed.sessionId === null) !== (parsed.roleConfiguration === null) || parsed.startupResult.state === "ready" && parsed.sessionId === null) return malformed();
  return parsed;
};
export const deletionState = (deletion: BotDeletion): "pending" | "completed" | "failed" => {
  if (deletion.workerCleanup.state === "failed" || deletion.serverCleanup.state === "failed") return "failed";
  return deletion.workerCleanup.state === "completed" && deletion.serverCleanup.state === "completed" ? "completed" : "pending";
};
