import type { SessionAggregation, TaskSessionObservation, TaskSessionSend } from "../../api/task-observation.js";
import type { TaskWorkPage } from "../../api/task-work.js";
import { terminalText } from "../../platform/terminal.js";

const shown = (value: string | null): string => value === null ? "unknown" : terminalText(value);
const send = (value: TaskSessionSend): string => `${value.allowed === null ? "unknown" : value.allowed ? "allowed" : "denied"}${value.mode === null ? "" : ` (${value.mode})`} — ${terminalText(value.reason)}`;
const cursorArgument = (value: string): string => `'${terminalText(value).replaceAll("'", "'\\''")}'`;
export const taskObservationQuery = (projectId: string, taskId: string): string => `Inspect: daynight task show ${taskId} --project ${projectId}`;
export const renderSessionObservation = (session: TaskSessionObservation): readonly string[] => [
  `Session: ${session.sessionId === null ? "none" : terminalText(session.sessionId)}`,
  `Session observation: ${session.observation}; registration: ${session.registration}`,
  `Session indicator: ${session.indicator ?? "none"} (${terminalText(session.reason)})`,
  `Native Session: ${shown(session.nativeSessionId)}; claim: ${shown(session.claimId)}`,
  `Generation: ${shown(session.executionGeneration)}; connection epoch: ${shown(session.connectionEpoch)}`,
  `Mode: ${shown(session.agentControlMode)}; provider: ${shown(session.provider)}; content: ${shown(session.contentKind)}`,
  `Activity: ${shown(session.activity)}; connection: ${shown(session.connectionState)}; lifecycle: ${shown(session.lifecycle)}`,
  `Current turn: ${shown(session.currentTurnId)}; needs attention: ${session.needsAttention ?? "unknown"}`,
  `Send: ${send(session.send)}`,
  `Observed: ${shown(session.observedAt)}; last seen: ${shown(session.lastSeenAt)}; fresh until: ${shown(session.freshUntil)}`,
  ...(session.error === null ? [] : [`Session error: ${terminalText(session.error.code)} — ${terminalText(session.error.message)}`]),
];
export const renderSessionAggregation = (summary: SessionAggregation): readonly string[] => [
  `Session indicator: ${summary.indicator ?? "none"}; complete: ${summary.complete}`,
  `Session counts: warning=${summary.warningCount}, notice=${summary.noticeCount}, working=${summary.workingCount}, unknown=${summary.unknownCount}`,
  `Session observed: ${shown(summary.observedAt)}`,
];
export const renderTaskWorkPage = (page: TaskWorkPage, projectId: string, assignedTo: string): string => {
  const command = `daynight task list --status in_progress --group-by chain --project ${projectId} --assigned-to ${assignedTo}`;
  return [
    `Observed: ${terminalText(page.observedAt)}; partial: ${page.partial}`,
    ...page.groups.flatMap(group => [
      "", `${group.kind === "chain" ? "Chain" : "Task"}: ${terminalText(group.titlePreview)}${group.titleTruncated ? "…" : ""}`,
      `Group: ${group.groupId}; display task: ${group.displayTaskId}`,
      `Inspect members: daynight task graph ${group.displayTaskId} --project ${projectId}`,
      `Assigned-to filter: ${group.assignedTo}; aggregation: ${group.aggregationScope}`,
      `Members: ${group.memberCount}; matching: ${group.matchedCount}; in progress: ${group.inProgressCount}`,
      `Roots (${group.rootCount}${group.rootsTruncated ? ", preview" : ""}): ${group.roots.map(root => root.taskId).join(", ")}`,
      ...renderSessionAggregation(group.summary),
      ...group.targets.flatMap(target => [
        `  Task: ${target.taskId}; assigned to: ${target.assignedTo ?? "unassigned"}; matches filter: ${target.matchesAssignee}`,
        `  Session: ${target.sessionId ?? "none"}; indicator: ${target.indicator ?? "none"} (${terminalText(target.reason)})`,
        `  Send: ${send(target.send)}`,
        `  ${taskObservationQuery(projectId, target.taskId)}`,
      ]),
      ...(group.contributorCursor === null ? [] : [`More targets: ${command} --group-id ${group.groupId} --targets-cursor ${cursorArgument(group.contributorCursor)}`]),
    ]),
    ...(page.groups.length === 0 ? ["No matching work."] : []),
    ...(page.nextCursor === null ? [] : [`More groups: ${command} --cursor ${cursorArgument(page.nextCursor)}`]),
    "",
  ].join("\n");
};
