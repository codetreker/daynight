import type { BotDeletionRecovery } from '../../src/api/bot-deletion-recovery';
import type { DeletedBot } from '../../src/api/bots';
import { BOT_TIME, BOT_USER, botId } from './bots';

export const recoveryResource = (decision = false, state: 'pending' | 'completed' | 'failed' = 'pending', version = decision ? '6' : '5'): BotDeletionRecovery => ({
  schemaVersion: 1, botId: botId(), version, deletionId: botId(90), requestedVersion: '3', workerId: botId(20), hostingWorkerId: botId(20), requiresStopProof: true, recoveryRequired: !decision,
  originalBinding: { sessionId: botId(30), testExecutionId: botId(31), executionGeneration: '1', controllerId: botId(32), controllerInstanceId: botId(33) },
  workerCleanup: { state: 'failed', code: 'execution_evidence_missing' }, serverCleanup: { state, code: state === 'failed' ? 'cleanup_failed' : null },
  decision: decision ? { operationId: botId(91), requestedVersion: '5', actorUserId: BOT_USER, reason: 'Original records lost', acknowledgedAt: BOT_TIME, localDisposition: 'unverified' } : null,
});
export const recoveryBot = (resource = recoveryResource()): DeletedBot => ({ id: resource.botId, workerId: resource.workerId, version: resource.version, deletion: { deletionId: resource.deletionId, requestedVersion: resource.requestedVersion, workerCleanup: resource.workerCleanup, serverCleanup: resource.serverCleanup } });
