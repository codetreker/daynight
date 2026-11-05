import { stringifyApiJson } from "../../api/json.js";
import type { Project, ProjectTransferReceipt } from "../../api/types.js";
import { terminalText } from "../../platform/terminal.js";

export const renderProject = (project: Project): string => [
  `ID: ${terminalText(project.id)}`,
  `Name: ${terminalText(project.name)}`,
  `Repository: ${terminalText(project.repoUrl)}`,
  `Created: ${terminalText(project.createdAt)}`,
  `Updated: ${terminalText(project.updatedAt)}`,
  "",
].join("\n");

export const renderProjectList = (projects: readonly Project[]): string => {
  if (projects.length === 0) return "No projects.\n";
  return projects.map(renderProject).join("\n");
};

export const renderProjectJson = (value: Project | readonly Project[]): string => `${stringifyApiJson(value)}\n`;

export const renderProjectJsonValue = (value: unknown): string => `${stringifyApiJson(value)}\n`;

export const renderTransferReceipt = (receipt: ProjectTransferReceipt): string => [
  receipt.changed ? "Project transferred." : "Project already belongs to the target Team.",
  `Project: ${receipt.projectId}`,
  `Source Team: ${terminalText(receipt.sourceTeam.kind === "personal" ? "Personal" : JSON.stringify(receipt.sourceTeam.name))} (${receipt.sourceTeam.id})`,
  `Owner Team: ${terminalText(receipt.ownerTeam.kind === "personal" ? "Personal" : JSON.stringify(receipt.ownerTeam.name))} (${receipt.ownerTeam.id})`,
  `Ownership version: ${receipt.ownership.version}`,
  `Your access: ${receipt.actorAccess?.effectiveRole ?? "none"}`,
  "",
].join("\n");
