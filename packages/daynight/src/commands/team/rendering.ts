import { stringifyApiJson } from "../../api/json.js";
import type { Team, TeamMemberWithProfile } from "../../api/types.js";
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

export const renderTeamMembers = (members: readonly TeamMemberWithProfile[]): string => members.length === 0 ? "No members.\n" : members.map((member) => [
  `User ID: ${terminalText(member.userId)}`,
  `Name: ${member.profile.name === null ? "(none)" : terminalText(member.profile.name)}`,
  `Email: ${member.profile.email === null ? "(none)" : terminalText(member.profile.email)}`,
  `Avatar: ${member.profile.avatarUrl === null ? "(none)" : terminalText(member.profile.avatarUrl)}`,
  `Role: ${member.role}`,
  `Version: ${member.version}`,
  `Joined: ${terminalText(member.createdAt)}`,
  `Updated: ${terminalText(member.updatedAt)}`,
  "",
].join("\n")).join("\n");
