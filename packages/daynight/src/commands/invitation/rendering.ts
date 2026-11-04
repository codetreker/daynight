import { stringifyApiJson } from "../../api/json.js";
import type { User, InvitationInspection, InvitationAcceptance } from "../../api/types.js";
import { terminalText } from "../../platform/terminal.js";

export const renderJson = (value: unknown): string => `${stringifyApiJson(value)}\n`;
export const account = (user: User): string => `Account: ${terminalText(user.name ?? "(unnamed)")} (${terminalText(user.email ?? "no email")}, ${user.id})`;
export const renderInspection = (result: InvitationInspection): string => "team" in result
  ? `Team: ${terminalText(result.team.name ?? "Personal")} (${result.team.id})\nMembership: ${result.membership?.role ?? "none"}\n`
  : `Project: ${terminalText(result.projectName)} (${result.projectId})\nDirect grant: ${result.directGrant?.role ?? "none"}\nEffective role: ${result.access?.effectiveRole ?? "none"}\n`;
export const renderAcceptance = (result: InvitationAcceptance): string => "team" in result
  ? `Team: ${terminalText(result.team.name ?? "Personal")} (${result.team.id})\nRole: ${result.membership.role}\nJoined: ${result.joined}\nConsumed: ${result.consumed}\n`
  : `Project: ${result.projectId}\nDirect grant: ${result.directGrant.role}\nEffective role: ${result.access.effectiveRole}\nJoined: ${result.joined}\nConsumed: ${result.consumed}\n`;
