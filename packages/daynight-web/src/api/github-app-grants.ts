import { ApiError, assertResponsePrincipal, json, request, requestId, type TaskResponseAdmission } from "./client";
import { parseTeamRef } from "./team-parse";
import { array, id, malformed, nonemptyString, record, string, timestamp } from "./validation";
import type { TeamRef } from "./auth-types";
import type { GitHubImpactProjectPage } from "./github-app-management";

export type GitHubGrantTeam = TeamRef & { readonly version: string; readonly personalOwner: { readonly userId: string; readonly name: string | null } | null };
export type GitHubTeamGrant = { readonly id: string; readonly appId: string; readonly team: GitHubGrantTeam; readonly createdAt: string };
export type GitHubTeamGrantPage = { readonly items: readonly GitHubTeamGrant[]; readonly nextCursor: string | null };
export type GitHubGrantPreview = { readonly appId: string; readonly version: string; readonly targetTeam: GitHubGrantTeam; readonly grant: GitHubTeamGrant | null };
export type GitHubGrantImpact = { readonly appId: string; readonly grantId: string; readonly version: string; readonly impactVersion: string; readonly totalProjects: string; readonly visibleProjects: string; readonly hiddenProjects: string; readonly teams: readonly { readonly team: TeamRef; readonly projects: string }[]; readonly nextCursor: string | null };
export type CreateGitHubAppGrantInput = { readonly id: string; readonly version: string; readonly teamId: string; readonly teamVersion: string };
export type RevokeGitHubAppGrantInput = { readonly version: string; readonly impactVersion: string };

type Admission = TaskResponseAdmission;
const exact = (data: Record<string, unknown>, keys: readonly string[]) => { if (Object.keys(data).some(key => !keys.includes(key))) return malformed(); };
const decimal = (value: unknown, positive = true): string => {
  const parsed = string(value);
  if (!/^(?:0|[1-9][0-9]*)$/.test(parsed) || parsed.length > 19 || BigInt(parsed) > 9_223_372_036_854_775_807n || positive && parsed === "0") return malformed();
  return parsed;
};
const requireDecimal = (value: string): string => { try { return decimal(value); } catch { throw new ApiError("protocol"); } };
const cursor = (value: unknown): string | null => value === null ? null : nonemptyString(value);
const query = (value: string | null): string => {
  const q = new URLSearchParams({ limit: "50" });
  if (value !== null) { if (value === "") throw new ApiError("protocol"); q.set("cursor", value); }
  return `?${q}`;
};
const unique = (values: readonly string[]) => { if (new Set(values).size !== values.length) return malformed(); };
const team = (value: unknown): GitHubGrantTeam => {
  const data = record(value); exact(data, ["id", "kind", "name", "version", "personalOwner"]);
  const ref = parseTeamRef({ id: data.id, kind: data.kind, name: data.name });
  if (ref.kind === "ordinary") {
    if (data.personalOwner !== null) return malformed();
    return { ...ref, version: decimal(data.version), personalOwner: null };
  }
  const owner = record(data.personalOwner); exact(owner, ["userId", "name"]);
  return { ...ref, version: decimal(data.version), personalOwner: { userId: id(owner.userId), name: owner.name === null ? null : string(owner.name) } };
};
const grant = (value: unknown, appId: string): GitHubTeamGrant => {
  const data = record(value); exact(data, ["id", "appId", "team", "createdAt"]);
  const result = { id: id(data.id), appId: id(data.appId), team: team(data.team), createdAt: timestamp(data.createdAt) };
  if (result.appId !== appId) return malformed();
  return result;
};
const sameTeam = (a: GitHubGrantTeam, b: GitHubGrantTeam) => a.id === b.id && a.kind === b.kind && a.name === b.name && a.version === b.version && a.personalOwner?.userId === b.personalOwner?.userId && a.personalOwner?.name === b.personalOwner?.name;
const call = async <T>(url: string, signal: AbortSignal, admission: Admission, parse: (value: unknown) => T, method: "GET" | "POST" = "GET", body?: object, status = 200, write = false): Promise<T> => {
  const timeout = new AbortController(), lifetime = method === "POST" ? AbortSignal.any([signal, timeout.signal]) : signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await request(url, lifetime, { method, headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, method === "GET" ? undefined : () => {
      timer = setTimeout(() => timeout.abort(new DOMException("GitHub App grant request timed out.", "TimeoutError")), 20_000);
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
const base = (appId: string): string => `/api/v1/github/apps/${requestId(appId)}`;
const grantBase = (appId: string, grantId: string): string => `${base(appId)}/team-grants/${requestId(grantId)}`;
export const listGitHubAppGrants = (appId: string, pageCursor: string | null, signal: AbortSignal, admission: Admission): Promise<GitHubTeamGrantPage> => {
  const target = requestId(appId);
  return call(`${base(target)}/team-grants${query(pageCursor)}`, signal, admission, value => {
    const data = record(value); exact(data, ["items", "nextCursor"]);
    const items = array(data.items, item => grant(item, target)); unique(items.map(item => item.id)); unique(items.map(item => item.team.id));
    return { items, nextCursor: cursor(data.nextCursor) };
  });
};
export const getGitHubAppGrant = (appId: string, grantId: string, signal: AbortSignal, admission: Admission): Promise<GitHubTeamGrant> => {
  const target = requestId(appId), expected = requestId(grantId);
  return call(grantBase(target, expected), signal, admission, value => { const result = grant(value, target); if (result.id !== expected) return malformed(); return result; });
};
export const previewGitHubAppGrant = (appId: string, teamId: string, signal: AbortSignal, admission: Admission): Promise<GitHubGrantPreview> => {
  const target = requestId(appId), expectedTeam = requestId(teamId);
  return call(`${base(target)}/team-grant-preview`, signal, admission, value => {
    const data = record(value); exact(data, ["appId", "version", "targetTeam", "grant"]);
    const result = { appId: id(data.appId), version: decimal(data.version), targetTeam: team(data.targetTeam), grant: data.grant === null ? null : grant(data.grant, target) };
    if (result.appId !== target || result.targetTeam.id !== expectedTeam || result.grant !== null && !sameTeam(result.grant.team, result.targetTeam)) return malformed();
    return result;
  }, "POST", { teamId: expectedTeam });
};
export const createGitHubAppGrant = (appId: string, input: CreateGitHubAppGrantInput, signal: AbortSignal, admission: Admission): Promise<GitHubTeamGrant> => {
  const target = requestId(appId), body = { id: requestId(input.id), version: requireDecimal(input.version), teamId: requestId(input.teamId), teamVersion: requireDecimal(input.teamVersion), expectedUserId: requestId(admission.userId) };
  return call(`${base(target)}/team-grants`, signal, admission, value => {
    const result = grant(value, target);
    if (result.id !== body.id || result.team.id !== body.teamId || result.team.version !== body.teamVersion) return malformed();
    return result;
  }, "POST", body, 201, true);
};
export const getGitHubAppGrantImpact = (appId: string, grantId: string, pageCursor: string | null, signal: AbortSignal, admission: Admission): Promise<GitHubGrantImpact> => {
  const target = requestId(appId), expected = requestId(grantId);
  return call(`${grantBase(target, expected)}/revocation-preview${query(pageCursor)}`, signal, admission, value => {
    const data = record(value); exact(data, ["appId", "grantId", "version", "impactVersion", "totalProjects", "visibleProjects", "hiddenProjects", "teams", "nextCursor"]);
    const app = id(data.appId), currentGrant = id(data.grantId), totalProjects = decimal(data.totalProjects, false), visibleProjects = decimal(data.visibleProjects, false), hiddenProjects = decimal(data.hiddenProjects, false);
    if (app !== target || currentGrant !== expected || BigInt(visibleProjects) + BigInt(hiddenProjects) !== BigInt(totalProjects)) return malformed();
    const teams = array(data.teams, item => { const row = record(item); exact(row, ["team", "projects"]); return { team: parseTeamRef(row.team), projects: decimal(row.projects, false) }; });
    unique(teams.map(item => item.team.id));
    return { appId: app, grantId: currentGrant, version: decimal(data.version), impactVersion: decimal(data.impactVersion), totalProjects, visibleProjects, hiddenProjects, teams, nextCursor: cursor(data.nextCursor) };
  });
};
export const listGitHubAppGrantImpactProjects = (appId: string, grantId: string, pageCursor: string | null, signal: AbortSignal, admission: Admission): Promise<GitHubImpactProjectPage> => {
  const target = requestId(appId), expected = requestId(grantId);
  return call(`${grantBase(target, expected)}/revocation-preview/projects${query(pageCursor)}`, signal, admission, value => {
    const data = record(value); exact(data, ["items", "hiddenProjects", "nextCursor"]);
    const items = array(data.items, value => { const item = record(value); exact(item, ["id", "name", "repoUrl"]); return { id: id(item.id), name: nonemptyString(item.name), repoUrl: nonemptyString(item.repoUrl) }; });
    unique(items.map(item => item.id));
    return { items, hiddenProjects: decimal(data.hiddenProjects, false), nextCursor: cursor(data.nextCursor) };
  });
};
export const revokeGitHubAppGrant = (appId: string, grantId: string, input: RevokeGitHubAppGrantInput, signal: AbortSignal, admission: Admission): Promise<{ readonly appId: string; readonly grantId: string; readonly revoked: true }> => {
  const target = requestId(appId), expected = requestId(grantId), body = { version: requireDecimal(input.version), impactVersion: requireDecimal(input.impactVersion), expectedUserId: requestId(admission.userId) };
  return call(`${grantBase(target, expected)}/revoke`, signal, admission, value => {
    const data = record(value); exact(data, ["appId", "grantId", "revoked"]);
    if (id(data.appId) !== target || id(data.grantId) !== expected || data.revoked !== true) return malformed();
    return { appId: target, grantId: expected, revoked: true as const };
  }, "POST", body, 200, true);
};
