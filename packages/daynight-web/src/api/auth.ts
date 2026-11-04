import { ApiError, assertResponsePrincipal, isAbortError, json, read, request, requestId, type TaskResponseAdmission } from "./client";
import { decodeAuthJson, normalizeDeviceUserCode, parseAuthConfig, parseCreatedInvitation, parseCreatedToken, parseDeviceAuthorization, parseInvitationInspection, parseInvitations, parseMember, parseMembers, decodeMembersJson, parseProjectGrant, parseMemberVersion, parseProjectAccess, decodeProjectAccessJson, parseRole, parseToken, parseTokens, parseUser } from "./auth-parse";
import { array, boolean, id, malformed, project, record, string, timestamp } from "./parse";
import type { AuthConfig, CreatedPersonalAccessToken, CreatedProjectInvitation, DeviceAuthorizationInspection, PersonalAccessToken, PersonalAccessTokenExpiryUpdate, ProjectInvitation, ProjectInvitationInspection, ProjectMember, ProjectParticipant, ProjectGrant, ProjectPeople, ProjectPeopleQuery, ProjectPerson, ProjectRole, ProjectAccess, User } from "./auth-types";
import type { Project } from "./types";
import { decodeProjectJson } from "./project-json";
export type * from "./auth-types";

const authOperation = async <T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> => {
  try { return await operation(); }
  catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof ApiError) || isAbortError(error)) throw error;
    // Auth responses can contain one-time secrets; retain only sanitized public error metadata.
    throw new ApiError(error.kind, error.status, error.code, error.requestId, error.graphLimit);
  }
};

const authRead = <T>(url: string, signal: AbortSignal, parse: (data: unknown) => T, decode?: (response: Response) => Promise<unknown>): Promise<T> =>
  authOperation(signal, () => read(url, signal, parse, decode));

const send = <T>(url: string, method: "POST" | "PATCH", status: number, body: string, signal: AbortSignal, parse: (data: unknown) => T, decode: (response: Response) => Promise<unknown> = decodeAuthJson): Promise<T> => authOperation(signal, async () => {
  const response = await request(url, signal, { method, body, headers: { Accept: "application/json", "Content-Type": "application/json" } });
  return json(response, signal, (data) => {
    if (response.status !== status) throw new ApiError("protocol", response.status);
    return parse(data);
  }, decode);
});

const empty = (url: string, method: "POST" | "DELETE", signal: AbortSignal, body?: string): Promise<void> => authOperation(signal, async () => {
  const response = await request(url, signal, { method, ...(body === undefined ? {} : { body, headers: { "Content-Type": "application/json" } }) });
  if (!response.ok) return json(response, signal, () => { throw new ApiError("protocol", response.status); });
  if (response.status !== 204) throw new ApiError("protocol", response.status);
});
const projectUrl = (projectId: string): string => `/api/v1/projects/${requestId(projectId)}`;
const secretBody = (token: string): string => {
  if (token === "" || /[\s\p{Cc}\p{Cs}]/u.test(token)) throw new ApiError("protocol");
  return JSON.stringify({ token });
};

export const me = (signal: AbortSignal): Promise<User> => authRead("/api/v1/me", signal, parseUser);
export const getAuthConfig = (signal: AbortSignal): Promise<AuthConfig> => authRead("/api/v1/auth/providers", signal, parseAuthConfig);
export const logout = (signal: AbortSignal): Promise<void> => empty("/api/v1/auth/logout", "POST", signal);
export const listTokens = (signal: AbortSignal, expectedUserId: string, onIdentityMismatch: () => void): Promise<readonly PersonalAccessToken[]> => authOperation(signal, async () => {
  const expected = requestId(expectedUserId);
  const response = await request("/api/v1/me/tokens", signal, { headers: { Accept: "application/json" } });
  assertResponsePrincipal(response, expected, onIdentityMismatch);
  return json(response, signal, parseTokens);
});
const tokenExpiry = (value: string | null): string | null => value === null ? null : timestamp(value);
export const createToken = (input: { readonly name: string; readonly expiresAt: string | null }, signal: AbortSignal): Promise<CreatedPersonalAccessToken> => {
  if (input.name.trim() === "" || [...input.name].length > 100 || /[\u0000\p{Cs}]/u.test(input.name)) throw new ApiError("protocol");
  return send("/api/v1/me/tokens", "POST", 201, JSON.stringify({ name: input.name, expiresAt: tokenExpiry(input.expiresAt) }), signal, parseCreatedToken);
};
export const revokeToken = (tokenId: string, signal: AbortSignal): Promise<void> => empty(`/api/v1/me/tokens/${requestId(tokenId)}`, "DELETE", signal);
export const updateTokenExpiry = (tokenId: string, input: PersonalAccessTokenExpiryUpdate, signal: AbortSignal, onIdentityMismatch: () => void): Promise<PersonalAccessToken> => {
  const id = requestId(tokenId);
  const body = JSON.stringify({ expiresAt: tokenExpiry(input.expiresAt), expectedExpiresAt: tokenExpiry(input.expectedExpiresAt), expectedUserId: requestId(input.expectedUserId) });
  return authOperation(signal, async () => {
    const response = await request(`/api/v1/me/tokens/${id}`, signal, { method: "PATCH", headers: { Accept: "application/json", "Content-Type": "application/json" }, body });
    assertResponsePrincipal(response, input.expectedUserId, onIdentityMismatch);
    return json(response, signal, (data) => {
      if (response.status !== 200) throw new ApiError("protocol", response.status);
      const token = parseToken(data);
      if (token.id !== id) throw new ApiError("protocol", response.status);
      return token;
    });
  });
};

export const createProject = (input: { readonly name: string; readonly repoUrl: string }, signal: AbortSignal): Promise<Project> => {
  if (input.name.trim() === "" || input.repoUrl.trim() === "" || input.name.includes("\0") || input.repoUrl.includes("\0")) throw new ApiError("protocol");
  return send("/api/v1/projects", "POST", 201, JSON.stringify(input), signal, project, decodeProjectJson);
};
export const listMembers = (projectId: string, signal: AbortSignal, admission?: TaskResponseAdmission): Promise<readonly ProjectParticipant[]> => {
  const project = requestId(projectId);
  return authOperation(signal, async () => {
    const response = await request(`${projectUrl(project)}/members`, signal, { headers: { Accept: "application/json" } });
    if (admission !== undefined) assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
    return json(response, signal, (data) => parseMembers(data, project), decodeMembersJson);
  });
};
const parseProjectPeople = (value: unknown, requested: readonly string[] | null): ProjectPeople => {
  const data = record(value);
  if (Object.keys(data).some((key) => key !== "items" && key !== "unresolvedUserIds")) return malformed();
  const items = array(data.items, (value): ProjectPerson => {
    const person = record(value);
    if (Object.keys(person).some((key) => key !== "userId" && key !== "name" && key !== "avatarUrl" && key !== "hasProjectAccess")) return malformed();
    return {
      userId: id(person.userId),
      name: person.name === null ? null : string(person.name),
      avatarUrl: person.avatarUrl === null ? null : string(person.avatarUrl),
      hasProjectAccess: boolean(person.hasProjectAccess),
    };
  });
  const unresolvedUserIds = array(data.unresolvedUserIds, id);
  const returned = [...items.map((item) => item.userId), ...unresolvedUserIds];
  if (new Set(returned).size !== returned.length) return malformed();
  if (requested === null) {
    if (unresolvedUserIds.length !== 0) return malformed();
  } else {
    const expected = new Set(requested);
    if (returned.length !== expected.size || returned.some((userId) => !expected.has(userId))) return malformed();
  }
  return { items, unresolvedUserIds };
};

export const listProjectPeople = (projectId: string, query: ProjectPeopleQuery, signal: AbortSignal, admission: TaskResponseAdmission): Promise<ProjectPeople> => {
  const project = requestId(projectId), user = requestId(admission.userId);
  const requested = query.kind === "catalogue" ? null : query.userIds.map(requestId);
  if (requested !== null && (requested.length === 0 || requested.length > 100 || new Set(requested).size !== requested.length)) throw new ApiError("protocol");
  const parameters = new URLSearchParams();
  if (requested !== null) for (const userId of requested) parameters.append("userId", userId);
  const suffix = requested === null ? "" : `?${parameters}`;
  return authOperation(signal, async () => {
    const response = await request(`${projectUrl(project)}/task-assignees${suffix}`, signal, { headers: { Accept: "application/json" } });
    assertResponsePrincipal(response, user, admission.onPrincipalMismatch);
    return json(response, signal, (value) => {
      if (response.status !== 200) throw new ApiError("protocol", response.status);
      return parseProjectPeople(value, requested);
    });
  });
};
const grantWrite = <T>(signal: AbortSignal, onIdentityMismatch: () => void, operation: () => Promise<T>): Promise<T> => authOperation(signal, async () => {
  try { return await operation(); }
  catch (error) {
    if (error instanceof ApiError && error.code === "identity_mismatch") onIdentityMismatch();
    throw error;
  }
});
export const setMemberRole = (projectId: string, userId: string, input: { readonly version: bigint; readonly role: ProjectRole; readonly expectedUserId: string }, signal: AbortSignal, onIdentityMismatch: () => void): Promise<ProjectGrant> => {
  const project = requestId(projectId), user = requestId(userId), expected = requestId(input.expectedUserId);
  const version = parseMemberVersion(input.version), role = parseRole(input.role);
  return grantWrite(signal, onIdentityMismatch, async () => {
    const response = await request(`${projectUrl(project)}/members/${user}`, signal, { method: "PATCH", headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: `{"version":${version},"role":${JSON.stringify(role)},"expectedUserId":${JSON.stringify(expected)}}` });
    assertResponsePrincipal(response, expected, onIdentityMismatch);
    return json(response, signal, (data) => {
      const grant = parseProjectGrant(data, project, user);
      if (response.status !== 200 || grant.role !== role || grant.version < version) throw new ApiError("protocol", response.status);
      return grant;
    }, decodeAuthJson);
  });
};
export const removeMember = (projectId: string, userId: string, input: { readonly version: bigint; readonly expectedUserId: string }, signal: AbortSignal, onIdentityMismatch: () => void): Promise<void> => {
  const project = requestId(projectId), user = requestId(userId), expected = requestId(input.expectedUserId), version = parseMemberVersion(input.version);
  return grantWrite(signal, onIdentityMismatch, async () => {
    const response = await request(`${projectUrl(project)}/members/${user}`, signal, { method: "DELETE", headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: `{"version":${version},"expectedUserId":${JSON.stringify(expected)}}` });
    assertResponsePrincipal(response, expected, onIdentityMismatch);
    if (response.status === 204) return;
    if (response.ok) throw new ApiError("protocol", response.status);
    await json(response, signal, () => { throw new ApiError("protocol", response.status); });
  });
};

export const listInvitations = (projectId: string, signal: AbortSignal): Promise<readonly ProjectInvitation[]> => {
  const project = requestId(projectId);
  return authRead(`${projectUrl(project)}/invitations`, signal, (data) => parseInvitations(data, project));
};
export const createInvitation = (projectId: string, signal: AbortSignal): Promise<CreatedProjectInvitation> => {
  const project = requestId(projectId);
  return send(`${projectUrl(project)}/invitations`, "POST", 201, "{}", signal, (data) => parseCreatedInvitation(data, project));
};
export const revokeInvitation = (projectId: string, invitationId: string, signal: AbortSignal): Promise<void> =>
  empty(`${projectUrl(projectId)}/invitations/${requestId(invitationId)}`, "DELETE", signal);
export const inspectInvitation = (token: string, signal: AbortSignal): Promise<ProjectInvitationInspection> =>
  send("/api/v1/invitations/inspect", "POST", 200, secretBody(token), signal, parseInvitationInspection);
export const acceptInvitation = (token: string, signal: AbortSignal): Promise<ProjectMember> =>
  send("/api/v1/invitations/accept", "POST", 200, secretBody(token), signal, parseMember);

const deviceRequest = (path: string, userCode: string, expectedUserId: string, signal: AbortSignal, onIdentityMismatch: () => void, decision?: "approve" | "deny"): Promise<Response> => {
  if (normalizeDeviceUserCode(userCode) !== userCode) throw new ApiError("protocol");
  const expected = requestId(expectedUserId);
  return authOperation(signal, async () => {
    const response = await request(`/api/v1/auth/device/${path}`, signal, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ userCode, ...(decision === undefined ? {} : { decision, expectedUserId: expected }) }) });
    assertResponsePrincipal(response, expected, onIdentityMismatch);
    return response;
  });
};

export const inspectDeviceAuthorization = (userCode: string, expectedUserId: string, signal: AbortSignal, onIdentityMismatch: () => void): Promise<DeviceAuthorizationInspection> => authOperation(signal, async () => {
  const response = await deviceRequest("inspect", userCode, expectedUserId, signal, onIdentityMismatch);
  return json(response, signal, (data) => {
    if (response.status !== 200) throw new ApiError("protocol", response.status);
    return parseDeviceAuthorization(data, userCode);
  });
});

export const decideDeviceAuthorization = (userCode: string, decision: "approve" | "deny", expectedUserId: string, signal: AbortSignal, onIdentityMismatch: () => void): Promise<void> => authOperation(signal, async () => {
  const response = await deviceRequest("decision", userCode, expectedUserId, signal, onIdentityMismatch, decision);
  if (!response.ok) return json(response, signal, () => { throw new ApiError("protocol", response.status); });
  if (response.status !== 204) throw new ApiError("protocol", response.status);
});

export const getProjectAccess = (projectId: string, signal: AbortSignal, admission: TaskResponseAdmission): Promise<ProjectAccess> => {
  const project = requestId(projectId);
  return authOperation(signal, async () => {
    const response = await request(`${projectUrl(project)}/access`, signal, { headers: { Accept: "application/json" } });
    assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
    return json(response, signal, (data) => parseProjectAccess(data, project, admission.userId), decodeProjectAccessJson);
  });
};
