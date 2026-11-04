import { stringifyApiJson } from "../../api/json.js";
import type { Team, TeamInvitation } from "../../api/types.js";
import { terminalText } from "../../platform/terminal.js";

export const renderTeam = (team: Team): string => [
  `ID: ${terminalText(team.id)}`,
  `Name: ${team.kind === "personal" ? "Personal" : terminalText(team.name!)}`,
  `Kind: ${team.kind}`,
  `Role: ${team.membership.role}`,
  `Version: ${team.version}`,
  `Created: ${terminalText(team.createdAt)}`,
  `Updated: ${terminalText(team.updatedAt)}`,
  "",
].join("\n");
export const renderTeams = (teams: readonly Team[]): string => teams.length === 0 ? "No teams.\n" : teams.map(renderTeam).join("\n");
export const renderTeamInvitations = (items: readonly TeamInvitation[]): string => items.length === 0 ? "No invitations.\n" : items.map((item) => [
  `ID: ${item.id}`,
  `Team: ${item.teamId}`,
  `Created by: ${item.createdBy}`,
  `Created: ${terminalText(item.createdAt)}`,
  `Expires: ${terminalText(item.expiresAt)}`,
  `Consumed by: ${item.consumedBy ?? "none"}`,
  `Consumed: ${item.consumedAt === null ? "none" : terminalText(item.consumedAt)}`,
  `Revoked: ${item.revokedAt === null ? "none" : terminalText(item.revokedAt)}`,
  "",
].join("\n")).join("\n");
export const renderTeamJson = (value: unknown): string => `${stringifyApiJson(value)}\n`;
