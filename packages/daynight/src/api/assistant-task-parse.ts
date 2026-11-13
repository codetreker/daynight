import { createHash } from "node:crypto";
import { jsonObjectSources } from "./json-source.js";
import { array, bool, fields, id, malformed, nullableTimestamp, text, timestamp } from "./validation.js";
import type * as T from "./assistant-task-types.js";

export const assistantTaskId = (value: unknown): string => { const result = id(value); return result === "00000000-0000-0000-0000-000000000000" ? malformed() : result; };
export const assistantTaskInteger = (value: unknown, zero = false): string => {
  const result = text(value);
  return /^(0|[1-9][0-9]{0,18})$/.test(result) && (zero || result !== "0") && BigInt(result) <= 9223372036854775807n ? result : malformed();
};
const nullableId = (value: unknown) => value === null ? null : assistantTaskId(value);
const choice = <S extends string>(value: unknown, choices: readonly S[]): S => typeof value === "string" && choices.includes(value as S) ? value as S : malformed();
const jsonNumber = (value: number): number => Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)) ? value : malformed();

// Resource versions are decimal strings in this protocol. Application JSON keys
// named "version" are ordinary JSON data and must never acquire bigint semantics.
export const parseAssistantTaskJson = (source: string): unknown => {
  jsonObjectSources(source);
  return JSON.parse(source, (_key, value: unknown) => typeof value === "number" ? jsonNumber(value) : value);
};
export const stringifyAssistantTaskJson = (value: unknown): string => {
  const result = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") return malformed();
    return typeof item === "number" ? jsonNumber(item) : item;
  });
  return result === undefined ? malformed() : result;
};
const json = (value: unknown, depth = 0): T.JsonValue => {
  if (depth > 64) return malformed();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return text(value);
  if (typeof value === "number") return jsonNumber(value);
  if (Array.isArray(value)) return value.map(v => json(v, depth + 1));
  if (value === undefined || typeof value !== "object") return malformed();
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, json(v, depth + 1)]));
};
const checkScope = (data: Record<string, unknown>, taskId?: string, expectedId?: string) => {
  const scope = assistantTaskId(data.taskId);
  if (taskId !== undefined && scope !== taskId || expectedId !== undefined && assistantTaskId(data.id) !== expectedId) return malformed();
  return scope;
};
const instant = (value: string): string => `${value.slice(0, 19)}.${(value.includes(".") ? value.slice(20, -1) : "").padEnd(9, "0")}Z`;
const claimFields = ["holderBotId", "credentialOperationId", "claimGeneration", "claimState", "claimedAt", "renewedAt", "leaseUntil", "observedAt"];
export const parseAssistantTaskClaim = (value: unknown): T.AssistantTaskClaim => {
  const d = fields(value, claimFields);
  const result = { holderBotId: nullableId(d.holderBotId), credentialOperationId: nullableId(d.credentialOperationId), claimGeneration: assistantTaskInteger(d.claimGeneration, true), claimState: choice(d.claimState, ["unowned", "pending", "active", "expired"] as const), claimedAt: nullableTimestamp(d.claimedAt), renewedAt: nullableTimestamp(d.renewedAt), leaseUntil: nullableTimestamp(d.leaseUntil), observedAt: timestamp(d.observedAt) };
  if (result.holderBotId === null) {
    if (result.claimState !== "unowned" || result.credentialOperationId !== null || result.claimedAt !== null || result.renewedAt !== null || result.leaseUntil !== null) return malformed();
  } else {
    if (result.claimState === "unowned" || result.claimGeneration === "0" || result.claimedAt === null || result.leaseUntil === null) return malformed();
    if (result.claimState === "pending" && (result.credentialOperationId !== null || result.renewedAt !== null) || result.claimState === "active" && result.credentialOperationId === null) return malformed();
    if ((result.claimState === "pending" || result.claimState === "active") && instant(result.leaseUntil) <= instant(result.observedAt)) return malformed();
  }
  return result;
};
export const parseAssistantTask = (value: unknown, expectedId?: string, ownerId?: string): T.AssistantTask => {
  const d = fields(value, ["id", "ownerUserId", "application", "name", "purpose", "scope", "kind", "state", "takeover", "trigger", "version", "manualVersion", "createdAt", "updatedAt", ...claimFields]);
  const state = choice(d.state, ["active", "paused", "deleted"] as const);
  const result = { id: assistantTaskId(d.id), ownerUserId: assistantTaskId(d.ownerUserId), application: text(d.application), name: text(d.name, state !== "deleted"), purpose: text(d.purpose), scope: text(d.scope), kind: choice(d.kind, ["continuous", "once"] as const), state, takeover: choice(d.takeover, ["manual", "auto"] as const), trigger: json(d.trigger), version: assistantTaskInteger(d.version), manualVersion: assistantTaskInteger(d.manualVersion, state === "deleted"), createdAt: timestamp(d.createdAt), updatedAt: timestamp(d.updatedAt), ...parseAssistantTaskClaim(Object.fromEntries(claimFields.map(k => [k, d[k]]))) };
  if (expectedId !== undefined && result.id !== expectedId || ownerId !== undefined && result.ownerUserId !== ownerId) return malformed();
  if (state === "deleted" && (result.name !== "" || result.purpose !== "" || result.scope !== "" || result.trigger !== null || result.manualVersion !== "0" || result.claimState !== "unowned")) return malformed();
  return result;
};
export const parseAssistantTaskClaimResult = (value: unknown, taskId: string, operationId: string, expected: T.AssistantTaskClaimExpectation = {}): T.AssistantTaskClaimResult => {
  const d = fields(value, ["operation", "currentClaim"]), o = fields(d.operation, ["operationId", "kind", "taskId", "actorBotId", "requestFingerprint", "admittedAt", "resultingVersion", "resultingGeneration", "holderBotId", "credentialOperationId", "leaseUntil"]);
  const operation = { operationId: assistantTaskId(o.operationId), kind: choice(o.kind, ["claim", "transfer", "bind", "renew", "release"] as const), taskId: assistantTaskId(o.taskId), actorBotId: nullableId(o.actorBotId), requestFingerprint: text(o.requestFingerprint), admittedAt: timestamp(o.admittedAt), resultingVersion: assistantTaskInteger(o.resultingVersion), resultingGeneration: assistantTaskInteger(o.resultingGeneration), holderBotId: nullableId(o.holderBotId), credentialOperationId: nullableId(o.credentialOperationId), leaseUntil: nullableTimestamp(o.leaseUntil) };
  if (operation.taskId !== taskId || operation.operationId !== operationId || !/^[a-f0-9]{64}$/.test(operation.requestFingerprint) || expected.kind !== undefined && operation.kind !== expected.kind || expected.actorBotId !== undefined && operation.actorBotId !== expected.actorBotId || expected.requestFingerprint !== undefined && operation.requestFingerprint !== expected.requestFingerprint) return malformed();
  if (operation.kind === "release" ? operation.holderBotId !== null || operation.credentialOperationId !== null || operation.leaseUntil !== null : operation.holderBotId === null || operation.leaseUntil === null) return malformed();
  if (operation.kind === "transfer" && operation.credentialOperationId !== null || ["claim", "bind", "renew"].includes(operation.kind) && (operation.actorBotId === null || operation.holderBotId !== operation.actorBotId || operation.credentialOperationId === null)) return malformed();
  if ((operation.kind === "claim" || operation.kind === "bind") && operation.credentialOperationId !== operation.operationId) return malformed();
  const currentClaim = parseAssistantTaskClaim(d.currentClaim);
  if (BigInt(currentClaim.claimGeneration) < BigInt(operation.resultingGeneration) || instant(currentClaim.observedAt) < instant(operation.admittedAt)) return malformed();
  return { operation, currentClaim };
};
export const parseAssistantTaskManual = (value: unknown, taskId: string, version?: string): T.AssistantTaskManual => {
  const d = fields(value, ["taskId", "version", "body", "rules", "source", "proposalId", "createdAt"]);
  const result = { taskId: checkScope(d, taskId), version: assistantTaskInteger(d.version), body: text(d.body, true), rules: json(d.rules), source: choice(d.source, ["initial", "revision", "rollback"]), proposalId: nullableId(d.proposalId), createdAt: timestamp(d.createdAt) };
  if (version !== undefined && result.version !== version) return malformed();
  return result;
};
export const parseAssistantTaskAppendix = (value: unknown, taskId: string, expectedId?: string): T.AssistantTaskAppendix => {
  const d = fields(value, ["id", "taskId", "text", "sourceRecords", "authorBotId", "state", "version", "createdAt", "updatedAt"]);
  const state = choice(d.state, ["active", "edited", "deleted"] as const);
  const result = { id: assistantTaskId(d.id), taskId: checkScope(d, taskId, expectedId), text: text(d.text, state !== "deleted"), sourceRecords: array(d.sourceRecords, assistantTaskId), authorBotId: nullableId(d.authorBotId), state, version: assistantTaskInteger(d.version), createdAt: timestamp(d.createdAt), updatedAt: timestamp(d.updatedAt) };
  if (state === "deleted" && (result.text !== "" || result.sourceRecords.length !== 0)) return malformed();
  return result;
};
export const parseAssistantTaskProposal = (value: unknown, taskId: string, expectedId?: string): T.AssistantTaskProposal => {
  const d = fields(value, ["id", "taskId", "baseVersion", "body", "rules", "reason", "evidenceRecords", "authorBotId", "widens", "status", "decisionNote", "createdAt", "decidedAt"]);
  return { id: assistantTaskId(d.id), taskId: checkScope(d, taskId, expectedId), baseVersion: assistantTaskInteger(d.baseVersion), body: text(d.body, true), rules: json(d.rules), reason: text(d.reason, true), evidenceRecords: array(d.evidenceRecords, assistantTaskId), authorBotId: nullableId(d.authorBotId), widens: bool(d.widens), status: choice(d.status, ["pending", "approved", "edited", "rejected"]), decisionNote: text(d.decisionNote), createdAt: timestamp(d.createdAt), decidedAt: nullableTimestamp(d.decidedAt) };
};
export const parseAssistantTaskItem = (value: unknown, taskId: string, expectedId?: string): T.AssistantTaskItem => {
  const d = fields(value, ["id", "taskId", "key", "episode", "state", "category", "followerBotId", "appState", "version", "createdAt", "updatedAt"]);
  return { id: assistantTaskId(d.id), taskId: checkScope(d, taskId, expectedId), key: text(d.key, true), episode: assistantTaskInteger(d.episode), state: choice(d.state, ["open", "closed"]), category: text(d.category), followerBotId: nullableId(d.followerBotId), appState: json(d.appState), version: assistantTaskInteger(d.version), createdAt: timestamp(d.createdAt), updatedAt: timestamp(d.updatedAt) };
};
export const parseAssistantTaskRecord = (value: unknown, taskId: string, expectedId?: string): T.AssistantTaskRecord => {
  const d = fields(value, ["id", "taskId", "itemId", "author", "authorBotId", "kind", "text", "refs", "createdAt"]);
  return { id: assistantTaskId(d.id), taskId: checkScope(d, taskId, expectedId), itemId: nullableId(d.itemId), author: choice(d.author, ["bot", "system"]), authorBotId: nullableId(d.authorBotId), kind: choice(d.kind, ["fact", "guess", "action", "unknown", "question", "answer", "note"]), text: text(d.text, true), refs: json(d.refs), createdAt: timestamp(d.createdAt) };
};
export const parseAssistantTaskEvent = (value: unknown, taskId?: string, expectedId?: string): T.AssistantTaskEvent => {
  const d = fields(value, ["id", "taskId", "targetBotId", "type", "payload", "state", "attention", "createdAt", "deliveredAt", "seenAt", "ackOperationId"]);
  return { id: assistantTaskId(d.id), taskId: checkScope(d, taskId, expectedId), targetBotId: assistantTaskId(d.targetBotId), type: text(d.type, true), payload: json(d.payload), state: choice(d.state, ["pending", "delivered", "expired"]), attention: bool(d.attention), createdAt: timestamp(d.createdAt), deliveredAt: nullableTimestamp(d.deliveredAt), seenAt: nullableTimestamp(d.seenAt), ackOperationId: nullableId(d.ackOperationId) };
};
export const parseAssistantTaskInquiry = (value: unknown, taskId: string, expectedId?: string): T.AssistantTaskInquiry => {
  const d = fields(value, ["id", "taskId", "itemId", "fromBotId", "toBotId", "answerBotId", "question", "answer", "state", "createdAt", "deadline", "answeredAt"]);
  const result = { id: assistantTaskId(d.id), taskId: checkScope(d, taskId, expectedId), itemId: nullableId(d.itemId), fromBotId: assistantTaskId(d.fromBotId), toBotId: assistantTaskId(d.toBotId), answerBotId: nullableId(d.answerBotId), question: text(d.question, true), answer: text(d.answer), state: choice(d.state, ["open", "answered", "timed_out"] as const), createdAt: timestamp(d.createdAt), deadline: timestamp(d.deadline), answeredAt: nullableTimestamp(d.answeredAt) };
  if ((result.state === "answered") !== (result.answeredAt !== null) || (result.state === "answered") !== (result.answerBotId !== null)) return malformed();
  return result;
};
export const parseAssistantTaskPage = <V>(value: unknown, parse: (value: unknown) => V): T.AssistantTaskPage<V> => {
  const d = fields(value, ["items", "nextCursor", "observedAt"]), items = array(d.items, parse);
  if (items.length > 200) return malformed();
  const keys = items.map(v => { const x = v as { id?: string; version?: string }; return x.id ?? x.version; });
  if (new Set(keys).size !== keys.length) return malformed();
  return { items, nextCursor: d.nextCursor === null ? null : text(d.nextCursor, true), observedAt: timestamp(d.observedAt) };
};
export const assistantTaskClaimFingerprint = (input: T.AssistantTaskClaimInput & { kind: T.AssistantTaskClaimKind; ownerUserId: string; taskId: string; actorBotId: string | null }): string => {
  const { kind } = input;
  let tokenHash: string | null = null;
  if (input.claimToken !== undefined) {
    const bytes = Buffer.from(input.claimToken, "base64url");
    if (bytes.length !== 32 || bytes.toString("base64url") !== input.claimToken) return malformed();
    tokenHash = createHash("sha256").update(bytes).digest("hex");
  }
  return createHash("sha256").update(JSON.stringify(["daynight-assistant-claim/1", choice(kind, ["claim", "transfer", "bind", "renew", "release"]), assistantTaskId(input.ownerUserId), assistantTaskId(input.taskId), assistantTaskId(input.operationId), nullableId(input.actorBotId), input.targetBotId === undefined ? null : assistantTaskId(input.targetBotId), input.ifVersion === undefined ? null : assistantTaskInteger(input.ifVersion), assistantTaskInteger(kind === "renew" ? input.claimGeneration : input.expectedGeneration, kind === "claim" || kind === "transfer"), tokenHash])).digest("hex");
};
