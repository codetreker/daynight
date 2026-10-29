import type { WorkerDetailResponse, WorkerPage, WorkerSummary } from '../../src/api/workers';

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };
export const WORKER_USER = 'ffffffff-1111-4111-8111-111111111111';
export const WORKER_TIME = '2026-10-29T12:00:00.123456789Z';
export const workerId = (value: number): string => `${value.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
export const workerSummary = (value = 1): Mutable<WorkerSummary> => ({
  workerId: workerId(value), machine: { id: workerId(value + 100), name: `Worker ${value}` }, platform: 'linux', lastReportedAt: WORKER_TIME,
  taskObservationState: 'observed', taskObservedAt: WORKER_TIME, activeTaskCount: 1,
});
export const workerDetail = (value = 1): Mutable<WorkerDetailResponse> => ({
  observedAt: WORKER_TIME,
  worker: {
    ...workerSummary(value), inventoryObservedAt: WORKER_TIME,
    telemetry: {
      machine: workerSummary(value).machine, platform: 'linux', workingDirectory: '/srv/workspaces/project', sampledAt: WORKER_TIME,
      os: { state: 'ok', checkedAt: WORKER_TIME, value: { type: 'Linux', release: '6.8', version: 'Linux kernel', arch: 'x86_64' } },
      cpu: { state: 'ok', checkedAt: WORKER_TIME, value: { model: 'CPU model', logicalProcessors: 8, usagePercent: 33.25 } },
      memory: { state: 'ok', checkedAt: WORKER_TIME, value: { usedBytes: 16_000, totalBytes: 32_000 } },
      disk: { state: 'ok', checkedAt: WORKER_TIME, value: { availableBytes: 100_000, totalBytes: 200_000 } },
      versions: { daynight: '0.27.1', herdr: { state: 'not_running', checkedAt: WORKER_TIME }, codex: { state: 'ok', checkedAt: WORKER_TIME, value: '0.1.0' }, copilot: { state: 'not_installed', checkedAt: WORKER_TIME } },
    },
    tasks: [{ projectId: workerId(value + 300), taskId: workerId(value + 200), claimId: workerId(value + 400), title: 'Snapshot task', projectName: 'Project', status: 'in_progress', phase: 'executing', agent: 'codex' }],
  },
});
export const workerPage = (items: readonly WorkerSummary[] = [workerSummary()], nextCursor: string | null = null, observedAt = WORKER_TIME): WorkerPage => ({ observedAt, items, nextCursor });
export const workerResponse = (value: unknown, userId = WORKER_USER, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId } });
export const workerError = (status: number, userId = WORKER_USER): Response => workerResponse({ error: { code: status === 404 ? 'not_found' : 'internal', message: 'Resource error', requestId: 'worker-request' } }, userId, status);
