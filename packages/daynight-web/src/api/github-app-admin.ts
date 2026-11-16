import { ApiError, assertResponsePrincipal, json, request, requestId, type TaskResponseAdmission } from "./client";
import { array, boolean, id, malformed, nonemptyString, record, string, timestamp } from "./validation";

export type GitHubAppAdminMembership = { readonly appId: string; readonly userId: string; readonly membershipVersion: string; readonly createdAt: string; readonly updatedAt: string };
export type GitHubAppAdmin = GitHubAppAdminMembership & { readonly profile: { readonly name: string | null; readonly email: string | null; readonly avatarUrl: string | null } };
export type GitHubAppAdminInvitation = { readonly id: string; readonly appId: string; readonly createdBy: string; readonly issuerMembershipVersion: string; readonly createdAt: string; readonly expiresAt: string; readonly revokedAt: string | null; readonly consumedAt: string | null; readonly consumedBy: string | null; readonly available: boolean };
export type GitHubAppAdminPage = { readonly items: readonly GitHubAppAdmin[]; readonly nextCursor: string | null };
export type GitHubAppAdminInvitationPage = { readonly items: readonly GitHubAppAdminInvitation[]; readonly nextCursor: string | null };
export type CreatedGitHubAppAdminInvitation = GitHubAppAdminInvitation & { readonly link: string };
export type GitHubAppAdminRemoval = { readonly appId: string; readonly userId: string; readonly removed: true; readonly actorIsAdmin: boolean };
export type GitHubAppAdminInvitationRevocation = { readonly appId: string; readonly invitationId: string; readonly changed: boolean };
export type GitHubAppAdminInvitationInspection = { readonly app: { readonly id: string; readonly githubAppId: string; readonly name: string; readonly githubName: string; readonly githubSlug: string }; readonly expiresAt: string; readonly membership: GitHubAppAdminMembership | null };
export type GitHubAppAdminInvitationAcceptance = { readonly appId: string; readonly membership: GitHubAppAdminMembership; readonly joined: boolean };

type Admission = TaskResponseAdmission;
const exact = (data: Record<string, unknown>, keys: readonly string[]) => { if (Object.keys(data).some(key => !keys.includes(key))) return malformed(); };
const decimal = (value: unknown): string => {
  const parsed = string(value);
  if (!/^[1-9][0-9]*$/.test(parsed) || parsed.length > 19 || BigInt(parsed) > 9_223_372_036_854_775_807n) return malformed();
  return parsed;
};
const requireDecimal = (value: string): string => { try { return decimal(value); } catch { throw new ApiError("protocol"); } };
const nullable = <T>(value: unknown, parse: (value: unknown) => T): T | null => value === null ? null : parse(value);
const query = (cursor: string | null): string => {
  const q = new URLSearchParams({ limit: "50" });
  if (cursor !== null) { if (cursor === "") throw new ApiError("protocol"); q.set("cursor", cursor); }
  return `?${q}`;
};
const unique = (values: readonly string[]) => { if (new Set(values).size !== values.length) return malformed(); };
const membershipFields = ["appId", "userId", "membershipVersion", "createdAt", "updatedAt"];
const parseMembership = (value: unknown, appId?: string, userId?: string, extras: readonly string[] = []): GitHubAppAdminMembership => {
  const data = record(value); exact(data, [...membershipFields, ...extras]);
  const result = { appId: id(data.appId), userId: id(data.userId), membershipVersion: decimal(data.membershipVersion), createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt) };
  if (appId !== undefined && result.appId !== appId || userId !== undefined && result.userId !== userId) return malformed();
  return result;
};
const parseAdmin = (value: unknown, appId: string): GitHubAppAdmin => {
  const data = record(value), member = parseMembership(data, appId, undefined, ["profile"]), profile = record(data.profile);
  exact(profile, ["name", "email", "avatarUrl"]);
  return { ...member, profile: { name: nullable(profile.name, string), email: nullable(profile.email, string), avatarUrl: nullable(profile.avatarUrl, string) } };
};
const invitationFields = ["id", "appId", "createdBy", "issuerMembershipVersion", "createdAt", "expiresAt", "revokedAt", "consumedAt", "consumedBy", "available"];
const parseInvitation = (value: unknown, appId: string, created = false): GitHubAppAdminInvitation => {
  const data = record(value); exact(data, created ? [...invitationFields, "link"] : invitationFields);
  const result = { id: id(data.id), appId: id(data.appId), createdBy: id(data.createdBy), issuerMembershipVersion: decimal(data.issuerMembershipVersion), createdAt: timestamp(data.createdAt), expiresAt: timestamp(data.expiresAt), revokedAt: nullable(data.revokedAt, timestamp), consumedAt: nullable(data.consumedAt, timestamp), consumedBy: nullable(data.consumedBy, id), available: boolean(data.available) };
  if (result.appId !== appId || (result.consumedAt === null) !== (result.consumedBy === null) || result.available && (result.revokedAt !== null || result.consumedAt !== null)) return malformed();
  return result;
};
const call = async <T>(url: string, signal: AbortSignal, admission: Admission, parse: (value: unknown) => T, method: "GET" | "POST" = "GET", body?: object, status = 200, write = false): Promise<T> => {
  const timeout = new AbortController(), lifetime = method === "POST" ? AbortSignal.any([signal, timeout.signal]) : signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await request(url, lifetime, { method, headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, method === "GET" ? undefined : () => {
      timer = setTimeout(() => timeout.abort(new DOMException("GitHub App administrator request timed out.", "TimeoutError")), 20_000);
      if (write) admission.onDispatch?.();
    });
    assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
    if (response.ok && response.status !== status) throw new ApiError("protocol", response.status);
    return await json(response, lifetime, value => {
      const result = parse(value);
      if (write) admission.onWriteConfirmed?.();
      return result;
    }, undefined, false, write ? admission.onWriteRejected : undefined);
  } finally { if (timer !== undefined) clearTimeout(timer); }
};
const appBase = (appId: string): string => `/api/v1/github/apps/${requestId(appId)}`;
const invitationBase = "/api/v1/github-app-admin-invitations";
export const listGitHubAppAdmins = (appId: string, cursor: string | null, signal: AbortSignal, admission: Admission): Promise<GitHubAppAdminPage> => {
  const target = requestId(appId);
  return call(`${appBase(target)}/admins${query(cursor)}`, signal, admission, value => {
    const data = record(value); exact(data, ["items", "nextCursor"]);
    const items = array(data.items, item => parseAdmin(item, target)); unique(items.map(item => item.userId));
    return { items, nextCursor: nullable(data.nextCursor, nonemptyString) };
  });
};
export const listGitHubAppAdminInvitations = (appId: string, cursor: string | null, signal: AbortSignal, admission: Admission): Promise<GitHubAppAdminInvitationPage> => {
  const target = requestId(appId);
  return call(`${appBase(target)}/admin-invitations${query(cursor)}`, signal, admission, value => {
    const data = record(value); exact(data, ["items", "nextCursor"]);
    const items = array(data.items, item => parseInvitation(item, target)); unique(items.map(item => item.id));
    return { items, nextCursor: nullable(data.nextCursor, nonemptyString) };
  });
};
export const createGitHubAppAdminInvitation = (appId: string, signal: AbortSignal, admission: Admission): Promise<CreatedGitHubAppAdminInvitation> => {
  const target = requestId(appId), actor = requestId(admission.userId);
  return call(`${appBase(target)}/admin-invitations`, signal, admission, value => {
    const data = record(value), invitation = parseInvitation(data, target, true), link = nonemptyString(data.link);
    let url: URL; try { url = new URL(link); } catch { return malformed(); }
    if (url.origin !== window.location.origin || url.pathname !== "/github-app-admin-invitations" || url.search || url.username || url.password || !/^#dn_gai_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(url.hash) || /[\s\p{Cc}\p{Cs}]/u.test(link) || invitation.createdBy !== actor || !invitation.available || invitation.consumedAt !== null || invitation.revokedAt !== null) return malformed();
    return { ...invitation, link };
  }, "POST", { expectedUserId: actor }, 201, true);
};
export const revokeGitHubAppAdminInvitation = (appId: string, invitationId: string, signal: AbortSignal, admission: Admission): Promise<GitHubAppAdminInvitationRevocation> => {
  const target = requestId(appId), invitation = requestId(invitationId);
  return call(`${appBase(target)}/admin-invitations/${invitation}/revoke`, signal, admission, value => {
    const data = record(value); exact(data, ["appId", "invitationId", "changed"]);
    const result = { appId: id(data.appId), invitationId: id(data.invitationId), changed: boolean(data.changed) };
    if (result.appId !== target || result.invitationId !== invitation) return malformed();
    return result;
  }, "POST", { expectedUserId: requestId(admission.userId) }, 200, true);
};
export const removeGitHubAppAdmin = (appId: string, userId: string, membershipVersion: string, signal: AbortSignal, admission: Admission): Promise<GitHubAppAdminRemoval> => {
  const target = requestId(appId), member = requestId(userId), actor = requestId(admission.userId), version = requireDecimal(membershipVersion);
  return call(`${appBase(target)}/admins/${member}/remove`, signal, admission, value => {
    const data = record(value); exact(data, ["appId", "userId", "removed", "actorIsAdmin"]);
    if (id(data.appId) !== target || id(data.userId) !== member || data.removed !== true || boolean(data.actorIsAdmin) !== (member !== actor)) return malformed();
    return { appId: target, userId: member, removed: true as const, actorIsAdmin: member !== actor };
  }, "POST", { membershipVersion: version, expectedUserId: actor }, 200, true);
};
export const inspectGitHubAppAdminInvitation = (token: string, signal: AbortSignal, admission: Admission): Promise<GitHubAppAdminInvitationInspection> => call(`${invitationBase}/inspect`, signal, admission, value => {
  const data = record(value); exact(data, ["app", "expiresAt", "membership"]);
  const identity = record(data.app); exact(identity, ["id", "githubAppId", "name", "githubName", "githubSlug"]);
  const app = { id: id(identity.id), githubAppId: decimal(identity.githubAppId), name: nonemptyString(identity.name), githubName: nonemptyString(identity.githubName), githubSlug: nonemptyString(identity.githubSlug) };
  return { app, expiresAt: timestamp(data.expiresAt), membership: nullable(data.membership, member => parseMembership(member, app.id, requestId(admission.userId))) };
}, "POST", { token });
export const acceptGitHubAppAdminInvitation = (token: string, appId: string, signal: AbortSignal, admission: Admission): Promise<GitHubAppAdminInvitationAcceptance> => {
  const target = requestId(appId), actor = requestId(admission.userId);
  return call(`${invitationBase}/accept`, signal, admission, value => {
    const data = record(value); exact(data, ["appId", "membership", "joined"]);
    if (id(data.appId) !== target) return malformed();
    return { appId: target, membership: parseMembership(data.membership, target, actor), joined: boolean(data.joined) };
  }, "POST", { token, expectedUserId: actor }, 200, true);
};
