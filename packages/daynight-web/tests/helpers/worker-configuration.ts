import type { WorkerConfigurationResource, WorkerConfigurationValue } from '../../src/api/worker-configuration';
import { WORKER_TIME, WORKER_USER } from './workers';

export const configurationValue = (): WorkerConfigurationValue => ({ maxConcurrent: 2, pollIntervalMs: 60_000, recoveryLimit: 3, preferPlatformSpecificTasks: false, native: { agent: 'codex', model: null, args: [] }, projects: [] });
export const configurationResource = (revision = '1', value = configurationValue()): WorkerConfigurationResource => ({ desired: { revision, updatedAt: WORKER_TIME, value }, observationRevision: '0', observation: null });
export const configurationResponse = (value: unknown, status = 200, userId = WORKER_USER): Response => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId, 'Daynight-Worker-Configuration': '1' } });
export const configurationError = (status: number, code: string): Response => configurationResponse({ error: { code, message: 'Configuration request failed.', requestId: 'configuration-request' } }, status);
