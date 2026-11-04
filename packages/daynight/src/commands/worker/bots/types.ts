import path from "node:path";
import { createHash } from "node:crypto";
import { canonicalId } from "../../../api/parse.js";
import { normalizeServerUrl } from "../../../config/server.js";
import type { WorkerAgent } from "../../../api/types.js";

export type BotOwner = { serverOrigin: string; ownerUserId: string; workerId: string };
export type BotConfiguration = { workerId: string; cwd: string; provider: WorkerAgent; model: string | null; args: string[] };
export type BotRoleConfiguration = { instructions: string; revision: string; digest: string };
export type BotResult = { state: string; code: string | null };
export type BotDeletion = { deletionId: string; requestedVersion: string; workerCleanup: BotResult; serverCleanup: BotResult };
type BotCommon = { id: string; workerId: string; version: string };
export type BotDefinition = BotCommon & {
  deletion: null; ownerUserId: string; name: string; creationOrder: string;
  requestedOverrides: { workerId?: string; cwd?: string; provider?: WorkerAgent };
  resolvedConfiguration: BotConfiguration; roleConfiguration: BotRoleConfiguration | null;
  sessionId: string | null; testExecutionId: string | null; startupResult: BotResult;
  createdAt: string; updatedAt: string;
};
export type BotDeleted = BotCommon & { deletion: BotDeletion };
export type Bot = BotDefinition | BotDeleted;
export type BotLaunchIntent = {
  botVersion: string;
  registration: { protocol: "daynight.session.v1"; schemaVersion: 1; projectionVersion: 1; registrationId: string; testExecutionId: string; controllerId: string; controllerInstanceId: string; provider: WorkerAgent; initialInput: "none" };
  launchId: string; executionId: string; initialOperationId: string;
  sessionId: string | null; executionGeneration: string; nativeSessionId: string | null;
  ticketPath: string; journalPath: string; credentialFile: string;
  recoveryLimit: number; roleConfiguration: BotRoleConfiguration | null;
};
export type BotRecord = {
  owner: BotOwner; botId: string; observed: Bot; definition: BotDefinition | null;
  observedAt: number; intent: BotLaunchIntent | null;
};

export const botUUID = (value: unknown, field: string): string => {
  if (typeof value !== "string" || canonicalId(value) !== value) throw new TypeError(`${field} must be a canonical UUID.`);
  return value;
};
const object = (value: unknown, field: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${field} must be an object.`);
  return value as Record<string, unknown>;
};
const text = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim() === "" || !value.isWellFormed() || value.includes("\0")) throw new TypeError(`${field} must be nonempty Unicode text.`);
  return value;
};
export const botVersion = (value: unknown): string => {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) throw new TypeError("Bot version must be a positive int64 decimal string.");
  return value;
};
const provider = (value: unknown): WorkerAgent => {
  if (value !== "codex" && value !== "claude" && value !== "copilot") throw new TypeError("Bot provider is invalid.");
  return value;
};
export const parseBotOwner = (value: BotOwner): BotOwner => {
  if (typeof value.serverOrigin !== "string" || normalizeServerUrl(value.serverOrigin) !== value.serverOrigin) throw new TypeError("Bot server origin must be normalized.");
  return { serverOrigin: value.serverOrigin, ownerUserId: botUUID(value.ownerUserId, "Bot owner"), workerId: botUUID(value.workerId, "Bot worker") };
};
export const parseBotRole = (value: unknown): BotRoleConfiguration => {
  const data = object(value, "Bot role");
  const instructions = text(data.instructions, "Bot instructions");
  if (Buffer.byteLength(instructions, "utf8") > 65_536) throw new TypeError("Bot instructions exceed 64 KiB.");
  const revision = text(data.revision, "Bot role revision");
  const digest = createHash("sha256").update(instructions, "utf8").digest("hex");
  if (data.digest !== digest) throw new TypeError("Bot role digest does not match instructions.");
  return { instructions, revision, digest };
};
const result = (value: unknown, states: readonly string[]): BotResult => {
  const data = object(value, "Bot result");
  if (typeof data.state !== "string" || !states.includes(data.state)) throw new TypeError("Bot result state is invalid.");
  return { state: data.state, code: data.code === null ? null : text(data.code, "Bot result code") };
};
/** Parse the public definition or its deletion-only projection without inventing lost fields. */
export const parseBot = (value: unknown, owner: BotOwner): Bot => {
  parseBotOwner(owner);
  const data = object(value, "Bot");
  const common = { id: botUUID(data.id, "Bot ID"), workerId: botUUID(data.workerId, "Bot worker"), version: botVersion(data.version) };
  if (common.workerId !== owner.workerId) throw new Error("Bot worker does not match the inventory owner.");
  if (data.deletion !== null) {
    const deletion = object(data.deletion, "Bot deletion");
    return { ...common, deletion: { deletionId: botUUID(deletion.deletionId, "Bot deletion ID"), requestedVersion: botVersion(deletion.requestedVersion), workerCleanup: result(deletion.workerCleanup, ["pending", "completed", "failed"]), serverCleanup: result(deletion.serverCleanup, ["pending", "completed", "failed"]) } };
  }
  if (data.ownerUserId !== owner.ownerUserId) throw new Error("Bot owner does not match the inventory owner.");
  const config = object(data.resolvedConfiguration, "Bot configuration");
  if (config.workerId !== owner.workerId) throw new Error("Bot configuration worker does not match the inventory owner.");
  const cwd = text(config.cwd, "Bot cwd");
  if (!path.isAbsolute(cwd) || /[\r\n]/.test(cwd)) throw new Error("Bot cwd must be an absolute path.");
  if (!Array.isArray(config.args) || config.args.some(arg => typeof arg !== "string" || !arg.isWellFormed() || /[\0\r\n]/.test(arg))) throw new Error("Bot configuration arguments are invalid.");
  const configuration: BotConfiguration = { workerId: owner.workerId, cwd, provider: provider(config.provider), model: config.model === null ? null : text(config.model, "Bot model"), args: [...config.args] as string[] };
  const overrides = object(data.requestedOverrides, "Bot overrides");
  const requestedOverrides: BotDefinition["requestedOverrides"] = {};
  if (overrides.workerId !== undefined) requestedOverrides.workerId = botUUID(overrides.workerId, "Bot override worker");
  if (overrides.cwd !== undefined) requestedOverrides.cwd = text(overrides.cwd, "Bot override cwd");
  if (overrides.provider !== undefined) requestedOverrides.provider = provider(overrides.provider);
  const sessionId = data.sessionId === null ? null : botUUID(data.sessionId, "Bot session ID");
  const testExecutionId = data.testExecutionId === null ? null : botUUID(data.testExecutionId, "Bot execution ID");
  if ((sessionId === null) !== (testExecutionId === null)) throw new Error("Bot session binding is incomplete.");
  const createdAt = text(data.createdAt, "Bot creation time"), updatedAt = text(data.updatedAt, "Bot update time");
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) throw new Error("Bot timestamps are invalid.");
  return { ...common, deletion: null, ownerUserId: owner.ownerUserId, name: text(data.name, "Bot name"), creationOrder: botVersion(data.creationOrder), requestedOverrides, resolvedConfiguration: configuration, roleConfiguration: data.roleConfiguration === null ? null : parseBotRole(data.roleConfiguration), sessionId, testExecutionId, startupResult: result(data.startupResult, ["pending", "ready", "failed"]), createdAt, updatedAt };
};
