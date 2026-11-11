import { ApiError, assertResponsePrincipal, isAbortError, json, read, request, requestId, type TaskResponseAdmission } from "./client";
import { decodeAuthJson, normalizeDeviceUserCode, parseAuthConfig, parseCreatedInvitation, parseCreatedTeamInvitation, parseCreatedToken, parseDeviceAuthorization, parseInvitationInspection, parseInvitationAcceptance, decodeInvitationJson, parseTeamInvitationInspection, parseTeamInvitationAcceptance, decodeTeamInvitationJson, parseTeamInvitations, parseRevokeTeamInvitationResult, parseInvitations, parseMember, parseMembers, decodeMembersJson, parseProjectGrant, parseMemberVersion, parseProjectAccess, decodeProjectAccessJson, decodeGrantResultJson, parseGrantResult, parseRemoveGrantResult, parseRole, parseToken, parseTokens, parseUser } from "./auth-parse";
import { array, boolean, id, malformed, project, record, string, timestamp } from "./parse";
import type { AuthConfig, CreatedPersonalAccessToken, CreatedProjectInvitation, CreatedTeamInvitation, DeviceAuthorizationInspection, PersonalAccessToken, PersonalAccessTokenExpiryUpdate, ProjectInvitation, ProjectInvitationInspection, ProjectInvitationAcceptance, ProjectMember, ProjectParticipants, ProjectGrant, ProjectGrantResult, RemoveProjectGrantResult, RevokeTeamInvitationResult, ProjectPeople, ProjectPeopleQuery, ProjectPerson, ProjectRole, ProjectAccess, User, TeamInvitation, TeamInvitationInspection, TeamInvitationAcceptance } from "./auth-types";
import type { Project } from "./types";
import { parseProfileVersion } from "./profile-version";
import { decodeProjectJson } from "./project-json";
export type * from "./auth-types";

const authOperation = async <T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> => {
  try { return await operation(); }
  catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof ApiError) || isAbortError(error)) throw error;
    // Auth responses can contain one-time secrets; retain only sanitized public error metadata.
    throw new ApiError(error.kind, error.status, error.code, error.requestId);
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

export const me = (signal: AbortSignal): Promise<User> => authOperation(signal, async () => {
  const response = await request("/api/v1/me", signal, { cache: "no-cache", headers: { Accept: "application/json" } });
  return json(response, signal, (value) => {
    if (response.status !== 200) throw new ApiError("protocol", response.status);
    return parseUser(value);
  });
});
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

export class ProjectCreationUnknown extends Error {
  constructor(cause: unknown) { super("The project creation outcome is unknown.", { cause }); this.name = "ProjectCreationUnknown"; }
}
export const createProject = (input: { readonly name: string; readonly repoUrl: string; readonly expectedUserId: string; readonly teamId?: string }, signal: AbortSignal, onIdentityMismatch: () => void, onDispatch?: () => void, onConfirmed?: (project: Project) => void, onRejected?: (error: ApiError) => void): Promise<Project> => {
  if (!input.name.isWellFormed() || !/[^\p{White_Space}]/u.test(input.name) || input.name.includes("\0") || !input.repoUrl.isWellFormed() || !/[^\p{White_Space}]/u.test(input.repoUrl) || input.repoUrl.includes("\0")) throw new ApiError("protocol");
  const expected = requestId(input.expectedUserId);
  const teamId = input.teamId === undefined ? undefined : requestId(input.teamId);
  let dispatched = false;
  return (async () => {
    try {
      const response = await request("/api/v1/projects", signal, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ name: input.name, repoUrl: input.repoUrl, expectedUserId: expected, ...(teamId === undefined ? {} : { teamId }) }) }, () => { dispatched = true; onDispatch?.(); });
      assertResponsePrincipal(response, expected, onIdentityMismatch);
      return await json(response, signal, (value) => {
        if (response.status !== 201) throw new ApiError("protocol", response.status);
        const data = record(value);
        if (Object.keys(data).some((key) => !["id", "name", "repoUrl", "settings", "ownership", "createdAt", "updatedAt", "access"].includes(key))) return malformed();
        const created = project(data), access = parseProjectAccess(data.access, created.id, expected);
        if (teamId !== undefined && teamId !== created.ownership.teamId || access.ownership.teamId !== created.ownership.teamId || access.ownership.version !== created.ownership.version || access.directGrant?.role !== "admin" || access.teamRole === null) return malformed();
        onConfirmed?.(created);
        return created;
      }, decodeProjectJson, false, onRejected);
    } catch (error) {
      // A decoded refusal remains definite even if its identity callback cancels the scope.
      if (error instanceof ApiError && error.kind === "server" && error.status !== null && error.status >= 400 && error.status < 500) {
        if (error.code === "identity_mismatch") onIdentityMismatch();
        throw new ApiError(error.kind, error.status, error.code, error.requestId);
      }
      signal.throwIfAborted();
      if (error instanceof ApiError && !isAbortError(error)) throw new ApiError(error.kind, error.status, error.code, error.requestId);
      throw error;
    }
  })().catch((error: unknown) => {
    if (dispatched && !(error instanceof ApiError && error.kind === "server" && error.status !== null && error.status >= 400 && error.status < 500)) throw new ProjectCreationUnknown(error);
    throw error;
  });
};
export const listMembers = (projectId: string, signal: AbortSignal, admission?: TaskResponseAdmission): Promise<ProjectParticipants> => {
  const project = requestId(projectId);
  return authOperation(signal, async () => {
    const response = await request(`${projectUrl(project)}/members`, signal, { headers: { Accept: "application/json" } });
    if (admission !== undefined) assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
    return json(response, signal, (data) => parseMembers(data, project, admission?.userId), decodeMembersJson);
  });
};
const parseProjectPeople = (value: unknown, requested: readonly string[] | null): ProjectPeople => {
  const data = record(value);
  if (Object.keys(data).some((key) => key !== "items" && key !== "unresolvedUserIds")) return malformed();
  const items = array(data.items, (value): ProjectPerson => {
    const person = record(value);
    if (Object.keys(person).some((key) => key !== "userId" && key !== "name" && key !== "avatarUrl" && key !== "hasProjectAccess" && key !== "version")) return malformed();
    return {
      userId: id(person.userId),
      version: parseProfileVersion(person.version),
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
const projectGrantWrite = async <T>(signal: AbortSignal, onIdentityMismatch: () => void, operation: () => Promise<T>): Promise<T> => {
  try { return await operation(); }
  catch (error) {
    signal.throwIfAborted();
    if (error instanceof ApiError && error.code === "identity_mismatch") onIdentityMismatch();
    throw error;
  }
};
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

export const setProjectGrant = (projectId: string, userId: string, input: { readonly version: bigint | null; readonly role: ProjectRole; readonly expectedUserId: string }, signal: AbortSignal, onIdentityMismatch: () => void, onDispatch?: () => void): Promise<ProjectGrantResult> => {
  const project = requestId(projectId), user = requestId(userId), expected = requestId(input.expectedUserId);
  const version = input.version === null ? null : parseMemberVersion(input.version), role = parseRole(input.role);
  return projectGrantWrite(signal, onIdentityMismatch, async () => {
    const response = await request(`${projectUrl(project)}/grants/${user}`, signal, { method: "PUT", headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: `{"version":${version === null ? "null" : version},"role":${JSON.stringify(role)},"expectedUserId":${JSON.stringify(expected)}}` }, onDispatch);
    assertResponsePrincipal(response, expected, onIdentityMismatch);
    return json(response, signal, (data) => {
      if (response.status !== 200) throw new ApiError("protocol", response.status);
      return parseGrantResult(data, project, user, expected, role, version);
    }, decodeGrantResultJson);
  });
};

export const removeProjectGrant = (projectId: string, userId: string, input: { readonly version: bigint; readonly expectedUserId: string }, signal: AbortSignal, onIdentityMismatch: () => void, onDispatch?: () => void): Promise<RemoveProjectGrantResult> => {
  const project = requestId(projectId), user = requestId(userId), expected = requestId(input.expectedUserId), version = parseMemberVersion(input.version);
  return projectGrantWrite(signal, onIdentityMismatch, async () => {
    const response = await request(`${projectUrl(project)}/grants/${user}`, signal, { method: "DELETE", headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: `{"version":${version},"expectedUserId":${JSON.stringify(expected)}}` }, onDispatch);
    assertResponsePrincipal(response, expected, onIdentityMismatch);
    return json(response, signal, (data) => {
      if (response.status !== 200) throw new ApiError("protocol", response.status);
      return parseRemoveGrantResult(data, project, user, expected);
    }, decodeGrantResultJson);
  });
};

export const listInvitations = (projectId: string, signal: AbortSignal, admission: TaskResponseAdmission): Promise<readonly ProjectInvitation[]> => {
  const project = requestId(projectId), expected = requestId(admission.userId);
  return authOperation(signal, async () => {
    const response = await request(`${projectUrl(project)}/invitations`, signal, { headers: { Accept: "application/json" } });
    assertResponsePrincipal(response, expected, admission.onPrincipalMismatch);
    return json(response, signal, (data) => {
      if (response.status !== 200) throw new ApiError("protocol", response.status);
      return parseInvitations(data, project);
    });
  });
};
const invitationRequest = (url: string, method: "POST" | "DELETE", body: string, expected: string, signal: AbortSignal, onIdentityMismatch: () => void, onDispatch?: () => void): Promise<Response> =>
  grantWrite(signal, onIdentityMismatch, async () => {
    const response = await request(url, signal, { method, body, headers: { Accept: "application/json", "Content-Type": "application/json" } }, onDispatch);
    assertResponsePrincipal(response, expected, onIdentityMismatch);
    return response;
  });
export const createInvitation = (projectId: string, expectedUserId: string, signal: AbortSignal, onIdentityMismatch: () => void, onDispatch?: () => void): Promise<CreatedProjectInvitation> => {
  const project = requestId(projectId), expected = requestId(expectedUserId);
  return grantWrite(signal, onIdentityMismatch, async () => {
    const response = await invitationRequest(`${projectUrl(project)}/invitations`, "POST", JSON.stringify({ expectedUserId: expected }), expected, signal, onIdentityMismatch, onDispatch);
    return json(response, signal, (data) => {
      if (response.status !== 201) throw new ApiError("protocol", response.status);
      return parseCreatedInvitation(data, project, expected);
    });
  });
};
export const revokeInvitation = (projectId: string, invitationId: string, expectedUserId: string, signal: AbortSignal, onIdentityMismatch: () => void, onDispatch?: () => void): Promise<void> => {
  const project = requestId(projectId), invite = requestId(invitationId), expected = requestId(expectedUserId);
  return grantWrite(signal, onIdentityMismatch, async () => {
    const response = await invitationRequest(`${projectUrl(project)}/invitations/${invite}`, "DELETE", JSON.stringify({ expectedUserId: expected }), expected, signal, onIdentityMismatch, onDispatch);
    if (response.status === 204) return;
    if (response.ok) throw new ApiError("protocol", response.status);
    await json(response, signal, () => { throw new ApiError("protocol", response.status); });
  });
};
export const listTeamInvitations = (teamId: string, signal: AbortSignal, admission: TaskResponseAdmission): Promise<readonly TeamInvitation[]> => {
  const team = requestId(teamId), expected = requestId(admission.userId);
  return authOperation(signal, async () => {
    const response = await request(`/api/v1/teams/${team}/invitations`, signal, { headers: { Accept: "application/json" } });
    assertResponsePrincipal(response, expected, admission.onPrincipalMismatch);
    return json(response, signal, (data) => {
      if (response.status !== 200) throw new ApiError("protocol", response.status);
      return parseTeamInvitations(data, team);
    });
  });
};
export const createTeamInvitation = (teamId: string, expectedUserId: string, signal: AbortSignal, onIdentityMismatch: () => void, onDispatch?: () => void): Promise<CreatedTeamInvitation> => {
  const team = requestId(teamId), expected = requestId(expectedUserId);
  return grantWrite(signal, onIdentityMismatch, async () => {
    const response = await invitationRequest(`/api/v1/teams/${team}/invitations`, "POST", JSON.stringify({ expectedUserId: expected }), expected, signal, onIdentityMismatch, onDispatch);
    return json(response, signal, (data) => {
      if (response.status !== 201) throw new ApiError("protocol", response.status);
      return parseCreatedTeamInvitation(data, team, expected);
    });
  });
};
export const revokeTeamInvitation = (teamId: string, invitationId: string, expectedUserId: string, signal: AbortSignal, onIdentityMismatch: () => void, onDispatch?: () => void): Promise<RevokeTeamInvitationResult> => {
  const team = requestId(teamId), invite = requestId(invitationId), expected = requestId(expectedUserId);
  return grantWrite(signal, onIdentityMismatch, async () => {
    const response = await invitationRequest(`/api/v1/teams/${team}/invitations/${invite}`, "DELETE", JSON.stringify({ expectedUserId: expected }), expected, signal, onIdentityMismatch, onDispatch);
    return json(response, signal, (data) => {
      if (response.status !== 200) throw new ApiError("protocol", response.status);
      return parseRevokeTeamInvitationResult(data, team, invite);
    });
  });
};
export const inspectInvitation = (token: string, expectedUserId: string, signal: AbortSignal, onIdentityMismatch: () => void): Promise<ProjectInvitationInspection> => {
  const body = secretBody(token), expected = requestId(expectedUserId);
  return grantWrite(signal, onIdentityMismatch, async () => {
    const response = await invitationRequest("/api/v1/invitations/inspect", "POST", body, expected, signal, onIdentityMismatch);
    return json(response, signal, (data) => {
      if (response.status !== 200) throw new ApiError("protocol", response.status);
      return parseInvitationInspection(data, expected);
    }, decodeInvitationJson);
  });
};
export const acceptInvitation = (token: string, projectId: string, expectedUserId: string, signal: AbortSignal, onIdentityMismatch: () => void): Promise<ProjectInvitationAcceptance> => {
  const secret = JSON.parse(secretBody(token)) as { token: string }, project = requestId(projectId), expected = requestId(expectedUserId);
  return grantWrite(signal, onIdentityMismatch, async () => {
    const response = await invitationRequest("/api/v1/invitations/accept", "POST", JSON.stringify({ ...secret, expectedUserId: expected }), expected, signal, onIdentityMismatch);
    return json(response, signal, (data) => {
      if (response.status !== 200) throw new ApiError("protocol", response.status);
      return parseInvitationAcceptance(data, project, expected);
    }, decodeInvitationJson);
  });
};

export const inspectTeamInvitation = (token: string, expectedUserId: string, signal: AbortSignal, onIdentityMismatch: () => void): Promise<TeamInvitationInspection> => {
  const body = secretBody(token), expected = requestId(expectedUserId);
  return grantWrite(signal, onIdentityMismatch, async () => {
    const response = await invitationRequest("/api/v1/team-invitations/inspect", "POST", body, expected, signal, onIdentityMismatch);
    return json(response, signal, (data) => {
      if (response.status !== 200) throw new ApiError("protocol", response.status);
      return parseTeamInvitationInspection(data, expected);
    }, decodeTeamInvitationJson);
  });
};
export const acceptTeamInvitation = (token: string, teamId: string, expectedUserId: string, signal: AbortSignal, onIdentityMismatch: () => void): Promise<TeamInvitationAcceptance> => {
  const secret = JSON.parse(secretBody(token)) as { token: string }, team = requestId(teamId), expected = requestId(expectedUserId);
  return grantWrite(signal, onIdentityMismatch, async () => {
    const response = await invitationRequest("/api/v1/team-invitations/accept", "POST", JSON.stringify({ ...secret, expectedUserId: expected }), expected, signal, onIdentityMismatch);
    return json(response, signal, (data) => {
      if (response.status !== 200) throw new ApiError("protocol", response.status);
      return parseTeamInvitationAcceptance(data, team, expected);
    }, decodeTeamInvitationJson);
  });
};

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
