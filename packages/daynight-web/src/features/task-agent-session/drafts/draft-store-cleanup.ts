import { clearImageDraftAccount, clearImageDraftSession, retryImageDraftCleanup, revokeImageDraftSession } from './draft-store';

export type ImageDraftCleanupScope = {
  readonly origin: string;
  readonly actorUserId: string;
  readonly sessionId: string | null;
  readonly reason: 'account_changed' | 'revoked' | 'deleted';
};
export type ImageDraftCleanupFailure = ImageDraftCleanupScope & { readonly error: Error };
const failures = new Map<string, ImageDraftCleanupFailure>();
const flights = new Map<string, Promise<Error | null>>();
const listeners = new Set<() => void>();
let snapshot: readonly ImageDraftCleanupFailure[] = [];
const keyOf = (scope: ImageDraftCleanupScope) => JSON.stringify([scope.origin, scope.actorUserId, scope.sessionId, scope.reason]);
const publish = () => { snapshot = [...failures.values()]; for (const listener of listeners) listener(); };
const errorValue = (error: unknown) => error instanceof Error ? error : new Error('Local image drafts could not be cleared.', { cause: error });
export const imageDraftCleanupFailures = (): readonly ImageDraftCleanupFailure[] => snapshot;
export const subscribeImageDraftCleanup = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Failures stay observable even when the deleted Session has no mounted pane. */
export function clearImageDraftScope(scope: ImageDraftCleanupScope): Promise<Error | null> {
  const key = keyOf(scope), existing = flights.get(key); if (existing) return existing;
  const action = scope.sessionId === null ? clearImageDraftAccount(scope.origin, scope.actorUserId)
    : scope.reason === 'deleted' ? clearImageDraftSession(scope.origin, scope.actorUserId, scope.sessionId)
      : revokeImageDraftSession(scope.origin, scope.actorUserId, scope.sessionId);
  const flight = action.then(() => { if (failures.delete(key)) publish(); return null; }, error => {
    const failure = errorValue(error); failures.set(key, { ...scope, error: failure }); publish(); return failure;
  }).finally(() => { if (flights.get(key) === flight) flights.delete(key); });
  flights.set(key, flight); return flight;
}

/** Retry physical cleanup without revoking an account that has since been authorized again. */
export async function retryImageDraftScopeCleanup(): Promise<void> {
  await Promise.all([...flights.values()]);
  const observed = [...failures.entries()];
  const accounts = new Map(observed.map(([, failure]) => [JSON.stringify([failure.origin, failure.actorUserId]), failure]));
  for (const account of accounts.values()) {
    try {
      await retryImageDraftCleanup(account.origin, account.actorUserId);
      for (const [key, failure] of observed) if (failure.origin === account.origin && failure.actorUserId === account.actorUserId && failures.get(key) === failure) failures.delete(key);
    } catch (error) {
      for (const [key, failure] of observed) if (failure.origin === account.origin && failure.actorUserId === account.actorUserId && failures.get(key) === failure) failures.set(key, { ...failure, error: errorValue(error) });
    }
  }
  publish();
}
