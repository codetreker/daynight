import type { ImageTarget, SessionFence } from '../../../../../daynight/src/session/protocol';
import type { DraftOwnerIdentity } from './draft-types';

export const canonicalDraftOrigin = (origin: string): string => {
  const parsed = new URL(origin);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Invalid draft service origin.');
  return parsed.origin;
};
export const draftFenceParts = (fence: SessionFence): readonly string[] => [fence.sessionId, 'claimId' in fence ? 'claim' : 'test', fence.claimId ?? fence.testExecutionId!, fence.executionGeneration];
export const draftExecutionKey = (identity: DraftOwnerIdentity): string => JSON.stringify(['daynight-draft-execution', 1, canonicalDraftOrigin(identity.target.serverOrigin), identity.target.actorUserId, ...draftFenceParts(identity.target.fence)]);
export const draftOwnerKey = (identity: DraftOwnerIdentity): string => {
  const { resolver, target } = identity;
  const resolved = resolver.kind === 'task' ? ['task', resolver.projectId, resolver.taskId] : ['session', resolver.sessionId, resolver.testExecutionId];
  return JSON.stringify(['daynight-draft-owner', 1, canonicalDraftOrigin(target.serverOrigin), target.actorUserId, ...resolved, ...draftFenceParts(target.fence), target.expectedNativeSessionId]);
};
export const draftAccountKey = (identity: DraftOwnerIdentity): string => JSON.stringify(['daynight-draft-account', 1, canonicalDraftOrigin(identity.target.serverOrigin), identity.target.actorUserId]);
export const sameDraftFence = (a: SessionFence, b: SessionFence): boolean => JSON.stringify(draftFenceParts(a)) === JSON.stringify(draftFenceParts(b));
export const sameDraftTarget = (a: ImageTarget, b: ImageTarget): boolean => canonicalDraftOrigin(a.serverOrigin) === canonicalDraftOrigin(b.serverOrigin) && a.actorUserId === b.actorUserId && sameDraftFence(a.fence, b.fence) && a.expectedNativeSessionId === b.expectedNativeSessionId;
