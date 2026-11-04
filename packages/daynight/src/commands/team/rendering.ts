import { stringifyApiJson } from "../../api/json.js";
import type { Team } from "../../api/types.js";
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
export const renderTeamJson = (value: unknown): string => `${stringifyApiJson(value)}\n`;
