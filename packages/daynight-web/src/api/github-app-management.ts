import { ApiError, assertResponsePrincipal, json, request, requestId, type TaskResponseAdmission } from "./client";
import { parseTeamRef } from "./team-parse";
import { array, id, malformed, nonemptyString, record, string, timestamp } from "./validation";
import type { TeamRef } from "./auth-types";

export type GitHubApp = {
  readonly id: string; readonly githubAppId: string; readonly name: string; readonly githubName: string; readonly githubSlug: string;
  readonly version: string; readonly administrators: string; readonly authorizedTeams: string; readonly connectedProjects: string;
  readonly webhookUrl: string; readonly createdAt: string; readonly updatedAt: string;
};
export type GitHubAppPage = { readonly items: readonly GitHubApp[]; readonly nextCursor: string | null };
export type GitHubAppImpact = {
  readonly appId: string; readonly grantId: null; readonly version: string; readonly impactVersion: string;
  readonly totalProjects: string; readonly visibleProjects: string; readonly hiddenProjects: string;
  readonly teams: readonly { readonly team: TeamRef; readonly projects: string }[]; readonly nextCursor: string | null;
};
export type GitHubImpactProjectPage = {
  readonly items: readonly { readonly id: string; readonly name: string; readonly repoUrl: string }[];
  readonly hiddenProjects: string; readonly nextCursor: string | null;
};
export type CreateGitHubAppInput = { readonly id: string; readonly name: string; readonly githubAppId: string; readonly privateKeyPem: string; readonly webhookSecret: string };
export type UpdateGitHubAppInput = { readonly version: string; readonly name?: string; readonly privateKeyPem?: string; readonly webhookSecret?: string };
export type RemoveGitHubAppInput = { readonly version: string; readonly impactVersion: string };

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
const name = (value: unknown): string => {
  const text = nonemptyString(value);
  if (!text.isWellFormed() || text.includes("\0") || !/[^\p{White_Space}]/u.test(text) || [...text].length > 256 || new TextEncoder().encode(text).length > 1024) return malformed();
  return text;
};
const secret = (value: unknown, maxBytes: number): string => {
  const text = string(value);
  if (!text.isWellFormed() || text.length === 0 || new TextEncoder().encode(text).length > maxBytes) return malformed();
  return text;
};
const input = <T>(fn: () => T): T => { try { return fn(); } catch { throw new ApiError("protocol"); } };
const parseApp = (value: unknown): GitHubApp => {
  const data = record(value);
  exact(data, ["id", "githubAppId", "name", "githubName", "githubSlug", "version", "administrators", "authorizedTeams", "connectedProjects", "webhookUrl", "createdAt", "updatedAt"]);
  const appId = id(data.id), webhookUrl = string(data.webhookUrl);
  let url: URL;
  try { url = new URL(webhookUrl); } catch { return malformed(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== `/api/v1/github/apps/${appId}/webhook`) return malformed();
  return { id: appId, githubAppId: decimal(data.githubAppId), name: name(data.name), githubName: nonemptyString(data.githubName), githubSlug: nonemptyString(data.githubSlug), version: decimal(data.version), administrators: decimal(data.administrators, false), authorizedTeams: decimal(data.authorizedTeams, false), connectedProjects: decimal(data.connectedProjects, false), webhookUrl, createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt) };
};
const unique = (values: readonly string[]) => { if (new Set(values).size !== values.length) return malformed(); };
const call = async <T>(url: string, signal: AbortSignal, admission: Admission, parse: (value: unknown) => T, method?: "POST" | "PATCH", body?: object, status = 200): Promise<T> => {
  const timeout = new AbortController();
  const lifetime = method === undefined ? signal : AbortSignal.any([signal, timeout.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await request(url, lifetime, { ...(method === undefined ? {} : { method }), headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, method === undefined ? undefined : () => {
      timer = setTimeout(() => timeout.abort(new DOMException("GitHub App request timed out.", "TimeoutError")), 50_000);
      admission.onDispatch?.();
    });
    assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
    if (response.ok && response.status !== status) throw new ApiError("protocol", response.status);
    return await json(response, lifetime, value => {
      const result = parse(value);
      if (method !== undefined) admission.onWriteConfirmed?.();
      return result;
    }, undefined, false, method === undefined ? undefined : admission.onWriteRejected);
  } finally { if (timer !== undefined) clearTimeout(timer); }
};
const base = "/api/v1/github/apps";
export const listGitHubApps = (pageCursor: string | null, signal: AbortSignal, admission: Admission): Promise<GitHubAppPage> => call(`${base}${query(pageCursor)}`, signal, admission, value => {
  const data = record(value); exact(data, ["items", "nextCursor"]);
  const items = array(data.items, parseApp); unique(items.map(item => item.id));
  return { items, nextCursor: cursor(data.nextCursor) };
});
export const getGitHubApp = (appId: string, signal: AbortSignal, admission: Admission): Promise<GitHubApp> => {
  const target = requestId(appId);
  return call(`${base}/${target}`, signal, admission, value => { const app = parseApp(value); if (app.id !== target) return malformed(); return app; });
};
export const createGitHubApp = (value: CreateGitHubAppInput, signal: AbortSignal, admission: Admission): Promise<GitHubApp> => {
  const body = input(() => ({ id: requestId(value.id), name: name(value.name), githubAppId: requireDecimal(value.githubAppId), privateKeyPem: secret(value.privateKeyPem, 65536), webhookSecret: secret(value.webhookSecret, 4096), expectedUserId: requestId(admission.userId) }));
  return call(base, signal, admission, data => { const app = parseApp(data); if (app.id !== body.id || app.githubAppId !== body.githubAppId || app.name !== body.name) return malformed(); return app; }, "POST", body, 201);
};
export const updateGitHubApp = (appId: string, value: UpdateGitHubAppInput, signal: AbortSignal, admission: Admission): Promise<GitHubApp> => {
  const target = requestId(appId), version = requireDecimal(value.version);
  const body = input(() => ({ version, expectedUserId: requestId(admission.userId), ...(value.name === undefined ? {} : { name: name(value.name) }), ...(value.privateKeyPem === undefined ? {} : { privateKeyPem: secret(value.privateKeyPem, 65536) }), ...(value.webhookSecret === undefined ? {} : { webhookSecret: secret(value.webhookSecret, 4096) }) }));
  if (value.name === undefined && value.privateKeyPem === undefined && value.webhookSecret === undefined) throw new ApiError("protocol");
  return call(`${base}/${target}`, signal, admission, data => {
    const app = parseApp(data), next = BigInt(app.version), previous = BigInt(version);
    if (app.id !== target || next !== previous && next !== previous + 1n || body.name !== undefined && app.name !== body.name) return malformed();
    return app;
  }, "PATCH", body);
};
export const getGitHubAppRemovalImpact = (appId: string, pageCursor: string | null, signal: AbortSignal, admission: Admission): Promise<GitHubAppImpact> => {
  const target = requestId(appId);
  return call(`${base}/${target}/removal-preview${query(pageCursor)}`, signal, admission, value => {
    const data = record(value); exact(data, ["appId", "grantId", "version", "impactVersion", "totalProjects", "visibleProjects", "hiddenProjects", "teams", "nextCursor"]);
    const appId = id(data.appId), totalProjects = decimal(data.totalProjects, false), visibleProjects = decimal(data.visibleProjects, false), hiddenProjects = decimal(data.hiddenProjects, false);
    if (appId !== target || data.grantId !== null || BigInt(visibleProjects) + BigInt(hiddenProjects) !== BigInt(totalProjects)) return malformed();
    const teams = array(data.teams, item => { const row = record(item); exact(row, ["team", "projects"]); return { team: parseTeamRef(row.team), projects: decimal(row.projects, false) }; });
    unique(teams.map(item => item.team.id));
    return { appId, grantId: null, version: decimal(data.version), impactVersion: decimal(data.impactVersion), totalProjects, visibleProjects, hiddenProjects, teams, nextCursor: cursor(data.nextCursor) };
  });
};
export const listGitHubAppRemovalProjects = (appId: string, pageCursor: string | null, signal: AbortSignal, admission: Admission): Promise<GitHubImpactProjectPage> => {
  const target = requestId(appId);
  return call(`${base}/${target}/removal-preview/projects${query(pageCursor)}`, signal, admission, value => {
    const data = record(value); exact(data, ["items", "hiddenProjects", "nextCursor"]);
    const items = array(data.items, value => { const item = record(value); exact(item, ["id", "name", "repoUrl"]); return { id: id(item.id), name: nonemptyString(item.name), repoUrl: nonemptyString(item.repoUrl) }; });
    unique(items.map(item => item.id));
    return { items, hiddenProjects: decimal(data.hiddenProjects, false), nextCursor: cursor(data.nextCursor) };
  });
};
export const removeGitHubApp = (appId: string, value: RemoveGitHubAppInput, signal: AbortSignal, admission: Admission): Promise<{ readonly appId: string; readonly removed: true }> => {
  const target = requestId(appId), body = { version: requireDecimal(value.version), impactVersion: requireDecimal(value.impactVersion), expectedUserId: requestId(admission.userId) };
  return call(`${base}/${target}/remove`, signal, admission, value => {
    const data = record(value); exact(data, ["appId", "removed"]);
    if (id(data.appId) !== target || data.removed !== true) return malformed();
    return { appId: target, removed: true as const };
  }, "POST", body);
};
