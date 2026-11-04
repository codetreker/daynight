import { isText } from "../platform/text.js";
import type { ErrorDetails, GraphTask, Page, Project, ProjectAccess, ProjectGrant, ProjectParticipant, ServerError, Task, TaskAttachment, TaskGraph, TaskGraphSummary, TaskPlatform, TaskStatus, Team, TeamRef, ProjectOwnership, User, WorkerReportReceipt } from "./types.js";

export { canonicalId, ProtocolError } from "./validation.js";
import { array, bool, canonicalId, count, fields, id, malformed, nullableTimestamp, record, resourceVersion, text, timestamp } from "./validation.js";
import { parseTaskProperties, readWorkerClaim } from "./task-properties.js";
import type { ProjectInvitationInspection, ProjectInvitationAcceptance, TeamInvitationInspection, TeamInvitationAcceptance, TeamInvitationMember } from "./types.js";

const ids = (value: unknown): string[] => {
  const parsed = array(value, id);
  if (new Set(parsed).size !== parsed.length) return malformed();
  return parsed;
};
const dependencyIds = (value: unknown): string[] => {
  const parsed = ids(value);
  if (parsed.some((value, index) => index > 0 && parsed[index - 1]! > value)) return malformed();
  return parsed;
};
const status = (value: unknown): TaskStatus => value === "todo" || value === "in_progress" || value === "done" ? value : malformed();
const requiredPlatform = (value: unknown): TaskPlatform | null => value === null || value === "windows" || value === "linux" || value === "macos" ? value : malformed();

const validAttachmentPath = (value: string): boolean => isText(value) && !/^[A-Za-z]:\//.test(value) && !/[\\\p{Cc}]/u.test(value) && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
export const validateAttachmentPath = (value: string): string => {
  if (!validAttachmentPath(value)) throw new Error("Attachment path must be a valid relative path with nonempty segments and no dot segments, backslashes or control characters.");
  return value;
};

export const parseTaskAttachment = (value: unknown, expectedPath?: string): TaskAttachment => {
  const data = record(value);
  const path = text(data.path);
  if (!validAttachmentPath(path)) return malformed();
  const parsed = { path, contentType: text(data.contentType, true), sizeBytes: count(data.sizeBytes), createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt) };
  if (expectedPath !== undefined && parsed.path !== expectedPath) return malformed();
  return parsed;
};

const projectSettings = (value: unknown): Project["settings"] => {
  const data = record(value);
  const executionWarningMinutes = count(data.executionWarningMinutes);
  if (executionWarningMinutes < 1 || executionWarningMinutes > 2_147_483_647) return malformed();
  return { version: resourceVersion(data.version), executionWarningMinutes };
};

const parseTeamRef = (value: unknown): TeamRef => {
  const data = fields(value, ["id", "kind", "name"]);
  const team: TeamRef = { id: id(data.id), kind: data.kind === "personal" || data.kind === "ordinary" ? data.kind : malformed(), name: data.name === null ? null : text(data.name, true) };
  if ((team.kind === "personal") !== (team.name === null)) return malformed();
  return team;
};
export const parseTeam = (value: unknown, userId: string, teamId?: string): Team => {
  const data = fields(value, ["id", "kind", "name", "version", "createdAt", "updatedAt", "membership"]);
  const ref = parseTeamRef({ id: data.id, kind: data.kind, name: data.name });
  const member = fields(data.membership, ["teamId", "userId", "role", "version", "createdAt", "updatedAt"]);
  const membership: Team["membership"] = {
    teamId: id(member.teamId), userId: id(member.userId),
    role: member.role === "member" || member.role === "admin" ? member.role : malformed(),
    version: resourceVersion(member.version), createdAt: timestamp(member.createdAt), updatedAt: timestamp(member.updatedAt),
  };
  if (membership.teamId !== ref.id || membership.userId !== userId || teamId !== undefined && ref.id !== teamId || ref.kind === "personal" && membership.role !== "admin") return malformed();
  return { ...ref, version: resourceVersion(data.version), createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt), membership };
};
export const parseTeamDeleteReceipt = (value: unknown, teamId: string): { readonly teamId: string; readonly deleted: true } => {
  const data = fields(value, ["teamId", "deleted"]);
  if (id(data.teamId) !== teamId || data.deleted !== true) return malformed();
  return { teamId, deleted: true };
};
const parseOwnership = (value: unknown): ProjectOwnership => {
  const data = fields(value, ["teamId", "version"]);
  return { teamId: id(data.teamId), version: resourceVersion(data.version) };
};

export const parseProject = (value: unknown, expectedId?: string): Project => {
  const data = record(value);
  const parsed = { id: id(data.id), name: text(data.name, true), repoUrl: text(data.repoUrl, true), settings: projectSettings(data.settings), ownership: parseOwnership(data.ownership), createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt) };
  if (expectedId !== undefined && parsed.id !== expectedId) return malformed();
  return parsed;
};

const dependencyState = (data: Record<string, unknown>) => {
  const parsed = { id: id(data.id), status: status(data.status), allowAgents: bool(data.allowAgents), requiredPlatform: requiredPlatform(data.requiredPlatform), assignedTo: data.assignedTo === null ? null : id(data.assignedTo), startedAt: nullableTimestamp(data.startedAt), completedAt: nullableTimestamp(data.completedAt), dependsOn: dependencyIds(data.dependsOn), externalDependsOn: dependencyIds(data.externalDependsOn), blockedBy: ids(data.blockedBy), ready: bool(data.ready), createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt) };
  const dependencies = new Set(parsed.dependsOn);
  if (dependencies.has(parsed.id) || parsed.externalDependsOn.some((item) => !dependencies.has(item)) || parsed.blockedBy.some((item) => !dependencies.has(item)) || parsed.ready !== (parsed.status === "todo" && parsed.blockedBy.length === 0)) return malformed();
  if ((parsed.status === "in_progress" || parsed.status === "done") && parsed.blockedBy.length > 0) return malformed();
  return parsed;
};

export const parseWorkerReportReceipt = (value: unknown): WorkerReportReceipt => {
  const data = fields(value, ["observedAt", "lastReportedAt"]);
  const parsed = { observedAt: timestamp(data.observedAt), lastReportedAt: timestamp(data.lastReportedAt) };
  if (Object.values(parsed).some((value) => /^0001-01-01T00:00:00(?:\.0{1,9})?Z$/.test(value))) return malformed();
  return parsed;
};
export const parseUser = (value: unknown): User => {
  const data = fields(value, ["id", "email", "emailVerified", "name", "avatarUrl", "personalTeam"]);
  const personalTeam = parseTeamRef(data.personalTeam);
  if (personalTeam.kind !== "personal") return malformed();
  return {
    personalTeam, id: id(data.id), email: data.email === null ? null : text(data.email),
    emailVerified: data.emailVerified === null ? null : bool(data.emailVerified),
    name: data.name === null ? null : text(data.name), avatarUrl: data.avatarUrl === null ? null : text(data.avatarUrl),
  };
};
const projectRole = (value: unknown): ProjectAccess["effectiveRole"] => value === "admin" || value === "member" ? value : malformed();
const parseProjectGrant = (value: unknown, projectId: string, userId?: string): ProjectGrant => {
  const grant = fields(value, ["projectId", "userId", "role", "version", "createdAt", "updatedAt"]);
  const parsed: ProjectGrant = {
    projectId: id(grant.projectId), userId: id(grant.userId),
    role: projectRole(grant.role),
    version: resourceVersion(grant.version), createdAt: timestamp(grant.createdAt), updatedAt: timestamp(grant.updatedAt),
  };
  if (parsed.projectId !== projectId || userId !== undefined && parsed.userId !== userId) return malformed();
  return parsed;
};
const sameGrant = (a: ProjectGrant | null, b: ProjectGrant | null): boolean => a === null || b === null ? a === b : a.projectId === b.projectId && a.userId === b.userId && a.role === b.role && a.version === b.version && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt;
export const parseProjectInvitationInspection = (value: unknown, userId: string): ProjectInvitationInspection => {
  const data = fields(value, ["projectId", "projectName", "directGrant", "access"]), projectId = id(data.projectId);
  const directGrant = data.directGrant === null ? null : parseProjectGrant(data.directGrant, projectId, userId);
  const access = data.access === null ? null : parseProjectAccess(data.access, projectId, userId);
  if (!sameGrant(directGrant, access?.directGrant ?? null)) return malformed();
  return { projectId, projectName: text(data.projectName, true), directGrant, access };
};
export const parseProjectInvitationAcceptance = (value: unknown, userId: string, targetId: string): ProjectInvitationAcceptance => {
  const data = fields(value, ["projectId", "directGrant", "access", "joined", "consumed"]), projectId = id(data.projectId);
  const directGrant = parseProjectGrant(data.directGrant, projectId, userId), access = parseProjectAccess(data.access, projectId, userId);
  const joined = bool(data.joined), consumed = bool(data.consumed);
  if (projectId !== targetId || !sameGrant(directGrant, access.directGrant) || joined !== consumed || joined && directGrant.role !== "member") return malformed();
  return { projectId, directGrant, access, joined, consumed };
};
const parseInvitationMember = (value: unknown, teamId: string, userId: string): TeamInvitationMember => {
  const data = fields(value, ["teamId", "userId", "role", "version", "createdAt", "updatedAt"]);
  const member = { teamId: id(data.teamId), userId: id(data.userId), role: projectRole(data.role), version: resourceVersion(data.version), createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt) };
  if (member.teamId !== teamId || member.userId !== userId) return malformed();
  return member;
};
export const parseTeamInvitationInspection = (value: unknown, userId: string): TeamInvitationInspection => {
  const data = fields(value, ["team", "membership"]), team = parseTeamRef(data.team);
  if (team.kind !== "ordinary") return malformed();
  return { team, membership: data.membership === null ? null : parseInvitationMember(data.membership, team.id, userId) };
};
export const parseTeamInvitationAcceptance = (value: unknown, userId: string, targetId: string): TeamInvitationAcceptance => {
  const data = fields(value, ["team", "membership", "joined", "consumed"]), team = parseTeamRef(data.team);
  const membership = parseInvitationMember(data.membership, team.id, userId), joined = bool(data.joined), consumed = bool(data.consumed);
  if (team.kind !== "ordinary" || team.id !== targetId || joined !== consumed || joined && membership.role !== "member") return malformed();
  return { team, membership, joined, consumed };
};
const effectiveRole = (teamRole: ProjectAccess["teamRole"], directGrant: ProjectGrant | null): ProjectAccess["effectiveRole"] => {
  if (teamRole === "admin" || directGrant?.role === "admin") return "admin";
  if (teamRole === "member" || directGrant?.role === "member") return "member";
  return malformed();
};
export const parseProjectAccess = (value: unknown, projectId: string, userId?: string): ProjectAccess => {
  const data = fields(value, ["projectId", "ownerTeam", "ownership", "effectiveRole", "teamRole", "directGrant", "canTransfer"]);
  const access: ProjectAccess = {
    projectId: id(data.projectId), ownerTeam: parseTeamRef(data.ownerTeam), ownership: parseOwnership(data.ownership),
    effectiveRole: projectRole(data.effectiveRole), teamRole: data.teamRole === null ? null : projectRole(data.teamRole),
    directGrant: data.directGrant === null ? null : parseProjectGrant(data.directGrant, projectId, userId), canTransfer: bool(data.canTransfer),
  };
  if (access.projectId !== projectId || access.ownerTeam.id !== access.ownership.teamId || access.canTransfer !== (access.teamRole === "admin") || access.effectiveRole !== effectiveRole(access.teamRole, access.directGrant)) return malformed();
  return access;
};
export const parseCreatedProject = (value: unknown, userId: string, teamId?: string): Project => {
  const data = fields(value, ["id", "name", "repoUrl", "settings", "ownership", "createdAt", "updatedAt", "access"]);
  const project = parseProject(data);
  const access = parseProjectAccess(data.access, project.id, userId);
  if (teamId !== undefined && teamId !== project.ownership.teamId || access.ownership.teamId !== project.ownership.teamId || access.ownership.version !== project.ownership.version || access.directGrant?.role !== "admin" || access.teamRole === null) return malformed();
  return project;
};
export const parseProjectParticipants = (value: unknown, projectId: string, actorUserId?: string): readonly ProjectParticipant[] => {
  const data = fields(value, ["items", "actorAccess"]);
  const actorAccess = parseProjectAccess(data.actorAccess, projectId, actorUserId);
  const participants = array(data.items, (value): ProjectParticipant => {
    const participant = fields(value, ["userId", "profile", "effectiveRole", "inheritedFrom", "directGrant"]);
    const userId = id(participant.userId);
    const profile = fields(participant.profile, ["name", "email", "avatarUrl"]);
    const inherited = participant.inheritedFrom === null ? null : fields(participant.inheritedFrom, ["team", "role"]);
    const inheritedFrom = inherited === null ? null : { team: parseTeamRef(inherited.team), role: projectRole(inherited.role) };
    const directGrant = participant.directGrant === null ? null : parseProjectGrant(participant.directGrant, projectId, userId);
    const role = projectRole(participant.effectiveRole);
    if (inheritedFrom !== null && (inheritedFrom.team.id !== actorAccess.ownerTeam.id || inheritedFrom.team.kind !== actorAccess.ownerTeam.kind || inheritedFrom.team.name !== actorAccess.ownerTeam.name)) return malformed();
    if (role !== effectiveRole(inheritedFrom?.role ?? null, directGrant)) return malformed();
    return {
      userId, profile: { name: profile.name === null ? null : text(profile.name), email: profile.email === null ? null : text(profile.email), avatarUrl: profile.avatarUrl === null ? null : text(profile.avatarUrl) },
      effectiveRole: role, inheritedFrom, directGrant,
    };
  });
  if (new Set(participants.map(({ userId }) => userId)).size !== participants.length) return malformed();
  return participants;
};
export const parseTask = (value: unknown, projectId: string, taskId?: string): Task => {
  const data = record(value);
  const version = resourceVersion(data.version);
  const parsed = { ...dependencyState(data), projectId: id(data.projectId), title: text(data.title, true), description: text(data.description), properties: parseTaskProperties(data.properties), version };
  if (parsed.projectId !== projectId || (taskId !== undefined && parsed.id !== taskId)) return malformed();
  const worker = readWorkerClaim(parsed.properties);
  if (worker?.state === "active" && parsed.status !== "in_progress") return malformed();
  if (worker?.state === "released" && parsed.status !== "todo") return malformed();
  return parsed;
};

export const parsePage = <T>(value: unknown, parse: (item: unknown) => T, identity: (item: T) => string): Page<T> => {
  const data = record(value);
  const items = array(data.items, parse);
  if (items.length > 100 || new Set(items.map((item) => identity(item))).size !== items.length) return malformed();
  let nextCursor: string | null = null;
  if (data.nextCursor !== null) {
    nextCursor = text(data.nextCursor, true);
    if (items.length === 0) return malformed();
  }
  return { items, nextCursor };
};

const graphTask = (value: unknown): GraphTask => {
  const data = record(value);
  const parsed = { ...dependencyState(data), titlePreview: text(data.titlePreview), titleTruncated: bool(data.titleTruncated) };
  const characters = Array.from(parsed.titlePreview).length;
  if (characters === 0 || characters > 160 || (parsed.titleTruncated && characters !== 160)) return malformed();
  return parsed;
};
const summary = (value: unknown): TaskGraphSummary => {
  const data = record(value);
  return { total: count(data.total), todo: count(data.todo), inProgress: count(data.inProgress), done: count(data.done), ready: count(data.ready), blocked: count(data.blocked) };
};

const graphChainMembers = (byId: ReadonlyMap<string, GraphTask>, taskId: string): Set<string> => {
  if (!byId.has(taskId)) return malformed();
  const neighbors = new Map(Array.from(byId.keys(), (id) => [id, new Set<string>()]));
  for (const task of byId.values()) {
    for (const dependency of task.dependsOn) {
      if (task.externalDependsOn.includes(dependency) || !byId.has(dependency)) continue;
      neighbors.get(task.id)!.add(dependency);
      neighbors.get(dependency)!.add(task.id);
    }
  }
  const members = new Set<string>();
  const pending = [taskId];
  for (const current of pending) {
    if (members.has(current)) continue;
    members.add(current);
    pending.push(...neighbors.get(current)!);
  }
  return members;
};

export const parseTaskGraph = (value: unknown, projectId: string, taskId: string): TaskGraph => {
  const data = record(value);
  const parsed = { observedAt: timestamp(data.observedAt), project: parseProject(data.project, projectId), summary: summary(data.summary), tasks: array(data.tasks, graphTask) };
  const byId = new Map(parsed.tasks.map((task) => [task.id, task]));
  if (parsed.tasks.length > 1000 || byId.size !== parsed.tasks.length || parsed.tasks.reduce((sum, task) => sum + task.dependsOn.length, 0) > 5000) return malformed();
  const members = graphChainMembers(byId, taskId);
  const selected = new Set(members);
  for (const member of members) {
    const task = byId.get(member)!;
    if (task.dependsOn.some((dependency) => !byId.has(dependency))) return malformed();
    task.externalDependsOn.forEach((dependency) => selected.add(dependency));
  }
  if (selected.size !== byId.size || Array.from(selected).some((id) => !byId.has(id))) return malformed();
  const expected = { total: parsed.tasks.length, todo: 0, inProgress: 0, done: 0, ready: 0, blocked: 0 };
  for (const task of parsed.tasks) {
    if (task.status === "todo") { expected.todo++; if (task.ready) expected.ready++; else expected.blocked++; }
    else if (task.status === "in_progress") expected.inProgress++;
    else expected.done++;
    for (const dependency of task.dependsOn) {
      const target = byId.get(dependency);
      if (target !== undefined && task.blockedBy.includes(dependency) !== (target.status !== "done")) return malformed();
    }
  }
  for (const key of Object.keys(expected) as (keyof TaskGraphSummary)[]) if (expected[key] !== parsed.summary[key]) return malformed();
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (taskId: string): void => {
    if (active.has(taskId)) return malformed();
    if (visited.has(taskId)) return;
    active.add(taskId);
    for (const dependency of byId.get(taskId)!.dependsOn) if (byId.has(dependency)) visit(dependency);
    active.delete(taskId);
    visited.add(taskId);
  };
  for (const task of parsed.tasks) visit(task.id);
  return parsed;
};

export const parseServerError = (value: unknown): ServerError => {
  const data = record(record(value).error);
  const code = text(data.code, true);
  const requestId = text(data.requestId, true);
  const message = text(data.message, true);
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(code) || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(requestId)) return malformed();
  let details: ErrorDetails | undefined;
  if (data.details !== undefined) {
    const raw = record(data.details);
    details = {
      ...(raw.taskIds === undefined ? {} : { taskIds: ids(raw.taskIds) }),
      ...(raw.encodedBytes === undefined ? {} : { encodedBytes: count(raw.encodedBytes) }),
      ...(raw.maxEncodedBytes === undefined ? {} : { maxEncodedBytes: count(raw.maxEncodedBytes) }),
      ...(raw.nodeCount === undefined ? {} : { nodeCount: count(raw.nodeCount) }),
      ...(raw.edgeCount === undefined ? {} : { edgeCount: count(raw.edgeCount) }),
      ...(raw.maxNodes === undefined ? {} : { maxNodes: count(raw.maxNodes) }),
      ...(raw.maxEdges === undefined ? {} : { maxEdges: count(raw.maxEdges) }),
    };
  }
  if (code === "graph_limit_exceeded" && (details?.nodeCount === undefined || details.edgeCount === undefined || details.maxNodes !== 1000 || details.maxEdges !== 5000 || (details.nodeCount <= details.maxNodes && details.edgeCount <= details.maxEdges))) return malformed();
  if (code === "steps_limit_exceeded" && (details?.encodedBytes === undefined || details.maxEncodedBytes !== 67_108_864 || details.encodedBytes <= details.maxEncodedBytes)) return malformed();
  return { code, message, requestId, ...(details === undefined ? {} : { details }) };
};
