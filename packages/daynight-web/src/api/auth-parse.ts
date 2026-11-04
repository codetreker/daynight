import { array, boolean, id, malformed, nonemptyString, record, string, timestamp } from "./parse";
import { parseApiJson } from "./json";
import { jsonContainerSources, jsonObjectSources } from "./json-source";
import type { AuthConfig, AuthProvider, CreatedPersonalAccessToken, CreatedProjectInvitation, DeviceAuthorizationInspection, PersonalAccessToken, ProjectInvitation, ProjectInvitationInspection, ProjectMember, ProjectParticipant, ProjectRole, ProjectAccess, ProjectGrant, User } from "./auth-types";

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
  return {
    id: id(data.id), email: nullable(data.email, string), emailVerified: nullable(data.emailVerified, boolean),
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
export const parseMembers = (value: unknown, projectId: string): ProjectParticipant[] => {
  const page = record(value);
  if (Object.keys(page).some((key) => key !== "items")) return malformed();
  return unique(array(page.items, (value): ProjectParticipant => {
    const data = record(value);
    if (Object.keys(data).some((key) => !["userId", "profile", "effectiveRole", "directGrant"].includes(key))) return malformed();
    const userId = id(data.userId), profile = record(data.profile);
    if (Object.keys(profile).some((key) => !["name", "email", "avatarUrl"].includes(key))) return malformed();
    return { userId, profile: { name: nullable(profile.name, string), email: nullable(profile.email, string), avatarUrl: nullable(profile.avatarUrl, string) },
      effectiveRole: parseRole(data.effectiveRole), directGrant: data.directGrant === null ? null : parseProjectGrant(data.directGrant, projectId, userId) };
  }), (item) => item.userId);
};

export const parseInvitation = (value: unknown, projectId?: string): ProjectInvitation => {
  const data = record(value);
  const invitation: ProjectInvitation = {
    id: id(data.id), projectId: id(data.projectId), createdBy: id(data.createdBy), createdAt: timestamp(data.createdAt), expiresAt: timestamp(data.expiresAt),
    consumedBy: nullable(data.consumedBy, id), consumedAt: nullable(data.consumedAt, timestamp), revokedAt: nullable(data.revokedAt, timestamp),
  };
  if (projectId !== undefined && invitation.projectId !== projectId) return malformed();
  return invitation;
};
export const parseInvitations = (value: unknown, projectId: string): ProjectInvitation[] =>
  unique(array(record(value).items, (item) => parseInvitation(item, projectId)), (item) => item.id);

export const parseCreatedInvitation = (value: unknown, projectId: string): CreatedProjectInvitation => {
  const data = record(value);
  const link = nonemptyString(data.link);
  let url: URL;
  try { url = new URL(link); } catch { return malformed(); }
  if (url.origin !== window.location.origin || url.pathname !== "/invitations" || url.search !== "" || url.username !== "" || url.password !== "" || url.hash.length < 2 || /[\s\p{Cc}]/u.test(link)) return malformed();
  return { ...parseInvitation(data, projectId), link };
};

export const parseInvitationInspection = (value: unknown): ProjectInvitationInspection => {
  const data = record(value);
  const projectId = id(data.projectId);
  return {
    projectId, projectName: nonemptyString(data.projectName),
    ...(Object.hasOwn(data, "member") ? { member: parseMember(data.member, projectId) } : {}),
  };
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

export const parseProjectAccess = (value: unknown, projectId: string, userId?: string): ProjectAccess => {
  const data = record(value);
  return { effectiveRole: parseRole(data.effectiveRole), directGrant: data.directGrant === null ? null : parseProjectGrant(data.directGrant, projectId, userId) };
};

export const projectAccessSource = (text: string): unknown => {
  const parsed = parseApiJson(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return parsed;
  const data = parsed as Record<string, unknown>;
  if (Object.hasOwn(data, 'directGrant')) data.directGrant = parseApiJson(jsonObjectSources(text).get('directGrant')!);
  return parsed;
};
export const decodeProjectAccessJson = async (response: Response): Promise<unknown> => projectAccessSource(await response.text());

export const decodeMembersJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return parsed;
  const data = parsed as Record<string, unknown>;
  if (Array.isArray(data.items)) data.items = jsonContainerSources(jsonObjectSources(text).get("items")!).map(projectAccessSource);
  return parsed;
};
