import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateAuthRequests } from "../src/api/client";
import { parseServerError } from "../src/api/parse";
import { deleteProject, isConfirmedProjectDeletionRefusal, previewProjectDeletion } from "../src/api/project-deletion";

const user = "00000000-0000-4000-8000-000000000001";
const project = "00000000-0000-4000-8000-000000000002";
const team = "00000000-0000-4000-8000-000000000003";
const task = "00000000-0000-4000-8000-000000000004";
const correlation = "00000000-0000-4000-8000-000000000005";
const body = { observedAt: "2026-11-06T12:00:00Z", project: { id: project, name: " leading\nname ", repoUrl: "repo", ownerTeam: { id: team, kind: "ordinary", name: "Team" } }, summary: { taskCount: 1, unfinishedTaskCount: 1, attachmentCount: 2 }, activeClaims: [{ taskId: task, title: "Task", worker: { machineName: "machine", platform: "linux", phase: "executing", paused: false, connectivity: "unknown" } }], nextCursor: "cursor" };
const response = (value: unknown, status = 200, principal = user, requestId = correlation) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": principal, "X-Request-ID": requestId } });
const signal = () => new AbortController().signal;
const failure = (code: string, details?: unknown) => ({ error: { code, message: "failure", requestId: correlation, ...(details === undefined ? {} : { details }) } });
beforeEach(() => { vi.spyOn(crypto, "randomUUID").mockReturnValue(correlation); });
afterEach(() => { invalidateAuthRequests(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("project deletion API", () => {
  it("reads paginated identity, counts and worker observations without normalizing names", async () => {
    const fetch = vi.fn().mockResolvedValue(response(body)); vi.stubGlobal("fetch", fetch);
    expect(await previewProjectDeletion(project, { limit: 50, cursor: "a+b" }, user, signal(), vi.fn())).toEqual(body);
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/v1/projects/${project}/deletion-preview?limit=50&cursor=a%2Bb`);
  });
  it("rejects malformed or wrong-target previews", async () => {
    for (const bad of [
      { ...body, project: { ...body.project, id: team } },
      { ...body, summary: { ...body.summary, unfinishedTaskCount: 2 } },
      { ...body, activeClaims: [body.activeClaims[0], body.activeClaims[0]] },
      { ...body, activeClaims: [{ ...body.activeClaims[0], worker: { ...body.activeClaims[0]!.worker, connectivity: "disconnected" } }] },
      { ...body, nextCursor: "" },
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(bad)));
      await expect(previewProjectDeletion(project, {}, user, signal(), vi.fn())).rejects.toMatchObject({ kind: "protocol" });
    }
  });
  it("sends exactly one unconditional DELETE and accepts only its target receipt", async () => {
    const dispatched = vi.fn(), fetch = vi.fn().mockResolvedValue(response({ projectId: project, deleted: true })); vi.stubGlobal("fetch", fetch);
    await expect(deleteProject(project, user, signal(), vi.fn(), dispatched)).resolves.toEqual({ projectId: project, deleted: true });
    expect(fetch).toHaveBeenCalledOnce(); expect(dispatched).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/v1/projects/${project}`);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "DELETE" }); expect(fetch.mock.calls[0]?.[1].body).toBeUndefined();
    for (const receipt of [{ projectId: team, deleted: true }, { projectId: project, deleted: false }, { projectId: project, deleted: true, extra: 1 }]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(receipt)));
      await expect(deleteProject(project, user, signal(), vi.fn(), vi.fn())).rejects.toMatchObject({ kind: "protocol" });
    }
  });
  it("distinguishes correlated definite refusals from unknown outcomes", async () => {
    for (const [status, code, details] of [[400, "invalid_input", undefined], [401, "unauthenticated", undefined], [403, "forbidden", undefined], [404, "not_found", undefined], [409, "active_worker_claims", undefined], [500, "internal_error", { writeOutcome: "not_committed" }]] as const) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(failure(code, details), status)));
      const error = await deleteProject(project, user, signal(), vi.fn(), vi.fn()).catch((value: unknown) => value);
      expect(isConfirmedProjectDeletionRefusal(error)).toBe(true);
    }
    for (const [status, code, details, responseId] of [[500, "internal_error", undefined, correlation], [500, "internal_error", { writeOutcome: "unknown" }, correlation], [500, "internal_error", { writeOutcome: "not_committed" }, "other"], [503, "write_outcome_unknown", undefined, correlation], [409, "forbidden", undefined, correlation]] as const) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(failure(code, details), status, user, responseId)));
      const error = await deleteProject(project, user, signal(), vi.fn(), vi.fn()).catch((value: unknown) => value);
      expect(isConfirmedProjectDeletionRefusal(error)).toBe(false);
    }
  });
  it("retains only the recognized outcome in generic error parsing", () => {
    expect(parseServerError(failure("internal_error", { writeOutcome: "not_committed" })).writeOutcome).toBe("not_committed");
    expect(parseServerError(failure("internal_error", { writeOutcome: "unknown" })).writeOutcome).toBeUndefined();
    expect(parseServerError(failure("internal_error", "not_committed")).writeOutcome).toBeUndefined();
  });
  it("treats wrong principal and lost response as unconfirmed without retry", async () => {
    const mismatch = vi.fn(), fetch = vi.fn().mockResolvedValue(response({ projectId: project, deleted: true }, 200, team)); vi.stubGlobal("fetch", fetch);
    const error = await deleteProject(project, user, signal(), mismatch, vi.fn()).catch((value: unknown) => value);
    expect(isConfirmedProjectDeletionRefusal(error)).toBe(false); expect(mismatch).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce();
    fetch.mockRejectedValue(new Error("connection lost"));
    await expect(deleteProject(project, user, signal(), vi.fn(), vi.fn())).rejects.toMatchObject({ kind: "network" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
