import { ApiError, assertResponsePrincipal, json, request, requestId, type TaskResponseAdmission } from "./client";
import { isGitHubPollInterval, type GitHubInstallationCandidate, type GitHubStatus } from "./github-integration";
import { array, boolean, id, malformed, nonemptyString, nullableTimestamp, record, string, timestamp } from "./validation";

export type TeamGitHubGrant = {
  readonly grantId: string;
  readonly app: { readonly id: string; readonly githubAppId: string; readonly name: string; readonly githubSlug: string; readonly version: string };
  readonly createdAt: string;
};
export type TeamGitHubApps = { readonly items: readonly TeamGitHubGrant[]; readonly nextCursor: string | null };
export type ProjectGitHubStatus = GitHubStatus & {
  readonly canManageConnection: boolean;
  readonly app: { readonly id: string; readonly githubAppId: string; readonly name: string; readonly githubSlug: string } | null;
  readonly grantId: string | null;
};
type Admission = TaskResponseAdmission;
type AppSelection = { readonly appResourceId: string; readonly appVersion: string; readonly grantId: string; readonly ownershipVersion: string };

const decimal = (value: unknown, positive = true): string => {
  const result = string(value);
  if (!/^(?:0|[1-9][0-9]*)$/.test(result) || result.length > 19 || BigInt(result) > 9_223_372_036_854_775_807n || positive && result === "0") return malformed();
  return result;
};
const requireDecimal = (value: string): void => { try { decimal(value); } catch { throw new ApiError("protocol"); } };
const app = (value: unknown) => {
  const data = record(value);
  return { id: id(data.id), githubAppId: decimal(data.githubAppId), name: nonemptyString(data.name), githubSlug: nonemptyString(data.githubSlug) };
};
const teamGrant = (value: unknown): TeamGitHubGrant => {
  const data = record(value), metadata = record(data.app);
  return { grantId: id(data.grantId), app: { ...app(metadata), version: decimal(metadata.version) }, createdAt: timestamp(data.createdAt) };
};
const parseTeamPage = (value: unknown): TeamGitHubApps => {
  const data = record(value), items = array(data.items, teamGrant);
  const nextCursor = data.nextCursor === null ? null : nonemptyString(data.nextCursor);
  if (new Set(items.map(item => item.grantId)).size !== items.length || new Set(items.map(item => item.app.id)).size !== items.length) return malformed();
  return { items, nextCursor };
};
const repository = (value: unknown) => {
  const data = record(value);
  return { id: decimal(data.id), fullName: nonemptyString(data.fullName), private: data.private === null ? null : boolean(data.private) };
};
const installation = (value: unknown) => {
  const data = record(value);
  return { id: decimal(data.id), accountLogin: nonemptyString(data.accountLogin) };
};
const syncError = (value: unknown) => {
  if (value === null) return null;
  const data = record(value);
  return { code: nonemptyString(data.code), message: string(data.message), at: nullableTimestamp(data.at) };
};
const parseStatus = (value: unknown, project: string): ProjectGitHubStatus => {
  const data = record(value), poll = record(data.poll), webhook = record(data.webhook);
  const connection = data.connection;
  if (connection !== "not_connected" && connection !== "connected" && connection !== "unavailable" && connection !== "disconnected") return malformed();
  if (typeof data.pollIntervalMinutes !== "number" || !isGitHubPollInterval(data.pollIntervalMinutes)) return malformed();
  const canManageConnection = boolean(data.canManageConnection);
  const result: ProjectGitHubStatus = {
    projectId: id(data.projectId), version: decimal(data.version), revision: decimal(data.revision, false),
    serviceAvailable: boolean(data.serviceAvailable), syncEnabled: boolean(data.syncEnabled), connection,
    repository: data.repository === null ? null : repository(data.repository), installation: data.installation === null ? null : installation(data.installation),
    pollIntervalMinutes: data.pollIntervalMinutes, initializing: boolean(data.initializing),
    poll: { running: boolean(poll.running), lastAttemptAt: nullableTimestamp(poll.lastAttemptAt), lastSuccessAt: nullableTimestamp(poll.lastSuccessAt), nextAttemptAt: nullableTimestamp(poll.nextAttemptAt), error: syncError(poll.error) },
    webhook: { running: boolean(webhook.running), lastReceivedAt: nullableTimestamp(webhook.lastReceivedAt), lastAttemptAt: nullableTimestamp(webhook.lastAttemptAt), lastSuccessAt: nullableTimestamp(webhook.lastSuccessAt), error: syncError(webhook.error) },
    canManageConnection, app: data.app === null ? null : app(data.app),
    grantId: !canManageConnection && data.grantId === undefined ? null : data.grantId === null ? null : id(data.grantId),
  };
  if (result.projectId !== project || connection === "connected" && (result.app === null || result.installation === null || result.repository === null || canManageConnection && result.grantId === null)) return malformed();
  return result;
};
const parseCandidate = (value: unknown): GitHubInstallationCandidate => {
  const data = record(value), repo = repository(data.repository);
  if (repo.private === null) return malformed();
  return { installation: installation(data.installation), repository: { ...repo, private: repo.private } };
};
const call = async <T>(url: string, signal: AbortSignal, admission: Admission, parse: (value: unknown) => T, method?: "POST" | "PATCH", body?: object, deadline = false): Promise<T> => {
  const timeout = new AbortController(), lifetime = deadline ? AbortSignal.any([signal, timeout.signal]) : signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await request(url, lifetime, {
      ...(method === undefined ? {} : { method }),
      headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, () => {
      if (deadline) timer = setTimeout(() => timeout.abort(new DOMException("GitHub request timed out.", "TimeoutError")), 50_000);
      admission.onDispatch?.();
    });
    assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
    if (response.ok && response.status !== 200) throw new ApiError("protocol", response.status);
    return await json(response, lifetime, value => {
      const result = parse(value);
      if (method !== undefined) admission.onWriteConfirmed?.();
      return result;
    }, undefined, false, admission.onWriteRejected);
  } finally { if (timer !== undefined) clearTimeout(timer); }
};

export const listTeamGitHubApps = (teamId: string, cursor: string | null, signal: AbortSignal, admission: Admission): Promise<TeamGitHubApps> => {
  const team = requestId(teamId), query = new URLSearchParams({ limit: "50" });
  if (cursor !== null) { if (cursor === "") throw new ApiError("protocol"); query.set("cursor", cursor); }
  return call(`/api/v1/teams/${team}/github/apps?${query}`, signal, admission, parseTeamPage);
};
export const getProjectGitHubStatus = (projectId: string, signal: AbortSignal, admission: Admission): Promise<ProjectGitHubStatus> => {
  const project = requestId(projectId);
  return call(`/api/v1/projects/${project}/github`, signal, admission, value => parseStatus(value, project));
};
const selection = (value: AppSelection): AppSelection => {
  requireDecimal(value.appVersion); requireDecimal(value.ownershipVersion);
  return { appResourceId: requestId(value.appResourceId), appVersion: value.appVersion, grantId: requestId(value.grantId), ownershipVersion: value.ownershipVersion };
};
export const discoverProjectGitHubInstallation = (projectId: string, input: AppSelection, signal: AbortSignal, admission: Admission): Promise<GitHubInstallationCandidate> => {
  const project = requestId(projectId), query = new URLSearchParams(selection(input));
  return call(`/api/v1/projects/${project}/github/installation?${query}`, signal, admission, parseCandidate, undefined, undefined, true);
};
const mutation = (projectId: string, path: string, version: string, body: object, signal: AbortSignal, admission: Admission, method: "POST" | "PATCH", accept: (status: ProjectGitHubStatus) => boolean, deadline = false): Promise<ProjectGitHubStatus> => {
  const project = requestId(projectId); requireDecimal(version);
  return call(`/api/v1/projects/${project}/github${path}`, signal, admission, value => {
    const status = parseStatus(value, project), next = BigInt(status.version), previous = BigInt(version);
    if (next !== previous && next !== previous + 1n || !accept(status)) return malformed();
    return status;
  }, method, body, deadline);
};
export const connectProjectGitHub = (projectId: string, input: AppSelection & { readonly version: string; readonly installationId: string }, signal: AbortSignal, admission: Admission): Promise<ProjectGitHubStatus> => {
  const selected = selection(input); requireDecimal(input.installationId);
  const body = { version: input.version, ownershipVersion: selected.ownershipVersion, appResourceId: selected.appResourceId, appVersion: selected.appVersion, grantId: selected.grantId, installationId: input.installationId };
  return mutation(projectId, "/connect", input.version, body, signal, admission, "POST", result => result.connection === "connected" && result.app?.id === selected.appResourceId && result.grantId === selected.grantId && result.installation?.id === input.installationId, true);
};
export const disconnectProjectGitHub = (projectId: string, input: { readonly version: string; readonly ownershipVersion: string }, signal: AbortSignal, admission: Admission): Promise<ProjectGitHubStatus> => {
  requireDecimal(input.ownershipVersion);
  return mutation(projectId, "/disconnect", input.version, input, signal, admission, "POST", result => (result.connection === "disconnected" || result.connection === "not_connected") && result.app === null && result.installation === null && result.grantId === null && !result.syncEnabled);
};
export const saveProjectGitHubSettings = (projectId: string, input: { readonly version: string; readonly pollIntervalMinutes: number }, signal: AbortSignal, admission: Admission): Promise<ProjectGitHubStatus> => {
  if (!isGitHubPollInterval(input.pollIntervalMinutes)) throw new ApiError("protocol");
  return mutation(projectId, "/settings", input.version, input, signal, admission, "PATCH", result => result.pollIntervalMinutes === input.pollIntervalMinutes);
};
export const updateProjectGitHubSync = (projectId: string, input: { readonly version: string; readonly syncEnabled: boolean }, signal: AbortSignal, admission: Admission): Promise<ProjectGitHubStatus> => {
  if (typeof input.syncEnabled !== "boolean") throw new ApiError("protocol");
  return mutation(projectId, "/sync", input.version, input, signal, admission, "PATCH", result => result.syncEnabled === input.syncEnabled);
};
