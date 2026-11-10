import type { TaskSessionCurrent, TaskSessionDirectory, TaskSessionEntryChunk, TaskSessionInspection, TaskSessionMessage, TaskSessionMessagePage } from "../../../api/task-session.js";
import { terminalText } from "../../../platform/terminal.js";
import type { MessagePart, TimelineEntry } from "../../../session/protocol.js";
import { renderSessionObservation } from "../observation-rendering.js";

const lines = (value: string): string => value.split("\n").map(terminalText).join("\n");
const argument = (value: string): string => `'${terminalText(value).replaceAll("'", "'\\''")}'`;
const part = (value: MessagePart): string => value.type === "text" ? lines(value.text) : `Resource reference: ${value.resourceId}; ${lines(value.label)}`;
const bodyText = (body: TimelineEntry): readonly string[] => {
  switch (body.kind) {
    case "user_message": case "assistant_message": return body.content.map(part);
    case "reasoning": return [lines(body.text)];
    case "tool_call": return [`Tool: ${terminalText(body.name)}; call: ${terminalText(body.callId)}; status: ${body.status}; output truncated: ${body.truncated}`, "Input:", lines(body.input), "Output:", ...body.output.map(part)];
    case "interaction": return [lines(JSON.stringify(body.interaction, null, 2))];
    case "error": return [`Error: ${terminalText(body.code)}`, lines(body.message)];
    case "compaction": return [lines(body.summary)];
    case "todo": return body.items.map(item => `${terminalText(item.id)} [${item.status}] ${lines(item.text)}`);
  }
};
const inspectionLines = (value: TaskSessionInspection): readonly string[] => [
  `Project: ${value.projectId}; Task: ${value.taskId}`, `Current binding: ${value.currentBinding}`, `Source: ${value.source}`,
  `Live content-read version: ${value.contentReadVersion ?? 0}`, ...renderSessionObservation(value.session),
  `Read: daynight task session read ${value.taskId} ${value.sessionId} --project ${value.projectId}`,
];
export const renderTaskSessionInspection = (value: TaskSessionInspection): string => [...inspectionLines(value), ""].join("\n");
export const renderTaskSessionCurrent = (value: TaskSessionCurrent, projectId: string, taskId: string): string => [
  `Current Session: ${value.status}; claim: ${value.claimId ?? "none"}; mode: ${value.agentControlMode ?? "none"}`,
  ...(value.session === null ? [`No current Session. Historical Sessions: daynight task session list ${taskId} --project ${projectId}`] : inspectionLines(value.session)), "",
].join("\n");
export const renderTaskSessionDirectory = (value: TaskSessionDirectory, projectId: string, taskId: string, limit: number): string => [
  ...value.items.flatMap(item => [
    `Session: ${item.sessionId}; current binding: ${item.currentBinding}`,
    `Claim: ${item.claimId}; generation: ${item.executionGeneration}; mode: ${item.agentControlMode}; content: ${item.contentKind}`,
    `Created: ${item.createdAt}; ended: ${item.endedAt ?? "unknown"}`,
    `Archive: ${terminalText(item.archive.state)}; completeness: ${item.archive.completeness === null ? "unknown" : terminalText(item.archive.completeness)}; bytes: ${item.archive.byteLength ?? "unknown"}; SHA256: ${item.archive.sha256 ?? "unknown"}`,
    `Inspect: daynight task session show ${taskId} ${item.sessionId} --project ${projectId}`, "",
  ]),
  ...(value.items.length === 0 ? ["No Sessions in this page."] : []),
  ...(value.nextCursor === null ? [] : [`More Sessions: daynight task session list ${taskId} --project ${projectId} --limit ${limit} --cursor ${argument(value.nextCursor)}`]), "",
].join("\n");
const messageLines = (value: TaskSessionMessage, projectId: string, taskId: string, sessionId: string): readonly string[] => [
  "", `Entry: ${value.entryId}; sequence: ${value.entrySeq}; revision: ${value.revision}; kind: ${value.kind}`,
  `Role: ${value.role === null ? "unknown" : terminalText(value.role)}; time: ${value.timestamp ?? "unavailable"}`,
  ...(value.body === null ? ["Body omitted from this page; a fixed-version content reference is available."] : bodyText(value.body)),
  ...(value.contentRef === null ? [] : [
    `Canonical JSON bytes: ${value.contentRef.byteLength}; SHA256: ${value.contentRef.sha256}`,
    `Read entry: daynight task session entry ${taskId} ${sessionId} --project ${projectId} --cursor ${argument(value.contentRef.cursor)}`,
  ]),
  ...value.resources.map(resource => `Resource: ${resource.resourceId}; ${terminalText(resource.name)}; ${resource.status}; media: ${resource.mediaType === null ? "unknown" : terminalText(resource.mediaType)}; bytes: ${resource.byteLength ?? "unknown"}; SHA256: ${resource.sha256 ?? "unknown"}`),
  ...(value.resourcesTruncated ? ["Resource descriptor preview is incomplete; the full entry retains its original references."] : []),
];
export const renderTaskSessionPage = (value: TaskSessionMessagePage, projectId: string, taskId: string, limit: number, conversation: boolean): string => [
  `Session: ${value.sessionId}; source: ${value.source}; history epoch: ${terminalText(value.historyEpoch)}`,
  `Order: oldest to newest within this page; observed: ${value.observedAt}`,
  `Coverage: ${value.coverage.state}${value.coverage.reason === null ? "" : ` (${terminalText(value.coverage.reason)})`}`,
  ...value.items.flatMap(item => messageLines(item, projectId, taskId, value.sessionId)),
  ...(value.items.length === 0 ? [conversation ? "No matching entries in this page." : "No entries in this page."] : []),
  ...(!value.hasMoreBefore || value.beforeCursor === null ? ["No earlier page."] : [`Earlier: daynight task session read ${taskId} ${value.sessionId} --project ${projectId} --limit ${limit}${conversation ? " --conversation" : ""} --before ${argument(value.beforeCursor)}`]), "",
].join("\n");
export const renderTaskSessionChunk = (value: TaskSessionEntryChunk, projectId: string, taskId: string): string => [
  `Session: ${value.sessionId}; source: ${value.source}; history epoch: ${terminalText(value.historyEpoch)}`,
  `Entry: ${value.entryId}; revision: ${value.revision}; observed: ${value.observedAt}`,
  `Offset: ${value.offset}; total UTF-8 bytes: ${value.byteLength}; SHA256: ${value.sha256}; eof: ${value.eof}`,
  "Fragment (terminal-escaped; use --json for reconstruction):", lines(value.fragment),
  ...(value.nextCursor === null ? [] : [`Next block: daynight task session entry ${taskId} ${value.sessionId} --project ${projectId} --cursor ${argument(value.nextCursor)}`]), "",
].join("\n");
