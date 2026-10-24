import { expect, it, vi } from "vitest";
import { getTask, setTaskAgentPermission, setTaskRequiredPlatform, setTaskStatus, type TaskResponseAdmission } from "../src/api/client";
import { detailFixture, resourceResponse } from "./helpers/taskDetail";
import { TEST_VIEWER_ID } from "./helpers/taskSync";
const project = "10000000-0000-4000-8000-000000000001";
const task = "20000000-0000-4000-8000-000000000001";
const signal = () => new AbortController().signal;
const calls = [
  { name: "detail", write: false, invoke: (admission: TaskResponseAdmission) => getTask(project, task, signal(), admission) },
  { name: "status", write: true, invoke: (admission: TaskResponseAdmission) => setTaskStatus(project, task, "todo", 1n, signal(), admission) },
  { name: "permission", write: true, invoke: (admission: TaskResponseAdmission) => setTaskAgentPermission(project, task, true, 1n, signal(), admission) },
  { name: "platform", write: true, invoke: (admission: TaskResponseAdmission) => setTaskRequiredPlatform(project, task, "linux", 1n, signal(), admission) },
];
it.each(calls)("rejects $name from a different authenticated principal before its body or success is admitted", async ({ invoke }) => {
  const response = resourceResponse(detailFixture(project, task), "00000000-0000-4000-8000-000000000202");
  const text = vi.spyOn(response, "text"); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  const onPrincipalMismatch = vi.fn(); const onWriteConfirmed = vi.fn();
  await expect(invoke({ userId: TEST_VIEWER_ID, onPrincipalMismatch, onWriteConfirmed })).rejects.toMatchObject({ kind: "protocol", code: "principal_mismatch" });
  expect(onPrincipalMismatch).toHaveBeenCalledOnce(); expect(onWriteConfirmed).not.toHaveBeenCalled(); expect(text).not.toHaveBeenCalled();
});
it.each(calls)("rejects headerless $name responses without treating a resource error as access revocation", async ({ invoke }) => {
  const response = new Response('{"error":{"code":"not_found","message":"Not found","requestId":"request-1"}}', { status: 404, headers: { "Content-Type": "application/json" } });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response)); const onPrincipalMismatch = vi.fn(); const onWriteConfirmed = vi.fn();
  await expect(invoke({ userId: TEST_VIEWER_ID, onPrincipalMismatch, onWriteConfirmed })).rejects.toMatchObject({ kind: "protocol", status: 404 });
  expect(onPrincipalMismatch).not.toHaveBeenCalled(); expect(onWriteConfirmed).not.toHaveBeenCalled();
});
it.each(calls.filter((call) => call.write))("keeps successful $name HTTP confirmation when its body is unusable", async ({ invoke }) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(resourceResponse({ invalid: true }, TEST_VIEWER_ID)));
  const onWriteConfirmed = vi.fn();
  await expect(invoke({ userId: TEST_VIEWER_ID, onPrincipalMismatch: vi.fn(), onWriteConfirmed })).rejects.toMatchObject({ kind: "protocol", status: 200 });
  expect(onWriteConfirmed).toHaveBeenCalledOnce();
});
