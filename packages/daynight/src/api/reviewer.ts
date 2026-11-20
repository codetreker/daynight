import { array, bool, fields, id, malformed, nullableTimestamp, text } from "./validation.js";
import { parseWorkerCloudRevision, type WorkerPromptKey, type WorkerPromptResource } from "./worker-configuration.js";
import { remoteIdentity } from "../commands/review/config.js";

export type AssignedPullRequest = { readonly projectId: string; readonly repositoryId: string; readonly repositoryUrl: string; readonly number: number };
export type ReviewerPage = { readonly reviewEnabled: boolean; readonly pullRequests: readonly AssignedPullRequest[]; readonly nextCursor: string | null };
const exact = (value: unknown, names: readonly string[]) => {
  const data = fields(value, names);
  if (names.some(name => !Object.hasOwn(data, name))) return malformed();
  return data;
};
const positive = (value: unknown): string => {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value) || value.length > 19 || BigInt(value) > 9_223_372_036_854_775_807n) return malformed();
  return value;
};
export const parseReviewerPage = (value: unknown): ReviewerPage => {
  const data = exact(value, ["reviewEnabled", "pullRequests", "nextCursor"]);
  const reviewEnabled = bool(data.reviewEnabled);
  const pullRequests = array(data.pullRequests, value => {
    const item = exact(value, ["projectId", "repositoryId", "repositoryUrl", "number"]);
    const repositoryUrl = text(item.repositoryUrl, true);
    try { remoteIdentity(repositoryUrl, "repositoryUrl"); } catch { return malformed(); }
    const number = Number(positive(item.number));
    if (!Number.isSafeInteger(number)) return malformed();
    return { projectId: id(item.projectId), repositoryId: positive(item.repositoryId), repositoryUrl, number };
  });
  const nextCursor = data.nextCursor === null ? null : text(data.nextCursor, true);
  if (pullRequests.length > 100 || !reviewEnabled && (pullRequests.length !== 0 || nextCursor !== null)) return malformed();
  return { reviewEnabled, pullRequests, nextCursor };
};
export const parseReviewerPrompt = (value: unknown, key: WorkerPromptKey, userId: string, workerId: string): WorkerPromptResource => {
  const data = exact(value, ["scope", "scopeId", "revision", "text", "updatedAt"]);
  const scopeId = id(data.scopeId), revision = parseWorkerCloudRevision(data.revision, true);
  const expected = key.scope === "project" ? key.projectId : key.scope === "worker" ? workerId : userId;
  if (data.scope !== key.scope || scopeId !== expected || typeof data.text !== "string" || !data.text.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(data.text) || Buffer.byteLength(data.text) > 32768) return malformed();
  const updatedAt = nullableTimestamp(data.updatedAt);
  if (revision === "0" ? data.text !== "" || updatedAt !== null : updatedAt === null) return malformed();
  return { scope: key.scope, scopeId, revision, text: data.text, updatedAt };
};
