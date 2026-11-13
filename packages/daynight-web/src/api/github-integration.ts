import { ApiError, assertResponsePrincipal, json, request, requestId, type TaskResponseAdmission } from "./client";
import { boolean, id, malformed, nonemptyString, nullableTimestamp, record, string } from "./validation";

export type GitHubRepository = { readonly id: string; readonly fullName: string; readonly private: boolean | null };
export type GitHubInstallation = { readonly id: string; readonly accountLogin: string };
export type GitHubInstallationCandidate = { readonly installation: GitHubInstallation; readonly repository: GitHubRepository & { readonly private: boolean } };
export type GitHubSyncError = { readonly code: string; readonly message: string; readonly at: string | null };
export type GitHubStatus = {
  readonly projectId: string;
  readonly version: string;
  readonly revision: string;
  readonly serviceAvailable: boolean;
  readonly connection: "not_connected" | "connected" | "unavailable" | "disconnected";
  readonly repository: GitHubRepository | null;
  readonly installation: GitHubInstallation | null;
  readonly pollIntervalMinutes: number;
  readonly initializing: boolean;
  readonly poll: { readonly running: boolean; readonly lastAttemptAt: string | null; readonly lastSuccessAt: string | null; readonly nextAttemptAt: string | null; readonly error: GitHubSyncError | null };
  readonly webhook: { readonly running: boolean; readonly lastReceivedAt: string | null; readonly lastAttemptAt: string | null; readonly lastSuccessAt: string | null; readonly error: GitHubSyncError | null };
};

const decimal = (value: unknown, positive = true): string => {
  const result = string(value);
  if (!/^(?:0|[1-9][0-9]*)$/.test(result) || result.length > 19 || BigInt(result) > 9_223_372_036_854_775_807n || positive && result === "0") return malformed();
  return result;
};
export const isGitHubPollInterval = (value: number): boolean => Number.isInteger(value) && value >= 1 && value <= 2_147_483_647;
const repository = (value: unknown): GitHubRepository => {
  const data = record(value);
  return { id: decimal(data.id), fullName: nonemptyString(data.fullName), private: data.private === null ? null : boolean(data.private) };
};
const installation = (value: unknown): GitHubInstallation => {
  const data = record(value);
  return { id: decimal(data.id), accountLogin: nonemptyString(data.accountLogin) };
};
const syncError = (value: unknown): GitHubSyncError | null => {
  if (value === null) return null;
  const data = record(value);
  return { code: nonemptyString(data.code), message: string(data.message), at: nullableTimestamp(data.at) };
};
const parseCandidate = (value: unknown): GitHubInstallationCandidate => {
  const data = record(value), repo = repository(data.repository);
  if (repo.private === null) return malformed();
  return { installation: installation(data.installation), repository: { ...repo, private: repo.private } };
};
const parseStatus = (value: unknown, projectId: string): GitHubStatus => {
  const data = record(value), poll = record(data.poll), webhook = record(data.webhook);
  const connection = data.connection;
  if (connection !== "not_connected" && connection !== "connected" && connection !== "unavailable" && connection !== "disconnected") return malformed();
  if (typeof data.pollIntervalMinutes !== "number" || !isGitHubPollInterval(data.pollIntervalMinutes)) return malformed();
  const result: GitHubStatus = {
    projectId: id(data.projectId), version: decimal(data.version), revision: decimal(data.revision, false),
    serviceAvailable: boolean(data.serviceAvailable), connection,
    repository: data.repository === null ? null : repository(data.repository), installation: data.installation === null ? null : installation(data.installation),
    pollIntervalMinutes: data.pollIntervalMinutes, initializing: boolean(data.initializing),
    poll: { running: boolean(poll.running), lastAttemptAt: nullableTimestamp(poll.lastAttemptAt), lastSuccessAt: nullableTimestamp(poll.lastSuccessAt), nextAttemptAt: nullableTimestamp(poll.nextAttemptAt), error: syncError(poll.error) },
    webhook: { running: boolean(webhook.running), lastReceivedAt: nullableTimestamp(webhook.lastReceivedAt), lastAttemptAt: nullableTimestamp(webhook.lastAttemptAt), lastSuccessAt: nullableTimestamp(webhook.lastSuccessAt), error: syncError(webhook.error) },
  };
  if (result.projectId !== projectId || (connection === "not_connected") !== (result.installation === null)) return malformed();
  return result;
};

const outgoingDecimal = (value: string): void => {
  try { decimal(value); } catch { throw new ApiError("protocol"); }
};

type Admission = TaskResponseAdmission;
const call = async <T,>(projectId: string, path: string, signal: AbortSignal, admission: Admission, parse: (value: unknown, project: string) => T, method?: "POST" | "PATCH", body?: object, deadline = false): Promise<T> => {
  const project = requestId(projectId);
  const timeout = new AbortController();
  const lifetime = deadline ? AbortSignal.any([signal, timeout.signal]) : signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await request(`/api/v1/projects/${project}/github${path}`, lifetime, {
      ...(method === undefined ? {} : { method }),
      headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, () => {
      if (deadline) timer = setTimeout(() => timeout.abort(new DOMException("GitHub request timed out.", "TimeoutError")), 50_000);
      admission.onDispatch?.();
    });
    assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
    if (response.ok && response.status !== 200) throw new ApiError("protocol", response.status);
    return await json(response, lifetime, (value) => {
      const result = parse(value, project);
      if (method !== undefined) admission.onWriteConfirmed?.();
      return result;
    }, undefined, false, admission.onWriteRejected);
  } finally { if (timer !== undefined) clearTimeout(timer); }
};

export const getGitHubStatus = (projectId: string, signal: AbortSignal, admission: Admission): Promise<GitHubStatus> =>
  call(projectId, "", signal, admission, parseStatus);
export const discoverGitHubInstallation = (projectId: string, signal: AbortSignal, admission: Admission): Promise<GitHubInstallationCandidate> =>
  call(projectId, "/installation", signal, admission, parseCandidate, undefined, undefined, true);

const mutationParser = (version: string, accept: (status: GitHubStatus) => boolean) => (value: unknown, project: string): GitHubStatus => {
  const result = parseStatus(value, project);
  if ((BigInt(result.version) !== BigInt(version) && BigInt(result.version) !== BigInt(version) + 1n) || !accept(result)) return malformed();
  return result;
};
export const connectGitHub = (projectId: string, input: { readonly version: string; readonly installationId: string }, signal: AbortSignal, admission: Admission): Promise<GitHubStatus> => {
  outgoingDecimal(input.version); outgoingDecimal(input.installationId);
  return call(projectId, "/connect", signal, admission, mutationParser(input.version, (value) => value.connection === "connected" && value.installation?.id === input.installationId && value.repository !== null), "POST", input, true);
};
export const disconnectGitHub = (projectId: string, input: { readonly version: string }, signal: AbortSignal, admission: Admission): Promise<GitHubStatus> => {
  outgoingDecimal(input.version);
  return call(projectId, "/disconnect", signal, admission, mutationParser(input.version, (value) => value.connection === "disconnected" || value.connection === "not_connected"), "POST", input);
};
export const saveGitHubSettings = (projectId: string, input: { readonly version: string; readonly pollIntervalMinutes: number }, signal: AbortSignal, admission: Admission): Promise<GitHubStatus> => {
  outgoingDecimal(input.version);
  if (!isGitHubPollInterval(input.pollIntervalMinutes)) throw new ApiError("protocol");
  return call(projectId, "/settings", signal, admission, mutationParser(input.version, (value) => value.pollIntervalMinutes === input.pollIntervalMinutes), "PATCH", input);
};

export type GitHubPullRequestCounts = {
  readonly projectId: string;
  readonly revision: string;
  readonly total: string;
  readonly counts: { readonly active: string; readonly closed: string; readonly merged: string; readonly all: string };
};
export const getGitHubPullRequestCounts = async (projectId: string, signal: AbortSignal, admission: Admission): Promise<GitHubPullRequestCounts> => {
  const project = requestId(projectId);
  const response = await request(`/api/v1/projects/${project}/pull-requests?state=all&limit=1`, signal, { headers: { Accept: "application/json" } }, admission.onDispatch);
  assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  if (response.ok && response.status !== 200) throw new ApiError("protocol", response.status);
  return json(response, signal, (value) => {
    const data = record(value), counts = record(data.counts);
    const result = { projectId: id(data.projectId), revision: decimal(data.revision, false), total: decimal(data.total, false), counts: { active: decimal(counts.active, false), closed: decimal(counts.closed, false), merged: decimal(counts.merged, false), all: decimal(counts.all, false) } };
    if (result.projectId !== project || !Array.isArray(data.items) || data.items.length > 1 ||
      (data.nextCursor !== null && typeof data.nextCursor !== "string") || (data.previousCursor !== null && typeof data.previousCursor !== "string") ||
      result.total !== result.counts.all || BigInt(result.counts.active) + BigInt(result.counts.closed) + BigInt(result.counts.merged) !== BigInt(result.counts.all)) return malformed();
    return result;
  });
};
