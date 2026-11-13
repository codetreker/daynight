import { describe, expect, it, vi } from "vitest";
import { ApiError, type ApiClient } from "../../../../src/api/client.js";
import type { ObservedTask } from "../../../../src/api/task-observation.js";
import type { WatchdogObservation } from "../../../../src/commands/worker/bots/apps/watchdog.js";
import { createWatchdogSource, type WatchdogApiScope } from "../../../../src/commands/worker/bots/apps/watchdog-transport.js";

const signal = new AbortController().signal;
const observation = { projectId: "project", taskId: "task", title: "Task", inScope: true, session: { sessionId: "session", claimId: "claim", executionGeneration: "2", currentTurnId: null, observation: "observed", error: null, freshUntil: "2099-01-01T00:00:00Z", registration: "registered", lifecycle: "active", connectionState: "connected", activity: "idle", indicator: "warning", reason: "idle", send: { allowed: true } } } as WatchdogObservation;
const setup = (api: Partial<ApiClient>) => createWatchdogSource("owner", (async (_signal, action) => action(api as ApiClient)) as WatchdogApiScope);
const message = (kind: string, entryId: string, timestamp: string | null, text = "") => ({ kind, entryId, revision: "1", timestamp, truncated: false, body: { kind, content: [{ type: "text", text }] } });
const page = (items: unknown[], extra = {}) => ({ sessionId: "session", historyEpoch: "epoch", source: "live", items, coverage: { state: "complete" }, hasMoreBefore: false, beforeCursor: null, ...extra });

describe("Watchdog production data adapter", () => {
  it("follows group and contributor cursors, filters other assignees and rereads full observations", async () => {
    const target = (taskId: string, matchesAssignee = true) => ({ taskId, assignedTo: matchesAssignee ? "owner" : "other", matchesAssignee });
    const listTaskWork = vi.fn().mockResolvedValueOnce({ groups: [{ groupId: "g", targets: [target("a"), target("other", false)], contributorCursor: "c" }], nextCursor: "next", partial: true })
      .mockResolvedValueOnce({ groups: [{ groupId: "g", targets: [target("b")], contributorCursor: null }], nextCursor: null })
      .mockResolvedValueOnce({ groups: [{ groupId: "h", targets: [target("c")], contributorCursor: null }], nextCursor: null });
    const getObservedTask = vi.fn(async (_project: string, taskId: string) => ({ title: taskId, status: taskId === "b" ? "done" : "in_progress", assignedTo: "owner", session: observation.session }) as ObservedTask);
    const source = setup({ listProjects: vi.fn().mockResolvedValue([{ id: "project" }]), listTaskWork, getObservedTask });
    expect(await source.scan(signal)).toEqual(["a", "b", "c"].map(taskId => ({ ...observation, taskId, title: taskId, taskStatus: taskId === "b" ? "done" : "in_progress", assignedTo: "owner", inScope: taskId !== "b" })));
    expect(listTaskWork.mock.calls.map(call => call[1])).toEqual([{ assignedTo: "me" }, { assignedTo: "me", groupId: "g", targetsCursor: "c" }, { assignedTo: "me", cursor: "next" }]);
  });

  it("does not turn a missing project or refused original task read into resolution", async () => {
    const getObservedTask = vi.fn().mockRejectedValue(new ApiError({ operation: "task.show" }, "response", { cause: null, status: 403 }));
    const source = setup({ listProjects: vi.fn().mockResolvedValue([]), getObservedTask });
    expect(await source.scan(signal, [observation])).toEqual([expect.objectContaining({ taskId: "task", inScope: true, session: expect.objectContaining({ observation: "unavailable" }) })]);
    expect(getObservedTask).toHaveBeenCalledWith("project", "task");
  });

  it("reads older pages to find input and preserves non-input progress despite its own submitted message", async () => {
    const own = message("user_message", "own", "2026-11-13T00:03:00Z");
    const readTaskSession = vi.fn().mockResolvedValueOnce(page([message("tool_call", "tool", "2026-11-13T00:02:00Z"), { ...own, body: { ...own.body, origin: "daynight" } }], { hasMoreBefore: true, beforeCursor: "older" }))
      .mockResolvedValueOnce(page([message("assistant_message", "assistant", "2026-11-13T00:01:00Z", "Please continue")]));
    expect(await setup({ readTaskSession }).history(observation, signal)).toEqual({ complete: true, lastEntryId: "epoch/tool/1", lastProgressId: "tool/1", lastAssistantText: "Please continue", lastInputAt: Date.parse("2026-11-13T00:03:00Z") });
    expect(readTaskSession).toHaveBeenLastCalledWith("project", "task", "session", { limit: 200, before: "older" });
  });

  it.each([
    page([message("user_message", "input", "invalid")]),
    page([{ ...message("assistant_message", "a", "2026-11-13T00:00:00Z"), truncated: true, body: null }]),
    page([], { coverage: { state: "partial" } }),
    page([], { source: "archive" }),
  ])("fails closed when history cannot establish safe direct-action evidence", async value => {
    expect((await setup({ readTaskSession: vi.fn().mockResolvedValue(value) }).history(observation, signal)).complete).toBe(false);
  });

  it("does not combine history epochs", async () => {
    const readTaskSession = vi.fn().mockResolvedValueOnce(page([message("tool_call", "tool", null)], { hasMoreBefore: true, beforeCursor: "older" }))
      .mockResolvedValueOnce(page([], { historyEpoch: "replacement" }));
    expect((await setup({ readTaskSession }).history(observation, signal)).complete).toBe(false);
  });

  it("requires a fresh matching quiet proof for untimed automatic input before submission", async () => {
    const automatic = message("user_message", "automatic", null);
    const readTaskSession = vi.fn().mockResolvedValue(page([message("assistant_message", "a", null, "Continue"), { ...automatic, body: { ...automatic.body, origin: "daynight" } }]));
    const sendTaskSessionCommand = vi.fn().mockResolvedValue({ operation: { state: "accepted" } });
    const source = setup({ readTaskSession, sendTaskSessionCommand, getObservedTask: vi.fn().mockResolvedValue({ title: "Task", status: "in_progress", assignedTo: "owner", session: observation.session }) });
    const latest = await source.history(observation, signal);
    expect(latest).toMatchObject({ complete: true, untimedInputId: "epoch/automatic/1", lastInputAt: null, lastEntryId: "epoch/a/1" });
    expect(await source.send(observation, "unknown", "Continue", signal, latest)).toBe("rejected");
    const now = Date.now(), proof = { ...latest, inputQuietSince: now - 121_000, inputQuietObservedAt: now };
    for (const invalid of [{ inputQuietSince: Number.NaN }, { inputQuietSince: Infinity }, { inputQuietSince: now + 60_000 },
      { inputQuietObservedAt: Number.NaN }, { inputQuietObservedAt: now + 60_000 }, { inputQuietObservedAt: now - 121_000 }]) {
      expect(await source.send(observation, "invalid", "Continue", signal, { ...proof, ...invalid })).toBe("rejected");
    }
    expect(await source.send(observation, "proved", "Continue", signal, proof)).toBe("accepted");
    readTaskSession.mockResolvedValue(page([message("assistant_message", "a", null, "Continue"), { ...automatic, entryId: "new-automatic", body: { ...automatic.body, origin: "daynight" } }]));
    expect(await source.send(observation, "changed", "Continue", signal, proof)).toBe("rejected");
    expect(sendTaskSessionCommand).toHaveBeenCalledOnce();
  });

  it("uses the original execution fence for both submission and recovery", async () => {
    const sendTaskSessionCommand = vi.fn().mockResolvedValue({ operation: { state: "accepted" } });
    const readTaskSessionOperation = vi.fn().mockResolvedValue({ operation: { state: "confirmed" } });
    const getObservedTask = vi.fn().mockResolvedValue({ title: "Task", status: "in_progress", assignedTo: "owner", session: observation.session });
    const readTaskSession = vi.fn().mockResolvedValue(page([message("assistant_message", "a", "2026-01-01T00:00:00Z", "Continue")]));
    const source = setup({ sendTaskSessionCommand, readTaskSessionOperation, getObservedTask, readTaskSession });
    expect(await source.send(observation, "operation", "Continue", signal)).toBe("accepted");
    expect(await source.operation(observation, "operation", signal)).toBe("confirmed");
    const target = { projectId: "project", taskId: "task", sessionId: "session", operationId: "operation" };
    expect(sendTaskSessionCommand).toHaveBeenCalledWith(target, expect.objectContaining({ claimId: "claim", executionGeneration: "2", operationId: "operation", payload: { expectedTurnId: null, origin: "daynight", content: [{ type: "text", text: "Continue" }] } }));
    expect(readTaskSessionOperation).toHaveBeenCalledWith(target, { claimId: "claim", executionGeneration: "2", kind: "send_message" });
    expect(sendTaskSessionCommand).toHaveBeenCalledTimes(1);
  });

  it("refuses an old idle observation when another input has just arrived", async () => {
    const sendTaskSessionCommand = vi.fn();
    const source = setup({ sendTaskSessionCommand,
      getObservedTask: vi.fn().mockResolvedValue({ title: "Task", status: "in_progress", assignedTo: "owner", session: observation.session }),
      readTaskSession: vi.fn().mockResolvedValue(page([message("user_message", "new", new Date().toISOString())])),
    });
    expect(await source.send(observation, "operation", "Continue", signal)).toBe("rejected");
    expect(sendTaskSessionCommand).not.toHaveBeenCalled();
  });

  it("counts a human follow-up as progress and revalidates the assistant claim after history", async () => {
    const readTaskSession = vi.fn().mockResolvedValue(page([message("user_message", "human", "2026-01-01T00:00:00Z")]));
    const sendTaskSessionCommand = vi.fn();
    const source = setup({ readTaskSession, sendTaskSessionCommand, getObservedTask: vi.fn().mockResolvedValue({ title: "Task", status: "in_progress", assignedTo: "owner", session: observation.session }) });
    expect((await source.history(observation, signal)).lastEntryId).toBe("epoch/human/1");
    const beforeSubmit = vi.fn(async () => { expect(readTaskSession).toHaveBeenCalledTimes(2); return false; });
    expect(await source.send(observation, "operation", "Continue", signal, undefined, beforeSubmit)).toBe("rejected");
    expect(beforeSubmit).toHaveBeenCalledOnce(); expect(sendTaskSessionCommand).not.toHaveBeenCalled();
  });
});
