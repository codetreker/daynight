export type UsagePayload = Record<string, unknown>;
export type UsageGrant = { token: string; expiresAt: string };
export type UsageState = {
  stateId: string; registrationId: string; generation: string;
  nativeSessionId: string; providerVersion: string; provider: string;
  profileId?: string;
  grant: UsageGrant | null; rowVersion: string | null;
  stateSequence: string; reasons: string[]; stopped: boolean;
  registrationAttempted: boolean; grantRequestAttempted: boolean;
};
export type UsageQueuedEvent = {
  eventId: string; stateId: string; bodyHash: string;
  payload: UsagePayload; byteLength: number;
};
export type UsageAck = {
  eventId: string; sourceKey: string | null; outcome: string;
  bodyHash: string; sourceRevision: string | null; stateSequence: string | null;
  finality: string | null;
};
export type UsageStore = {
  ensureState(generation: string, nativeSessionId: string, providerVersion: string, provider?: string, profileId?: string): UsageState;
  bindTurn(stateId: string, turnId: string): void;
  turnState(nativeSessionId: string, turnId: string): UsageState | null;
  states(): UsageState[];
  getState(stateId: string): UsageState;
  nearCapacity(): boolean;
  saveGrant(stateId: string, grant: UsageGrant, rowVersion: string): void;
  markRegistrationAttempted(stateId: string): void;
  /** Clear only after a confirmed refusal which committed no registration. */
  clearRegistrationAttempted(stateId: string): void;
  markGrantAttempted(stateId: string): void;
  clearGrantAttempted(stateId: string): void;
  /** Apply a pure eligibility predicate before the batch limit, without changing retained events. */
  pending(stateId: string, limit?: number, kind?: "execution_state" | "measurement", eligible?: (event: UsageQueuedEvent) => boolean): UsageQueuedEvent[];
  enqueueMeasurement(stateId: string, body: UsagePayload): "inserted" | "duplicate" | "conflict" | "rejected";
  enqueueState(stateId: string, body: UsagePayload): UsageQueuedEvent;
  acknowledge(flight: readonly UsageQueuedEvent[], results: readonly UsageAck[]): boolean;
  quarantine(eventId: string, reason: string): void;
  gap(stateId: string, reason: string): void;
};
