import { array, boolean, id, malformed, nonemptyString, record, string, timestamp } from "./parse";
import { parseTeamRef, parseProjectOwnership } from "./team-parse";
import { parseApiJson } from "./json";
import { jsonContainerSources, jsonObjectSources } from "./json-source";
import type { AuthConfig, AuthProvider, CreatedPersonalAccessToken, CreatedProjectInvitation, CreatedTeamInvitation, DeviceAuthorizationInspection, PersonalAccessToken, ProjectInvitation, ProjectInvitationInspection, ProjectInvitationAcceptance, ProjectMember, ProjectParticipant, ProjectParticipants, ProjectRole, ProjectAccess, ProjectGrant, ProjectGrantResult, RemoveProjectGrantResult, RevokeTeamInvitationResult, User, TeamInvitation, TeamInvitationMember, TeamInvitationInspection, TeamInvitationAcceptance } from "./auth-types";

const nullable = <T>(value: unknown, parse: (value: unknown) => T): T | null => value === null ? null : parse(value);
const unique = <T>(items: T[], key: (item: T) => string): T[] => {
  if (new Set(items.map(key)).size !== items.length) return malformed();
  return items;
};

export const parseRole = (value: unknown): ProjectRole => value === "admin" || value === "member" ? value : malformed();
export const parseMemberVersion = (value: unknown): bigint => {
  if (typeof value !== "bigint" || value < 1n || value > 9_223_372_036_854_775_807n) return malformed();
  return value;
};

export const parseAuthConfig = (value: unknown): AuthConfig => {
  const providers = array(record(value).providers, (provider): AuthProvider => {
    if (provider !== "microsoft" && provider !== "google" && provider !== "github") return malformed();
    return provider;
  });
  return { providers: unique(providers, (provider) => provider) };
};

export const decodeAuthJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  const parsed = parseApiJson(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return parsed;
  const data = parsed as Record<string, unknown>;
  const fields = jsonObjectSources(text);
  // Invitation inspections retain their independently versioned member DTO.
  if (Object.hasOwn(data, 'member')) data.member = parseApiJson(fields.get('member')!);
  return parsed;
};

export const parseUser = (value: unknown): User => {
  const data = record(value);
  if (Object.keys(data).some((key) => !["id", "email", "emailVerified", "name", "avatarUrl", "personalTeam"].includes(key))) return malformed();
  const personalTeam = parseTeamRef(data.personalTeam);
  if (personalTeam.kind !== "personal") return malformed();
  return {
    personalTeam, id: id(data.id), email: nullable(data.email, string), emailVerified: nullable(data.emailVerified, boolean),
    name: nullable(data.name, string), avatarUrl: nullable(data.avatarUrl, string),
  };
};

export const parseToken = (value: unknown): PersonalAccessToken => {
  const data = record(value);
  return { id: id(data.id), name: nonemptyString(data.name), createdAt: timestamp(data.createdAt), expiresAt: nullable(data.expiresAt, timestamp) };
};
export const parseTokens = (value: unknown): PersonalAccessToken[] => unique(array(record(value).items, parseToken), (item) => item.id);
export const parseCreatedToken = (value: unknown): CreatedPersonalAccessToken => {
  const data = record(value);
  const token = string(data.token);
  if (!/^[\x21-\x7e]+$/.test(token)) return malformed();
  return { ...parseToken(data), token };
};

export const parseMember = (value: unknown, projectId?: string, userId?: string): ProjectMember => {
  const data = record(value);
  const member: ProjectMember = {
    projectId: id(data.projectId), userId: id(data.userId), email: nullable(data.email, string),
    name: nullable(data.name, string), avatarUrl: nullable(data.avatarUrl, string), role: parseRole(data.role),
    version: parseMemberVersion(data.version), createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt),
  };
  if ((projectId !== undefined && member.projectId !== projectId) || (userId !== undefined && member.userId !== userId)) return malformed();
  return member;
};
export const parseMembers = (value: unknown, projectId: string, actorUserId?: string): ProjectParticipants => {
  const page = record(value);
  if (Object.keys(page).some((key) => key !== "items" && key !== "actorAccess")) return malformed();
  const actorAccess = parseProjectAccess(page.actorAccess, projectId, actorUserId);
  const items = unique(array(page.items, (value): ProjectParticipant => {
    const data = record(value);
    if (Object.keys(data).some((key) => !["userId", "profile", "effectiveRole", "directGrant", "inheritedFrom"].includes(key))) return malformed();
    const userId = id(data.userId), profile = record(data.profile);
    if (Object.keys(profile).some((key) => !["name", "email", "avatarUrl"].includes(key))) return malformed();
    let inheritedFrom: ProjectParticipant["inheritedFrom"] = null;
    if (data.inheritedFrom !== null) {
      const inherited = record(data.inheritedFrom);
      if (Object.keys(inherited).some((key) => key !== "team" && key !== "role")) return malformed();
      inheritedFrom = { team: parseTeamRef(inherited.team), role: parseRole(inherited.role) };
      if (inheritedFrom.team.id !== actorAccess.ownership.teamId || inheritedFrom.team.kind !== actorAccess.ownerTeam.kind || inheritedFrom.team.name !== actorAccess.ownerTeam.name) return malformed();
    }
    const directGrant = data.directGrant === null ? null : parseProjectGrant(data.directGrant, projectId, userId);
    const effectiveRole = parseRole(data.effectiveRole);
    if (!matchesEffectiveRole(effectiveRole, inheritedFrom?.role ?? null, directGrant?.role ?? null)) return malformed();
    return { userId, profile: { name: nullable(profile.name, string), email: nullable(profile.email, string), avatarUrl: nullable(profile.avatarUrl, string) },
      effectiveRole, directGrant, inheritedFrom };
  }), (item) => item.userId);
  return { items, actorAccess };
};

export const parseInvitation = (value: unknown, projectId?: string, created = false): ProjectInvitation => {
  const data = record(value);
  if (Object.keys(data).some((key) => !["id", "projectId", "createdBy", "createdAt", "expiresAt", "consumedBy", "consumedAt", "revokedAt"].includes(key) && !(created && key === "link"))) return malformed();
  const invitation: ProjectInvitation = {
    id: id(data.id), projectId: id(data.projectId), createdBy: id(data.createdBy), createdAt: timestamp(data.createdAt), expiresAt: timestamp(data.expiresAt),
    consumedBy: nullable(data.consumedBy, id), consumedAt: nullable(data.consumedAt, timestamp), revokedAt: nullable(data.revokedAt, timestamp),
  };
  if (projectId !== undefined && invitation.projectId !== projectId) return malformed();
  return invitation;
};
export const parseInvitations = (value: unknown, projectId: string): ProjectInvitation[] => {
  const data = record(value);
  if (Object.keys(data).some((key) => key !== "items")) return malformed();
  return unique(array(data.items, (item) => parseInvitation(item, projectId)), (item) => item.id);
};

export const parseCreatedInvitation = (value: unknown, projectId: string, expectedUserId?: string): CreatedProjectInvitation => {
  const data = record(value);
  const link = nonemptyString(data.link);
  let url: URL;
  try { url = new URL(link); } catch { return malformed(); }
  if (url.origin !== window.location.origin || url.pathname !== "/invitations" || url.search !== "" || url.username !== "" || url.password !== "" || url.hash.length < 2 || /[\s\p{Cc}]/u.test(link)) return malformed();
  const invitation = parseInvitation(data, projectId, true);
  if (expectedUserId !== undefined && invitation.createdBy !== expectedUserId) return malformed();
  return { ...invitation, link };
};

const teamInvitationFields = ["id", "teamId", "createdBy", "createdAt", "expiresAt", "consumedBy", "consumedAt", "revokedAt"];
const parseTeamInvitation = (value: unknown, teamId: string, created = false): TeamInvitation => {
  const data = record(value);
  if (Object.keys(data).some((key) => !teamInvitationFields.includes(key) && !(created && key === "link"))) return malformed();
  const invitation = {
    id: id(data.id), teamId: id(data.teamId), createdBy: id(data.createdBy), createdAt: timestamp(data.createdAt), expiresAt: timestamp(data.expiresAt),
    consumedBy: nullable(data.consumedBy, id), consumedAt: nullable(data.consumedAt, timestamp), revokedAt: nullable(data.revokedAt, timestamp),
  };
  if (invitation.teamId !== teamId || (invitation.consumedBy === null) !== (invitation.consumedAt === null)) return malformed();
  return invitation;
};
export const parseTeamInvitations = (value: unknown, teamId: string): TeamInvitation[] => {
  const data = record(value);
  if (Object.keys(data).some((key) => key !== "items")) return malformed();
  return unique(array(data.items, (item) => parseTeamInvitation(item, teamId)), (item) => item.id);
};
export const parseCreatedTeamInvitation = (value: unknown, teamId: string, expectedUserId: string): CreatedTeamInvitation => {
  const data = record(value), link = nonemptyString(data.link);
  let url: URL;
  try { url = new URL(link); } catch { return malformed(); }
  // A 32-byte unpadded base64url secret has 43 characters and two zero pad bits.
  if (url.origin !== window.location.origin || url.pathname !== "/team-invitations" || url.search !== "" || url.username !== "" || url.password !== "" || !/^#dnteam_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(url.hash) || /[\s\p{Cc}\p{Cs}]/u.test(link)) return malformed();
  const invitation = parseTeamInvitation(data, teamId, true);
  if (invitation.createdBy !== expectedUserId || invitation.consumedBy !== null || invitation.revokedAt !== null) return malformed();
  return { ...invitation, link };
};
export const parseRevokeTeamInvitationResult = (value: unknown, teamId: string, invitationId: string): RevokeTeamInvitationResult => {
  const data = record(value);
  if (Object.keys(data).some((key) => !["teamId", "invitationId", "changed"].includes(key))) return malformed();
  const result = { teamId: id(data.teamId), invitationId: id(data.invitationId), changed: boolean(data.changed) };
  if (result.teamId !== teamId || result.invitationId !== invitationId) return malformed();
  return result;
};

const sameGrant = (a: ProjectGrant | null, b: ProjectGrant | null): boolean =>
  a === null || b === null ? a === b : a.projectId === b.projectId && a.userId === b.userId && a.role === b.role && a.version === b.version && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt;

export const decodeInvitationJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  const data = record(JSON.parse(text));
  const fields = jsonObjectSources(text);
  if (Object.hasOwn(data, "directGrant")) data.directGrant = parseApiJson(fields.get("directGrant")!);
  if (Object.hasOwn(data, "access") && data.access !== null) data.access = projectAccessSource(fields.get("access")!);
  return data;
};

export const parseInvitationInspection = (value: unknown, userId: string): ProjectInvitationInspection => {
  const data = record(value);
  if (Object.keys(data).some((key) => !["projectId", "projectName", "directGrant", "access"].includes(key))) return malformed();
  const projectId = id(data.projectId);
  const directGrant = data.directGrant === null ? null : parseProjectGrant(data.directGrant, projectId, userId);
  const access = data.access === null ? null : parseProjectAccess(data.access, projectId, userId);
  if (!sameGrant(directGrant, access?.directGrant ?? null)) return malformed();
  return { projectId, projectName: nonemptyString(data.projectName), directGrant, access };
};

export const parseInvitationAcceptance = (value: unknown, projectId: string, userId: string): ProjectInvitationAcceptance => {
  const data = record(value);
  if (Object.keys(data).some((key) => !["projectId", "directGrant", "access", "joined", "consumed"].includes(key))) return malformed();
  if (id(data.projectId) !== projectId) return malformed();
  const directGrant = parseProjectGrant(data.directGrant, projectId, userId);
  const access = parseProjectAccess(data.access, projectId, userId);
  const joined = boolean(data.joined), consumed = boolean(data.consumed);
  if (!sameGrant(directGrant, access.directGrant) || joined !== consumed) return malformed();
  return { projectId, directGrant, access, joined, consumed };
};

const parseTeamInvitationMember = (value: unknown, teamId: string, userId: string): TeamInvitationMember => {
  const data = record(value);
  if (Object.keys(data).some((key) => !["teamId", "userId", "role", "version", "createdAt", "updatedAt"].includes(key))) return malformed();
  const member = { teamId: id(data.teamId), userId: id(data.userId), role: parseRole(data.role),
    version: parseMemberVersion(data.version), createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt) };
  if (member.teamId !== teamId || member.userId !== userId) return malformed();
  return member;
};
export const decodeTeamInvitationJson = async (response: Response): Promise<unknown> => {
  const text = await response.text(), data = record(JSON.parse(text)), fields = jsonObjectSources(text);
  if (Object.hasOwn(data, "membership")) data.membership = parseApiJson(fields.get("membership")!);
  return data;
};
export const parseTeamInvitationInspection = (value: unknown, userId: string): TeamInvitationInspection => {
  const data = record(value);
  if (Object.keys(data).some((key) => key !== "team" && key !== "membership")) return malformed();
  const team = parseTeamRef(data.team);
  if (team.kind !== "ordinary") return malformed();
  return { team, membership: data.membership === null ? null : parseTeamInvitationMember(data.membership, team.id, userId) };
};
export const parseTeamInvitationAcceptance = (value: unknown, teamId: string, userId: string): TeamInvitationAcceptance => {
  const data = record(value);
  if (Object.keys(data).some((key) => !["team", "membership", "joined", "consumed"].includes(key))) return malformed();
  const team = parseTeamRef(data.team), joined = boolean(data.joined), consumed = boolean(data.consumed);
  if (team.kind !== "ordinary" || team.id !== teamId || joined !== consumed) return malformed();
  const membership = parseTeamInvitationMember(data.membership, teamId, userId);
  if (joined && membership.role !== "member") return malformed();
  return { team, membership, joined, consumed };
};

export const normalizeDeviceUserCode = (value: string): string | null => {
  const code = value.trim().toUpperCase().replace(/[- \t]/g, "");
  return /^[BCDFGHJKLMNPQRSTVWXZ]{10}$/.test(code) ? `${code.slice(0, 5)}-${code.slice(5)}` : null;
};

export const parseDeviceAuthorization = (value: unknown, userCode: string): DeviceAuthorizationInspection => {
  const data = record(value);
  const code = string(data.userCode);
  const status = data.status;
  if (code !== userCode || normalizeDeviceUserCode(code) !== code || !["pending", "approved", "denied", "expired", "consumed"].includes(string(status))) return malformed();
  return { userCode: code, expiresAt: timestamp(data.expiresAt), status: status as DeviceAuthorizationInspection["status"] };
};

export const parseProjectGrant = (value: unknown, projectId: string, userId?: string): ProjectGrant => {
  const data = record(value);
  if (Object.keys(data).some((key) => !["projectId", "userId", "role", "version", "createdAt", "updatedAt"].includes(key))) return malformed();
  const grant = {
    projectId: id(data.projectId), userId: id(data.userId), role: parseRole(data.role),
    version: parseMemberVersion(data.version), createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt),
  };
  if (grant.projectId !== projectId || userId !== undefined && grant.userId !== userId) return malformed();
  return grant;
};

const matchesEffectiveRole = (effective: ProjectRole, team: ProjectRole | null, direct: ProjectRole | null): boolean =>
  (team === "admin" || direct === "admin" ? "admin" : team === "member" || direct === "member" ? "member" : null) === effective;

export const parseProjectAccess = (value: unknown, projectId: string, userId?: string): ProjectAccess => {
  const data = record(value);
  if (Object.keys(data).some((key) => !["projectId", "ownerTeam", "ownership", "effectiveRole", "teamRole", "directGrant", "canTransfer"].includes(key))) return malformed();
  const access: ProjectAccess = {
    projectId: id(data.projectId), ownerTeam: parseTeamRef(data.ownerTeam), ownership: parseProjectOwnership(data.ownership),
    effectiveRole: parseRole(data.effectiveRole), teamRole: data.teamRole === null ? null : parseRole(data.teamRole),
    directGrant: data.directGrant === null ? null : parseProjectGrant(data.directGrant, projectId, userId), canTransfer: boolean(data.canTransfer),
  };
  if (access.projectId !== projectId || access.ownerTeam.id !== access.ownership.teamId || access.canTransfer !== (access.teamRole === "admin") ||
    !matchesEffectiveRole(access.effectiveRole, access.teamRole, access.directGrant?.role ?? null)) return malformed();
  return access;
};

export const projectAccessSource = (text: string): unknown => {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return parsed;
  const data = parsed as Record<string, unknown>;
  const fields = jsonObjectSources(text);
  if (Object.hasOwn(data, 'ownership')) data.ownership = parseApiJson(fields.get('ownership')!);
  if (Object.hasOwn(data, 'directGrant')) data.directGrant = parseApiJson(fields.get('directGrant')!);
  return parsed;
};
export const decodeProjectAccessJson = async (response: Response): Promise<unknown> => projectAccessSource(await response.text());

export const decodeGrantResultJson = async (response: Response): Promise<unknown> => {
  const text = await response.text(), data = record(JSON.parse(text)), fields = jsonObjectSources(text);
  if (Object.hasOwn(data, "grant")) data.grant = parseApiJson(fields.get("grant")!);
  if (Object.hasOwn(data, "actorAccess") && data.actorAccess !== null) data.actorAccess = projectAccessSource(fields.get("actorAccess")!);
  return data;
};

export const parseGrantResult = (value: unknown, projectId: string, userId: string, actorId: string, role: ProjectRole, version: bigint | null): ProjectGrantResult => {
  const data = record(value);
  if (Object.keys(data).some((key) => key !== "grant" && key !== "actorAccess")) return malformed();
  const grant = parseProjectGrant(data.grant, projectId, userId);
  const actorAccess = data.actorAccess === null ? null : parseProjectAccess(data.actorAccess, projectId, actorId);
  if (grant.role !== role || version !== null && grant.version < version ||
    userId === actorId && (actorAccess === null || !sameGrant(grant, actorAccess.directGrant))) return malformed();
  return { grant, actorAccess };
};

export const parseRemoveGrantResult = (value: unknown, projectId: string, userId: string, actorId: string): RemoveProjectGrantResult => {
  const data = record(value);
  if (Object.keys(data).some((key) => !["projectId", "userId", "deleted", "actorAccess"].includes(key)) ||
    id(data.projectId) !== projectId || id(data.userId) !== userId || data.deleted !== true) return malformed();
  const actorAccess = data.actorAccess === null ? null : parseProjectAccess(data.actorAccess, projectId, actorId);
  if (userId === actorId && actorAccess !== null && actorAccess.directGrant !== null) return malformed();
  return { projectId, userId, deleted: true, actorAccess };
};

export const decodeMembersJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return parsed;
  const data = parsed as Record<string, unknown>;
  const fields = jsonObjectSources(text);
  if (Object.hasOwn(data, "actorAccess")) data.actorAccess = projectAccessSource(fields.get("actorAccess")!);
  if (Array.isArray(data.items)) data.items = jsonContainerSources(fields.get("items")!).map(projectAccessSource);
  return parsed;
};
