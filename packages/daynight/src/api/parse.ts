import { isText } from "../platform/text.js";
import type { ErrorDetails, TagReference, TaskSearchField, TaskSearchItem, TaskSearchPage, GraphTask, Page, Project, ProjectAccess, ProjectGrant, ProjectParticipant, ProjectTransferPreview, ProjectTransferReceipt, ProjectDeletionPreview, ProjectDeletionReceipt, ServerError, Task, TaskAttachment, TaskGraph, TaskGraphSummary, TaskPlatform, TaskStatus, Team, TeamRef, TeamMember, TeamMemberWithProfile, TeamMemberRoleReceipt, RemoveTeamMemberReceipt, TeamRole, ProjectOwnership, User, WorkerReportReceipt } from "./types.js";
import { parseTagName } from "./tags.js";

export { canonicalId, ProtocolError } from "./validation.js";
import { array, bool, canonicalId, count, fields, id, malformed, nullableTimestamp, record, resourceVersion, text, timestamp } from "./validation.js";
import { parseTaskProperties, readWorkerClaim } from "./task-properties.js";
import { isTaskStatus, isTerminalTaskStatus, requiresSatisfiedPrerequisites } from "../task/status.js";
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
const status = (value: unknown): TaskStatus => isTaskStatus(value) ? value : malformed();
const cancellationTime = (taskStatus: TaskStatus, value: unknown): string | null => {
  const parsed = nullableTimestamp(value);
  if ((taskStatus === "cancelled") !== (parsed !== null)) return malformed();
  return parsed;
};
const requiredPlatform = (value: unknown): TaskPlatform | null => value === null || value === "windows" || value === "linux" || value === "macos" ? value : malformed();
const resourceType = (data: Record<string, unknown>): { type: "task" | "goal"; parentId: string | null } => {
  const type = data.type === "task" || data.type === "goal" ? data.type : malformed();
  const parentId = data.parentId === null ? null : id(data.parentId);
  if (type === "goal" && parentId !== null) return malformed();
  return { type, parentId };
};

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
const teamRole = (value: unknown): TeamRole => value === "member" || value === "admin" ? value : malformed();
const parseTeamMember = (value: unknown, teamId: string, userId?: string): TeamMember => {
  const member = fields(value, ["teamId", "userId", "role", "version", "createdAt", "updatedAt"]);
  const parsed = { teamId: id(member.teamId), userId: id(member.userId), role: teamRole(member.role), version: resourceVersion(member.version), createdAt: timestamp(member.createdAt), updatedAt: timestamp(member.updatedAt) };
  if (parsed.teamId !== teamId || userId !== undefined && parsed.userId !== userId) return malformed();
  return parsed;
};
export const parseTeam = (value: unknown, userId: string, teamId?: string): Team => {
  const data = fields(value, ["id", "kind", "name", "version", "createdAt", "updatedAt", "membership"]);
  const ref = parseTeamRef({ id: data.id, kind: data.kind, name: data.name });
  const membership = parseTeamMember(data.membership, ref.id, userId);
  if (teamId !== undefined && ref.id !== teamId || ref.kind === "personal" && membership.role !== "admin") return malformed();
  return { ...ref, version: resourceVersion(data.version), createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt), membership };
};
export const parseTeamMembers = (value: unknown, teamId: string, actorId: string): readonly TeamMemberWithProfile[] => {
  const data = fields(value, ["items"]);
  const items = array(data.items, (value): TeamMemberWithProfile => {
    const item = fields(value, ["teamId", "userId", "role", "version", "createdAt", "updatedAt", "profile"]);
    const { profile: rawProfile, ...rawMember } = item;
    const member = parseTeamMember(rawMember, teamId);
    const profile = fields(rawProfile, ["name", "email", "avatarUrl"]);
    return { ...member, profile: { name: profile.name === null ? null : text(profile.name), email: profile.email === null ? null : text(profile.email), avatarUrl: profile.avatarUrl === null ? null : text(profile.avatarUrl) } };
  });
  if (new Set(items.map((item) => item.userId)).size !== items.length || !items.some((item) => item.userId === actorId)) return malformed();
  return items;
};
export const parseTeamMemberRoleReceipt = (value: unknown, actorId: string, previous: TeamMember, role: TeamRole): TeamMemberRoleReceipt => {
  const data = fields(value, ["membership", "actorRole"]);
  const membership = parseTeamMember(data.membership, previous.teamId, previous.userId);
  const actorRole = teamRole(data.actorRole);
  if (membership.role !== role || membership.createdAt !== previous.createdAt || (previous.role === role ? membership.version !== previous.version || membership.updatedAt !== previous.updatedAt : membership.version <= previous.version) || actorRole !== (actorId === previous.userId ? role : "admin")) return malformed();
  return { membership, actorRole };
};
export const parseRemoveTeamMemberReceipt = (value: unknown, actorId: string, member: TeamMember): RemoveTeamMemberReceipt => {
  const data = fields(value, ["teamId", "userId", "removed", "actorRole"]);
  const teamId = id(data.teamId), userId = id(data.userId);
  const actorRole = data.actorRole === null ? null : teamRole(data.actorRole);
  if (teamId !== member.teamId || userId !== member.userId || data.removed !== true || (userId === actorId ? actorRole !== null : actorRole !== "admin")) return malformed();
  return { teamId, userId, removed: true, actorRole };
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
  const parsedStatus = status(data.status);
  const parsed = { id: id(data.id), ...resourceType(data), status: parsedStatus, allowAgents: bool(data.allowAgents), requiredPlatform: requiredPlatform(data.requiredPlatform), assignedTo: data.assignedTo === null ? null : id(data.assignedTo), startedAt: nullableTimestamp(data.startedAt), completedAt: nullableTimestamp(data.completedAt), cancelledAt: cancellationTime(parsedStatus, data.cancelledAt), dependsOn: dependencyIds(data.dependsOn), externalDependsOn: dependencyIds(data.externalDependsOn), blockedBy: ids(data.blockedBy), ready: bool(data.ready), createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt) };
  const dependencies = new Set(parsed.dependsOn);
  if (dependencies.has(parsed.id) || parsed.externalDependsOn.some((item) => !dependencies.has(item)) || parsed.blockedBy.some((item) => !dependencies.has(item))) return malformed();
  if (parsed.type === "goal") {
    if (parsed.status === "proposed" || parsed.ready || parsed.allowAgents || parsed.requiredPlatform !== null || parsed.dependsOn.length || parsed.blockedBy.length) return malformed();
  } else if (parsed.ready !== (parsed.status === "todo" && parsed.blockedBy.length === 0)) return malformed();
  if (requiresSatisfiedPrerequisites(parsed.status) && parsed.blockedBy.length > 0) return malformed();
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
const sameTeamRef = (a: TeamRef, b: TeamRef): boolean => a.id === b.id && a.kind === b.kind && a.name === b.name;
export const parseProjectDeletionPreview = (value: unknown, projectId: string): ProjectDeletionPreview => {
  const data = fields(value, ["observedAt", "project", "summary", "activeClaims", "nextCursor"]);
  const project = fields(data.project, ["id", "name", "repoUrl", "ownerTeam"]);
  const summary = fields(data.summary, ["taskCount", "unfinishedTaskCount", "attachmentCount"]);
  const parsedSummary = { taskCount: count(summary.taskCount), unfinishedTaskCount: count(summary.unfinishedTaskCount), attachmentCount: count(summary.attachmentCount) };
  const activeClaims = array(data.activeClaims, (value): ProjectDeletionPreview["activeClaims"][number] => {
    const claim = fields(value, ["taskId", "title", "worker"]), worker = fields(claim.worker, ["machineName", "platform", "phase", "paused", "connectivity"]);
    const platform = worker.platform === "windows" || worker.platform === "linux" || worker.platform === "macos" ? worker.platform : malformed();
    const phase = worker.phase === "preparing" || worker.phase === "executing" || worker.phase === "verifying" || worker.phase === "completing" || worker.phase === "waiting" || worker.phase === "paused" ? worker.phase : malformed();
    const connectivity = worker.connectivity === "online" || worker.connectivity === "offline" || worker.connectivity === "unknown" ? worker.connectivity : malformed();
    return { taskId: id(claim.taskId), title: text(claim.title, true), worker: { machineName: text(worker.machineName, true), platform, phase, paused: bool(worker.paused), connectivity } };
  });
  const parsed = { observedAt: timestamp(data.observedAt), project: { id: id(project.id), name: text(project.name, true), repoUrl: text(project.repoUrl, true), ownerTeam: parseTeamRef(project.ownerTeam) }, summary: parsedSummary, activeClaims, nextCursor: data.nextCursor === null ? null : text(data.nextCursor, true) };
  if (parsed.project.id !== projectId || parsedSummary.unfinishedTaskCount > parsedSummary.taskCount || activeClaims.length > 100 || activeClaims.some((claim, index) => index > 0 && activeClaims[index - 1]!.taskId >= claim.taskId)) return malformed();
  return parsed;
};
export const parseProjectDeletionReceipt = (value: unknown, projectId: string): ProjectDeletionReceipt => {
  const data = fields(value, ["projectId", "deleted"]);
  if (id(data.projectId) !== projectId || data.deleted !== true) return malformed();
  return { projectId, deleted: true };
};

export const parseProjectTransferPreview = (value: unknown, targetTeamId: string): ProjectTransferPreview => {
  const data = fields(value, ["sourceTeam", "targetTeam", "ownership", "actorRole"]);
  const target = fields(data.targetTeam, ["id", "kind", "name", "version"]);
  const preview: ProjectTransferPreview = {
    sourceTeam: parseTeamRef(data.sourceTeam),
    targetTeam: { ...parseTeamRef({ id: target.id, kind: target.kind, name: target.name }), version: resourceVersion(target.version) },
    ownership: parseOwnership(data.ownership),
    actorRole: data.actorRole === null ? null : projectRole(data.actorRole),
  };
  if (preview.sourceTeam.id !== preview.ownership.teamId || preview.targetTeam.id !== targetTeamId || preview.sourceTeam.id === targetTeamId && !sameTeamRef(preview.sourceTeam, preview.targetTeam)) return malformed();
  return preview;
};
export const parseProjectTransferReceipt = (value: unknown, projectId: string, userId: string, preview: ProjectTransferPreview): ProjectTransferReceipt => {
  const data = fields(value, ["projectId", "changed", "sourceTeam", "ownerTeam", "ownership", "actorAccess"]);
  const receipt: ProjectTransferReceipt = {
    projectId: id(data.projectId), changed: bool(data.changed), sourceTeam: parseTeamRef(data.sourceTeam),
    ownerTeam: parseTeamRef(data.ownerTeam), ownership: parseOwnership(data.ownership),
    actorAccess: data.actorAccess === null ? null : parseProjectAccess(data.actorAccess, projectId, userId),
  };
  const changed = preview.ownership.teamId !== preview.targetTeam.id;
  if (receipt.projectId !== projectId || receipt.changed !== changed || receipt.sourceTeam.id !== preview.sourceTeam.id || !sameTeamRef(receipt.ownerTeam, preview.targetTeam) || !changed && !sameTeamRef(receipt.sourceTeam, receipt.ownerTeam) || receipt.ownership.teamId !== preview.targetTeam.id || receipt.ownership.version !== preview.ownership.version + (changed ? 1n : 0n)) return malformed();
  if (receipt.actorAccess !== null && (!sameTeamRef(receipt.actorAccess.ownerTeam, receipt.ownerTeam) || receipt.actorAccess.ownership.teamId !== receipt.ownership.teamId || receipt.actorAccess.ownership.version !== receipt.ownership.version)) return malformed();
  return receipt;
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
const parseTagReferences = (value: unknown): TagReference[] => {
  const tags = array(value, (value) => {
    const tag = fields(value, ["id", "name"]);
    return { id: id(tag.id), name: parseTagName(tag.name) };
  });
  if (new Set(tags.map((tag) => tag.id)).size !== tags.length) return malformed();
  return tags;
};

export const parseTask = (value: unknown, projectId: string, taskId?: string): Task => {
  const data = record(value);
  const version = resourceVersion(data.version);
  const base = dependencyState(data);
  const progress = base.type === "goal" ? (() => {
    const raw = record(data.progress);
    const result = { total: count(raw.total), done: count(raw.done), cancelled: count(raw.cancelled), unfinished: count(raw.unfinished) };
    if (result.done + result.cancelled + result.unfinished !== result.total) return malformed();
    return result;
  })() : undefined;
  if (base.type === "task" && Object.hasOwn(data, "progress")) return malformed();
  const parsed = { ...base, projectId: id(data.projectId), title: text(data.title, true), description: text(data.description), tags: parseTagReferences(data.tags), properties: parseTaskProperties(data.properties), version, ...(progress === undefined ? {} : { progress }) };
  if (parsed.projectId !== projectId || (taskId !== undefined && parsed.id !== taskId)) return malformed();
  const worker = readWorkerClaim(parsed.properties);
  if (worker?.state === "active" && parsed.status !== "in_progress") return malformed();
  return parsed;
};

const searchFieldOrder = { id: 0, title: 1, description: 2 } satisfies Readonly<Record<TaskSearchField, number>>;
const parseTaskSearchMatch = (value: unknown): TaskSearchItem["match"] => {
  const match = record(value);
  const fields = array(match.fields, (field): TaskSearchField => field === "id" || field === "title" || field === "description" ? field : malformed());
  if (fields.some((field, index) => index > 0 && searchFieldOrder[fields[index - 1]!] >= searchFieldOrder[field])) return malformed();
  const descriptionSnippet = match.descriptionSnippet === null ? null : text(match.descriptionSnippet);
  if (descriptionSnippet !== null && (descriptionSnippet.length === 0 || Array.from(descriptionSnippet).length > 162)) return malformed();
  if (fields.includes("description") !== (descriptionSnippet !== null)) return malformed();
  return { fields, descriptionSnippet };
};

export const parseTaskSearchPage = (value: unknown, projectId: string): TaskSearchPage => {
  const data = record(value);
  if (id(data.projectId) !== projectId) return malformed();
  const total = count(data.total);
  const items = array(data.items, (value): TaskSearchItem => {
    const item = record(value);
    const itemProject = id(item.projectId);
    if (itemProject !== projectId) return malformed();
    // Validate the full shared wire before projecting the fields used by the CLI.
    if (item.assignedTo !== null) id(item.assignedTo);
    timestamp(item.updatedAt);
    const rawContext = item.context === null ? null : record(item.context);
    const context = rawContext === null ? null : { taskId: id(rawContext.taskId), title: text(rawContext.title, true) };
    const parsedStatus = status(item.status), typed = resourceType(item);
    if (typed.type === "goal" && parsedStatus === "proposed") return malformed();
    return { id: id(item.id), ...typed, projectId: itemProject, title: text(item.title, true), tags: parseTagReferences(item.tags), status: parsedStatus, cancelledAt: cancellationTime(parsedStatus, item.cancelledAt), context, match: parseTaskSearchMatch(item.match) };
  });
  if (items.length > 100 || new Set(items.map((item) => item.id)).size !== items.length || items.length > total) return malformed();
  const nextCursor = data.nextCursor === null ? null : text(data.nextCursor, true);
  if (nextCursor !== null && (items.length === 0 || items.length >= total)) return malformed();
  return { projectId, total, items, nextCursor };
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
  if (parsed.type !== "task") return malformed();
  const characters = Array.from(parsed.titlePreview).length;
  if (characters === 0 || characters > 160 || (parsed.titleTruncated && characters !== 160)) return malformed();
  return { ...parsed, type: "task" };
};
const summary = (value: unknown): TaskGraphSummary => {
  const data = record(value);
  return { total: count(data.total), proposed: count(data.proposed), todo: count(data.todo), inProgress: count(data.inProgress), done: count(data.done), cancelled: count(data.cancelled), ready: count(data.ready), blocked: count(data.blocked) };
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
  if (byId.size !== parsed.tasks.length) return malformed();
  const members = graphChainMembers(byId, taskId);
  const selected = new Set(members);
  for (const member of members) {
    const task = byId.get(member)!;
    task.externalDependsOn.forEach((dependency) => { if (byId.has(dependency)) selected.add(dependency); });
  }
  if (selected.size !== byId.size || Array.from(selected).some((id) => !byId.has(id))) return malformed();
  const expected = { total: parsed.tasks.length, proposed: 0, todo: 0, inProgress: 0, done: 0, cancelled: 0, ready: 0, blocked: 0 };
  for (const task of parsed.tasks) {
    switch (task.status) {
      case "proposed": expected.proposed++; break;
      case "todo": expected.todo++; if (task.ready) expected.ready++; else expected.blocked++; break;
      case "in_progress": expected.inProgress++; break;
      case "done": expected.done++; break;
      case "cancelled": expected.cancelled++; break;
    }
    for (const dependency of task.dependsOn) {
      const target = byId.get(dependency);
      if (target !== undefined && task.blockedBy.includes(dependency) !== !isTerminalTaskStatus(target.status)) return malformed();
    }
  }
  for (const key of Object.keys(expected) as (keyof TaskGraphSummary)[]) if (expected[key] !== parsed.summary[key]) return malformed();
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
    if (raw.writeOutcome !== undefined) { fields(raw, ["writeOutcome"]); if (raw.writeOutcome !== "not_committed") return malformed(); }
    if (code === "invalid_search_expression") fields(raw, ["reason", "position", "length"]);
    details = {
      ...(raw.writeOutcome === undefined ? {} : { writeOutcome: "not_committed" as const }),
      ...(raw.reason === undefined ? {} : { reason: text(raw.reason, true) }),
      ...(raw.position === undefined ? {} : { position: count(raw.position) }),
      ...(raw.length === undefined ? {} : { length: count(raw.length) }),
      ...(raw.taskIds === undefined ? {} : { taskIds: ids(raw.taskIds) }),
      ...(raw.encodedBytes === undefined ? {} : { encodedBytes: count(raw.encodedBytes) }),
      ...(raw.maxEncodedBytes === undefined ? {} : { maxEncodedBytes: count(raw.maxEncodedBytes) }),
    };
  }
  if (code === "invalid_search_expression" && (details?.reason === undefined || !["empty_phrase", "empty_query", "expected_operand", "field_group_not_supported", "invalid_escape", "missing_field_value", "nesting_too_deep", "query_too_large", "too_many_terms", "unclosed_group", "unclosed_quote", "unexpected_closing_group", "unexpected_token", "unknown_field"].includes(details.reason) || details.position === undefined || details.position < 1 || details.length === undefined)) return malformed();
  if (code === "steps_limit_exceeded" && (details?.encodedBytes === undefined || details.maxEncodedBytes !== 67_108_864 || details.encodedBytes <= details.maxEncodedBytes)) return malformed();
  return { code, message, requestId, ...(details === undefined ? {} : { details }) };
};

// Deletion receipts and refusals establish mutation certainty, so reject
// unrecognized envelope or detail fields rather than guessing their meaning.
export const parseProjectDeletionError = (value: unknown): ServerError => {
  const envelope = fields(value, ["error"]);
  const error = fields(envelope.error, ["code", "message", "requestId", "details"]);
  if (error.details !== undefined) fields(error.details, ["writeOutcome"]);
  return parseServerError(value);
};
