import { assertSessionFence, parseSessionOperation, type SessionCommand, type SessionFence, type SessionOperation } from '../../../../../daynight/src/session/protocol';
import type { SessionDraftStore } from './draft-store';
import type { DraftHandle, DraftSnapshot, DraftSubmission } from './draft-types';

export function draftOperationOutcome(operation: SessionOperation): 'accepted' | 'rejected' | 'pending' {
  if (operation.state === 'provider_accepted' || operation.state === 'confirmed') return 'accepted';
  if (operation.state === 'failed' || operation.state === 'rejected' || operation.state === 'expired') return 'rejected';
  return 'pending';
}
export function assertDraftOperation(command: SessionFence & Pick<SessionCommand, 'operationId' | 'kind'>, value: SessionOperation): void {
  const operation = parseSessionOperation(value);
  assertSessionFence(operation, command);
  if (operation.operationId !== command.operationId || operation.kind !== command.kind) throw new Error('Image submission receipt does not match the original operation.');
}

/** Locks only serialize network work. The IndexedDB claim remains the dispatch authority. */
export async function underDraftLock<T>(locks: LockManager | null, ownerKey: string, purpose: string, action: () => Promise<T>): Promise<T> {
  if (!locks) throw new Error('image_locks_unavailable');
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ownerKey)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return locks.request(`daynight:session-draft:${hash}:${purpose}`, { mode: 'exclusive', ifAvailable: true }, lock => {
    if (!lock) throw new Error('image_another_window_busy');
    return action();
  });
}

export type DraftSendOptions = {
  readonly store: SessionDraftStore;
  readonly locks: LockManager | null;
  readonly isCurrent: () => boolean;
  readonly admit: (snapshot: DraftSnapshot, prepared?: DraftSubmission) => string | null;
  readonly command: (snapshot: DraftSnapshot) => SessionCommand;
  readonly dispatch: (command: SessionCommand) => Promise<SessionOperation>;
  readonly query: (fence: SessionFence, operationId: string, signal?: AbortSignal) => Promise<SessionOperation>;
  readonly signal?: AbortSignal;
  readonly isDefinitiveNotDispatched?: (error: unknown) => boolean;
  readonly changed: (snapshot: DraftSnapshot) => void;
};

/** Never regenerates an ID after freezing, including recovery of a claimed dispatch. */
export class DraftSender {
  constructor(private readonly options: DraftSendOptions) {}
  private live(): void { if (!this.options.isCurrent()) throw new Error('image_target_changed'); }
  async send(handle: DraftHandle): Promise<void> {
    const o = this.options;
    const dispatch = async () => {
      this.live();
      let snapshot = await o.store.read(handle);
      this.live();
      let submission = snapshot.submission;
      if (submission && submission.state !== 'prepared') {
        await this.check(handle, submission);
        return;
      }
      const issue = o.admit(snapshot, submission ?? undefined);
      if (issue) {
        if (submission) {
          this.live(); const restored = await o.store.refusePrepared(handle, submission.operationId);
          this.live(); o.changed(restored);
        }
        throw new Error(issue);
      }
      if (!submission) {
        const draft = snapshot.editable!;
        snapshot = await o.store.freeze(handle, { draftId: draft.draftId, expectedStoreVersion: draft.storeVersion, command: o.command(snapshot) });
        this.live(); o.changed(snapshot); submission = snapshot.submission!;
      }
      const claim = await o.store.claimDispatch(handle, submission.operationId);
      if (!claim) { this.live(); await this.check(handle, submission); return; }
      if (!o.isCurrent()) {
        await o.store.refuseClaimed(handle, claim.authority);
        return;
      }
      const claimed = claim.submission;
      snapshot = await o.store.read(handle);
      if (!o.isCurrent() || o.admit(snapshot, claimed)) {
        // The request has not been called, so this is a proven local refusal.
        const restored = await o.store.refuseClaimed(handle, claim.authority);
        if (o.isCurrent()) o.changed(restored);
        return;
      }
      let operation: SessionOperation;
      try {
        operation = await o.dispatch(claimed.command!);
      } catch (error) {
        if (o.isDefinitiveNotDispatched?.(error)) {
          const restored = await o.store.refuseClaimed(handle, claim.authority);
          if (!o.isCurrent()) return;
          o.changed(restored);
          throw error;
        }
        if (!o.isCurrent()) return;
        const command = claimed.command!;
        o.changed(await o.store.observeSubmission(handle, claimed.operationId, { ...claimed.fence, protocol: command.protocol, operationId: command.operationId, kind: command.kind, state: 'unknown', providerResult: null, error: null }));
        return;
      }
      this.live();
      await this.observe(handle, claimed, operation);
    };
    if (o.locks) await underDraftLock(o.locks, handle.ownerKey, 'send', dispatch);
    else {
      this.live(); const snapshot = await o.store.read(handle); this.live();
      if ((snapshot.editable ?? snapshot.frozen)?.items.length) throw new Error('image_locks_unavailable');
      await dispatch();
    }
  }
  async check(handle: DraftHandle, submission: DraftSubmission): Promise<void> {
    this.live(); this.options.signal?.throwIfAborted();
    const operation = await this.options.query(submission.fence, submission.operationId, this.options.signal);
    this.live(); this.options.signal?.throwIfAborted();
    await this.observe(handle, submission, operation);
  }
  private async observe(handle: DraftHandle, submission: DraftSubmission, operation: SessionOperation): Promise<void> {
    const original = { ...submission.fence, operationId: submission.operationId, kind: submission.kind };
    assertDraftOperation(original, operation);
    const outcome = draftOperationOutcome(operation), o = this.options;
    this.live();
    const snapshot = outcome === 'pending'
      ? await o.store.observeSubmission(handle, submission.operationId, operation)
      : await o.store.settleSubmission(handle, { operationId: submission.operationId, outcome, operation });
    this.live(); o.changed(snapshot);
  }
}
