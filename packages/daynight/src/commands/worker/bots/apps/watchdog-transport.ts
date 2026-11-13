import { randomUUID } from "node:crypto";
import { ApiError, createApiClient, type ApiClient } from "../../../../api/client.js";
import { unsupportedSessionObservation } from "../../../../api/task-observation.js";
import { createOperation } from "../../../../api/operation.js";
import type { TaskWorkGroup } from "../../../../api/task-work.js";
import { SESSION_PROTOCOL } from "../../../../session/protocol.js";
import type { BotOwner } from "../types.js";
import type { WatchdogHistory, WatchdogObservation, WatchdogSource } from "./watchdog.js";
import { classifyWatchdogObservation, watchdogHistoryIdentity, watchdogInputIsQuiet } from "./watchdog.js";

type WatchdogApi = Pick<ApiClient, "listProjects" | "listTaskWork" | "getObservedTask" | "readTaskSession" | "sendTaskSessionCommand" | "readTaskSessionOperation">;
export type WatchdogApiScope = <T>(signal: AbortSignal, action: (api: WatchdogApi) => Promise<T>) => Promise<T>;

/** Queries retain their original account; incomplete scans never imply resolution. */
export const createWatchdogSource = (ownerUserId: string, withApi: WatchdogApiScope): WatchdogSource => {
const source: WatchdogSource = {
  scan: (signal, prior = []) => withApi(signal, async api => {
    const observations: WatchdogObservation[] = [];
    const read = async (projectId: string, taskId: string, title: string): Promise<WatchdogObservation> => {
      try {
        const task = await api.getObservedTask(projectId, taskId);
        return { projectId, taskId, title: task.title, taskStatus: task.status, assignedTo: task.assignedTo, inScope: task.status === "in_progress" && task.assignedTo === ownerUserId, session: task.session };
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof ApiError) || ![403, 404, 410].includes(error.status ?? 0)) throw error;
        return { projectId, taskId, title, inScope: true, session: { ...unsupportedSessionObservation(), observation: "unavailable", reason: "task_unavailable", error: { code: "task_unavailable", message: "The original task is no longer readable; resolution is unconfirmed." } } };
      }
    };
    for (const project of await api.listProjects()) {
      const tasks = new Set<string>(), cursors = new Set<string>();
      const collect = (group: TaskWorkGroup) => {
        for (const target of group.targets) if (target.matchesAssignee && target.assignedTo === ownerUserId) tasks.add(target.taskId);
      };
      let cursor: string | null = null;
      do {
        signal.throwIfAborted();
        const page = await api.listTaskWork(project.id, { assignedTo: "me", ...(cursor === null ? {} : { cursor }) });
        // Partial refers to missing observations, which the full Task read below
        // preserves explicitly; pagination still describes the complete inventory.
        for (const group of page.groups) {
          collect(group);
          let targetsCursor = group.contributorCursor;
          const targetsSeen = new Set<string>();
          while (targetsCursor !== null) {
            if (targetsSeen.has(targetsCursor)) throw new Error("Watchdog contributor cursor repeated.");
            targetsSeen.add(targetsCursor);
            const contributors = await api.listTaskWork(project.id, { assignedTo: "me", groupId: group.groupId, targetsCursor });
            const next = contributors.groups[0];
            if (!next || next.groupId !== group.groupId) throw new Error("Watchdog contributor group changed.");
            collect(next); targetsCursor = next.contributorCursor;
          }
        }
        cursor = page.nextCursor;
        if (cursor !== null) {
          if (cursors.has(cursor)) throw new Error("Watchdog work cursor repeated.");
          cursors.add(cursor);
        }
      } while (cursor !== null);
      for (const taskId of tasks) {
        observations.push(await read(project.id, taskId, prior.find(value => value.taskId === taskId)?.title ?? taskId));
      }
    }
    const seen = new Set(observations.map(value => `${value.projectId}/${value.taskId}`));
    for (const previous of prior) {
      if (seen.has(`${previous.projectId}/${previous.taskId}`)) continue;
      // Disappearing from an accessible-project listing can mean permission
      // loss. Only an authorized full read proves completion or reassignment.
      observations.push(await read(previous.projectId, previous.taskId, previous.title));
    }
    return observations;
  }),
  history: (observation, signal) => withApi(signal, async api => {
    const sessionId = observation.session.sessionId;
    const result: WatchdogHistory = { complete: false, lastEntryId: null, lastAssistantText: null, lastInputAt: null };
    if (sessionId === null) return result;
    let before: string | undefined, epoch: string | undefined, source: string | undefined;
    let inputFound = false, assistantFound = false;
    const cursors = new Set<string>();
    // Bound a pathological history without interpreting an unread suffix as
    // evidence that no other input occurred. Read-only escalation can still use
    // the latest non-input activity watermark from an incomplete result.
    for (let pages = 0; pages < 100; pages++) {
      const page = await api.readTaskSession(observation.projectId, observation.taskId, sessionId, { limit: 200, ...(before === undefined ? {} : { before }) });
      if (epoch !== undefined && (epoch !== page.historyEpoch || source !== page.source)) return result;
      epoch = page.historyEpoch; source = page.source;
      if (page.coverage.state !== "complete" || page.source !== "live") return result;
      for (const entry of [...page.items].reverse()) {
        const automaticInput = entry.body?.kind === "user_message" && entry.body.origin === "daynight";
        // A projected input reference does not reveal its origin. It still
        // protects the quiet interval, but cannot prove progress after our send.
        const unreadableInput = entry.kind === "user_message" && (entry.truncated || entry.body?.kind !== "user_message");
        if (!automaticInput && !unreadableInput && result.lastEntryId === null) result.lastEntryId = `${epoch}/${entry.entryId}/${entry.revision}`;
        if (entry.kind === "user_message" && !inputFound) {
          inputFound = true;
          if (entry.timestamp === null) result.untimedInputId = `${epoch}/${entry.entryId}/${entry.revision}`;
          else {
            result.lastInputAt = Date.parse(entry.timestamp);
            if (!Number.isFinite(result.lastInputAt)) return result;
          }
        }
        if (entry.kind === "assistant_message" && !assistantFound) {
          assistantFound = true;
          if (entry.truncated || entry.body?.kind !== "assistant_message") return result;
          result.lastAssistantText = entry.body.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        }
      }
      if (!page.hasMoreBefore || inputFound && assistantFound) { result.complete = true; return result; }
      if (page.beforeCursor === null || cursors.has(page.beforeCursor)) return result;
      before = page.beforeCursor; cursors.add(before);
    }
    return result;
  }),
  send: (observation, operationId, text, signal, expectedHistory, beforeSubmit) => withApi(signal, async api => {
    const { sessionId, claimId, executionGeneration, currentTurnId } = observation.session;
    if (sessionId === null || claimId === null || executionGeneration === null) throw new Error("Watchdog has no original execution identity.");
    const task = await api.getObservedTask(observation.projectId, observation.taskId);
    const current: WatchdogObservation = { ...observation, title: task.title, taskStatus: task.status, assignedTo: task.assignedTo, inScope: task.status === "in_progress" && task.assignedTo === ownerUserId, session: task.session };
    if (task.session.sessionId !== sessionId || task.session.claimId !== claimId || task.session.executionGeneration !== executionGeneration
      || task.session.currentTurnId !== currentTurnId || task.session.send.allowed !== true || classifyWatchdogObservation(current, Date.now()) !== "stalled") return "rejected";
    const history = await source.history(current, signal);
    if (history.untimedInputId !== undefined && expectedHistory !== undefined
      && expectedHistory.inputQuietSince !== undefined && expectedHistory.inputQuietObservedAt !== undefined
      && watchdogHistoryIdentity(current, history) === watchdogHistoryIdentity(observation, expectedHistory)) {
      history.inputQuietSince = expectedHistory.inputQuietSince;
      history.inputQuietObservedAt = expectedHistory.inputQuietObservedAt;
    }
    if (!history.complete || expectedHistory !== undefined && (expectedHistory.lastEntryId !== history.lastEntryId || expectedHistory.lastAssistantText !== history.lastAssistantText)
      || !watchdogInputIsQuiet(history, Date.now())
      || task.session.freshUntil === null || Date.parse(task.session.freshUntil) <= Date.now()) return "rejected";
    if (beforeSubmit !== undefined && !await beforeSubmit()) return "rejected";
    signal.throwIfAborted();
    const result = await api.sendTaskSessionCommand({ projectId: observation.projectId, taskId: observation.taskId, sessionId, operationId }, {
      protocol: SESSION_PROTOCOL, sessionId, claimId, executionGeneration, operationId, requestId: randomUUID(), kind: "send_message",
      payload: { content: [{ type: "text", text }], expectedTurnId: currentTurnId, origin: "daynight" },
    });
    return result.operation.state;
  }),
  operation: (observation, operationId, signal) => withApi(signal, async api => {
    const { sessionId, claimId, executionGeneration } = observation.session;
    if (sessionId === null || claimId === null || executionGeneration === null) throw new Error("Watchdog has no original operation identity.");
    return (await api.readTaskSessionOperation({ projectId: observation.projectId, taskId: observation.taskId, sessionId, operationId }, { claimId, executionGeneration, kind: "send_message" })).operation.state;
  }),
};
return source;
};

export const createWatchdogTransport = (options: { owner: BotOwner; serverToken: string }): WatchdogSource => createWatchdogSource(options.owner.ownerUserId, async (signal, action) => {
  const operation = createOperation({ signal, limits: { totalMs: 55_000, requestMs: 10_000 } });
  try { return await action(createApiClient({ serverUrl: options.owner.serverOrigin, serverToken: options.serverToken, expectedUserId: options.owner.ownerUserId, operation })); }
  finally { operation.dispose(); }
});
