import type { ProjectRepositoryClassification, ProjectRepositoryPreview, ProjectRepositoryReceipt, ServerError } from "./types.js";
import { parseServerError } from "./parse.js";
import { bool, fields, id, malformed, text } from "./validation.js";

const decimal = (value: unknown): string => {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value) || value.length > 19 || BigInt(value) > 9_223_372_036_854_775_807n) return malformed();
  return value;
};

export const parseProjectRepositoryError = (value: unknown): ServerError => {
  const envelope = fields(value, ["error"]);
  const error = fields(envelope.error, ["code", "message", "requestId", "details"]);
  if (error.details !== undefined) fields(error.details, ["writeOutcome"]);
  return parseServerError(value);
};

export const parseProjectRepositoryPreview = (value: unknown, projectId: string, repoUrl: string): ProjectRepositoryPreview => {
  const data = fields(value, ["projectId", "projectName", "currentRepoUrl", "repoUrl", "repositoryVersion", "ownershipVersion", "classification", "targetGitHubRepositoryId", "unverifiedReason", "bindingsInvalidated"]);
  const classification: ProjectRepositoryClassification = data.classification === "unchanged" || data.classification === "same_repository" || data.classification === "different_repository" || data.classification === "unverified" ? data.classification : malformed();
  const reason = data.unverifiedReason === null || data.unverifiedReason === "unsupported_host" || data.unverifiedReason === "no_verified_repository" || data.unverifiedReason === "no_github_access" || data.unverifiedReason === "provider_unavailable" ? data.unverifiedReason : malformed();
  const preview: ProjectRepositoryPreview = {
    projectId: id(data.projectId), projectName: text(data.projectName, true), currentRepoUrl: text(data.currentRepoUrl), repoUrl: text(data.repoUrl),
    repositoryVersion: decimal(data.repositoryVersion), ownershipVersion: decimal(data.ownershipVersion), classification,
    targetGitHubRepositoryId: data.targetGitHubRepositoryId === null ? null : decimal(data.targetGitHubRepositoryId), unverifiedReason: reason,
    bindingsInvalidated: bool(data.bindingsInvalidated),
  };
  if (preview.projectId !== projectId || preview.repoUrl !== repoUrl || (classification === "unchanged") !== (preview.currentRepoUrl === preview.repoUrl) || (classification === "unverified") !== (reason !== null) || preview.bindingsInvalidated !== (classification === "different_repository" || classification === "unverified") || classification === "unchanged" && preview.targetGitHubRepositoryId !== null) return malformed();
  return preview;
};

export const parseProjectRepositoryReceipt = (value: unknown, projectId: string, preview: ProjectRepositoryPreview): ProjectRepositoryReceipt => {
  const data = fields(value, ["projectId", "repoUrl", "repositoryVersion", "changed", "bindingsInvalidated"]);
  const receipt = { projectId: id(data.projectId), repoUrl: text(data.repoUrl), repositoryVersion: decimal(data.repositoryVersion), changed: bool(data.changed), bindingsInvalidated: bool(data.bindingsInvalidated) };
  const changed = preview.classification !== "unchanged";
  if (receipt.projectId !== projectId || receipt.repoUrl !== preview.repoUrl || receipt.changed !== changed || receipt.bindingsInvalidated !== preview.bindingsInvalidated || BigInt(receipt.repositoryVersion) !== BigInt(preview.repositoryVersion) + (changed ? 1n : 0n)) return malformed();
  return receipt;
};
