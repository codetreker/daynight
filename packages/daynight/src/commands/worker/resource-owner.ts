import { canonicalId } from "../../api/parse.js";
import type { ResourceOwner } from "./types.js";

const fields = ["projectId", "taskId", "claimId", "worktreeId"] as const;
const identifier = (value: string, field: string): string => {
  const normalized = canonicalId(value);
  if (normalized === null) throw new TypeError(`Resource ${field} must be a UUID.`);
  return normalized;
};

export const canonicalResourceOwner = (owner: ResourceOwner): ResourceOwner => ({
  projectId: identifier(owner.projectId, "projectId"),
  taskId: identifier(owner.taskId, "taskId"),
  claimId: identifier(owner.claimId, "claimId"),
  worktreeId: identifier(owner.worktreeId, "worktreeId"),
});
export const resourceOwnerKey = (owner: ResourceOwner): string => JSON.stringify(canonicalResourceOwner(owner));
export const sameResourceOwner = (left: ResourceOwner, right: ResourceOwner): boolean => fields.every((field) => left[field] === right[field]);
export const parseResourceOwner = (serialized: string): ResourceOwner => {
  const value: unknown = JSON.parse(serialized);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("The resource identity must be an object.");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== fields.length || fields.some((field) => typeof data[field] !== "string")) throw new TypeError("The resource identity must contain exactly projectId, taskId, claimId and worktreeId.");
  const owner = canonicalResourceOwner(data as ResourceOwner);
  if (JSON.stringify(owner) !== serialized) throw new TypeError("The resource identity must use canonical UUIDs, field order and JSON encoding.");
  return owner;
};
