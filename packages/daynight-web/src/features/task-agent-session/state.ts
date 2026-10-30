import { sessionFenceKey } from '../../../../daynight/src/session/protocol';
import type { SessionEvent, SessionInteraction, SessionOperation, SessionResource, SessionSnapshot, TimelineEntry } from '../../api/types';

export type SessionState = {
  readonly snapshot: SessionSnapshot | null;
  readonly entries: readonly TimelineEntry[];
  readonly resources: ReadonlyMap<string, SessionResource>;
  readonly operations: ReadonlyMap<string, SessionOperation>;
  readonly responseTargets: ReadonlyMap<string, Pick<SessionInteraction, 'interactionId' | 'revision'>>;
  readonly lastEventSeq: string;
  readonly recoveryRequired: boolean;
};
export const emptySessionState = (): SessionState => ({ snapshot: null, entries: [], resources: new Map(), operations: new Map(), responseTargets: new Map(), lastEventSeq: '0', recoveryRequired: false });
export const mergeTimeline = (current: readonly TimelineEntry[], incoming: readonly TimelineEntry[]): readonly TimelineEntry[] => {
  const entries = new Map(current.map((entry) => [entry.entryId, entry]));
  for (const entry of incoming) {
    const previous = entries.get(entry.entryId);
    if (!previous || BigInt(entry.revision) > BigInt(previous.revision)) entries.set(entry.entryId, entry);
  }
  return [...entries.values()].sort((a, b) => BigInt(a.entrySeq) < BigInt(b.entrySeq) ? -1 : BigInt(a.entrySeq) > BigInt(b.entrySeq) ? 1 : a.entryId.localeCompare(b.entryId));
};
export const hydrateSession = (previous: SessionState, snapshot: SessionSnapshot, entries: readonly TimelineEntry[], resources: readonly SessionResource[] = []): SessionState => {
  const sameExecution = previous.snapshot !== null && sessionFenceKey(previous.snapshot) === sessionFenceKey(snapshot);
  const sameHistory = sameExecution && previous.snapshot?.historyEpoch === snapshot.historyEpoch;
  const mergedResources = new Map(sameHistory ? previous.resources : []);
  for (const resource of resources) mergedResources.set(resource.resourceId, resource);
  return { snapshot, entries: mergeTimeline(sameHistory ? previous.entries : [], entries), resources: mergedResources,
    operations: sameExecution ? previous.operations : new Map(), responseTargets: sameExecution ? previous.responseTargets : new Map(), lastEventSeq: snapshot.lastEventSeq, recoveryRequired: false };
};
export const applySessionEvent = (state: SessionState, event: SessionEvent): SessionState => {
  const snapshot = state.snapshot;
  if (!snapshot || sessionFenceKey(event) !== sessionFenceKey(snapshot)) return state;
  if (BigInt(event.eventSeq) <= BigInt(state.lastEventSeq)) {
    if (event.historyEpoch === snapshot.historyEpoch && event.kind === 'snapshot' && BigInt(event.payload.sessionRevision) > BigInt(snapshot.sessionRevision)) return { ...state, snapshot: event.payload };
    return state;
  }
  if (state.recoveryRequired || event.historyEpoch !== snapshot.historyEpoch || BigInt(event.eventSeq) !== BigInt(state.lastEventSeq) + 1n || event.kind === 'gap') return { ...state, recoveryRequired: true };
  const next = { ...state, lastEventSeq: event.eventSeq };
  switch (event.kind) {
    case 'timeline_upsert': return { ...next, entries: mergeTimeline(state.entries, [event.payload]) };
    case 'snapshot': return { ...next, snapshot: BigInt(event.payload.sessionRevision) > BigInt(snapshot.sessionRevision) ? event.payload : snapshot };
    case 'operation': return { ...next, operations: new Map(state.operations).set(event.payload.operationId, event.payload) };
    case 'resource': return { ...next, resources: new Map(state.resources).set(event.payload.resourceId, event.payload) };
  }
};
export const hasPendingOperation = (state: SessionState, kind: SessionOperation['kind']): boolean => [...state.operations.values()].some((operation) => operation.kind === kind && (['accepted', 'offered', 'dispatching', 'unknown'].includes(operation.state) || !['send_message', 'execute_command'].includes(kind) && operation.state === 'provider_accepted'));
export const sessionSendGate = (state: SessionState, connected: boolean): boolean => {
  const s = state.snapshot;
  return connected && !hasPendingControls(state) && !hasPendingOperation(state, 'execute_command') && !hasPendingOperation(state, 'send_message') && !state.recoveryRequired && s !== null && s.synchronized && s.connectionState === 'connected' && s.lifecycle === 'active' && s.operations.canSend && s.capabilities.send &&
    (s.identity.nativeSessionId !== null || s.testExecutionId !== undefined && s.initialInputState === 'not_required' && s.activity === 'idle') && (s.initialInputState === 'provider_accepted' || s.initialInputState === 'confirmed' || s.testExecutionId !== undefined && s.initialInputState === 'not_required') &&
    (s.activity === 'idle' || s.activity === 'working' && s.capabilities.steer && s.currentTurnId !== null);
};
export const hasPendingResponse = (state: SessionState, interaction: Pick<SessionInteraction, 'interactionId' | 'revision'>): boolean => [...state.operations.values()].some(operation => {
  const target = state.responseTargets.get(operation.operationId);
  return operation.kind === 'interaction_response' && ['accepted', 'offered', 'dispatching', 'provider_accepted', 'unknown'].includes(operation.state) && target?.interactionId === interaction.interactionId && target.revision === interaction.revision;
});
export const sessionRespondGate = (state: SessionState, connected: boolean, interaction?: Pick<SessionInteraction, 'interactionId' | 'revision'>): boolean => {
  const s = state.snapshot;
  return connected && (interaction === undefined || !hasPendingResponse(state, interaction)) && !state.recoveryRequired && s !== null && s.synchronized && s.connectionState === 'connected' && s.lifecycle === 'active' && s.operations.canRespond && s.capabilities.respond;
};
export const sessionCancelGate = (state: SessionState, connected: boolean): boolean => {
  const s = state.snapshot;
  return connected && !hasPendingOperation(state, 'cancel') && !state.recoveryRequired && s !== null && s.synchronized && s.connectionState === 'connected' && s.lifecycle === 'active' && s.operations.canCancel && s.capabilities.cancel && s.currentTurnId !== null;
};

export const hasPendingControls = (state: SessionState): boolean => hasPendingOperation(state, 'update_setting') || hasPendingOperation(state, 'refresh_controls');
export const sessionControlGate = (state: SessionState, connected: boolean): boolean => {
  const s = state.snapshot;
  return connected && !state.recoveryRequired && !hasPendingControls(state) && !hasPendingOperation(state, 'execute_command') && !hasPendingOperation(state, 'send_message') && s !== null && s.synchronized && s.connectionState === 'connected' && s.lifecycle === 'active' && ['idle', 'working', 'waiting_input'].includes(s.activity) && ['not_required', 'provider_accepted', 'confirmed'].includes(s.initialInputState);
};
