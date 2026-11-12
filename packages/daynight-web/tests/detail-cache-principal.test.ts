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

it.each(['detail', 'steps'] as const)('ends %s publication after a committed transaction meets a real principal mismatch', async (kind) => {
  const { createTaskSessionWorld } = await import('./helpers/taskSessions');
  const { TaskDetailSessions } = await import('../src/features/task-detail/TaskDetailSession');
  const { pauseAuthRequests } = await import('../src/api/client');
  const { fixtureTaskEpoch, viewerHeaders } = await import('./helpers/taskSync');
  const { wireResponse } = await import('./helpers/wireJson');
  let resume = () => {}; const world = createTaskSessionWorld({ onIdentityMismatch: () => { resume = pauseAuthRequests(); } });
  const sessions = new TaskDetailSessions(world.scope); const initial = detailFixture(project, task, { title: 'Retained' });
  const step = { id: '00000001', title: 'Retained step', description: '', status: 'todo', createdAt: '2026-10-22T10:00:00Z', updatedAt: '2026-10-22T10:00:00Z' };
  let mismatchRequest = false, sawMismatch = false, attempts = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => mismatchRequest
    ? wireResponse(initial, { headers: viewerHeaders('99999999-9999-4999-8999-999999999999') })
    : wireResponse(url.endsWith('/steps') ? { projectId: project, taskId: task, version: 1n, steps: [step] } : initial,
      { headers: viewerHeaders(TEST_VIEWER_ID, { 'Daynight-Task-Epoch': fixtureTaskEpoch(project) }) })));
  try {
    await world.sync([initial]); sessions.subscribe(project, task, () => {}); sessions.observe(project, task, world.node(project, task));
    sessions.load(project, task, 1); await vi.waitFor(() => expect(sessions.snapshot(project, task).detail?.title).toBe('Retained'));
    if (kind === 'steps') { sessions.subscribeSteps(project, task, () => {}); sessions.loadSteps(project, task); await vi.waitFor(() => expect(sessions.stepsSnapshot(project, task).resource?.steps[0]?.title).toBe('Retained step')); }
    const transact = world.scope.detailTransaction.bind(world.scope); const ready = world.scope.ready.bind(world.scope);
    vi.spyOn(world.scope, 'detailTransaction').mockImplementation(async <T,>(...args: Parameters<typeof transact<T>>) => {
      const result = await transact<T>(...args);
      if (!sawMismatch) {
        sawMismatch = true; mismatchRequest = true;
        await expect(getTask(project, task, signal(), { userId: TEST_VIEWER_ID, onPrincipalMismatch: world.scope.principalMismatch })).rejects.toMatchObject({ code: 'principal_mismatch' });
      }
      return result;
    });
    vi.spyOn(world.scope, 'ready').mockImplementation(async currentSignal => {
      if (world.scope.hasIdentityMismatch && ++attempts > 2) throw new Error('Permanent mismatch was retried');
      return ready(currentSignal);
    });
    if (kind === 'detail') sessions.load(project, task, 2, 'refresh'); else sessions.loadSteps(project, task, true);
    await vi.waitFor(() => expect(attempts).toBeGreaterThan(0));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(attempts).toBe(1); expect(world.scope.signal.aborted).toBe(false);
    expect(sessions.snapshot(project, task).detail?.title).toBe('Retained');
    if (kind === 'steps') expect(sessions.stepsSnapshot(project, task).resource?.steps[0]?.title).toBe('Retained step');
  } finally { resume(); sessions.dispose(); world.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});
