import { describe, expect, it } from 'vitest';
import type { PromptResource } from '../src/api/worker-prompts';
import { freezeSubmission, initialPromptState, promptDirty, promptReducer } from '../src/features/worker-prompts/state';
import type { PromptAction, PromptState } from '../src/features/worker-prompts/state';

const userId = '11111111-1111-4111-8111-111111111111';
const resource = (revision: string, text: string): PromptResource => ({ scope: 'user', scopeId: userId, revision, text, updatedAt: revision === '0' ? null : '2026-01-01T00:00:00Z' });
const apply = (state: PromptState, ...actions: PromptAction[]) => actions.reduce(promptReducer, state);
const loaded = (revision = '1', text = 'original') => apply(initialPromptState(), { type: 'read/start', id: 1 }, { type: 'read/success', id: 1, resource: resource(revision, text) });
const submit = (state: PromptState, id = 2) => {
  const submission = freezeSubmission(state, userId, id);
  if (!submission) throw new Error('Expected a submission');
  return apply(state, { type: 'write/start', submission });
};

describe('prompt editor state', () => {
  it('loads exact text and advances clean reads without normalizing it', () => {
    const text = 'one\r\ntwo\r';
    const state = loaded('1', text);
    expect(state.draft).toBe(text);
    expect(promptDirty(state)).toBe(false);
    const refreshed = apply(state, { type: 'read/start', id: 3 }, { type: 'read/success', id: 3, resource: resource('2', 'new') });
    expect(refreshed).toMatchObject({ baseline: resource('2', 'new'), draft: 'new', conflict: false });
  });

  it('keeps edited drafts and rejects out-of-order reads without losing the highest revision', () => {
    const state = apply(loaded(), { type: 'edit', text: 'mine' }, { type: 'read/start', id: 2 }, { type: 'read/start', id: 3 },
      { type: 'read/success', id: 3, resource: resource('9223372036854775807', 'theirs') },
      { type: 'read/success', id: 2, resource: resource('2', 'old') });
    expect(state).toMatchObject({ draft: 'mine', baseline: resource('1', 'original'), resource: resource('9223372036854775807', 'theirs'), conflict: true });
    expect(freezeSubmission(state, userId, 4)).toBeNull();
    const rebased = apply(state, { type: 'keepDraft' });
    expect(freezeSubmission(rebased, userId, 5)).toMatchObject({ revision: '9223372036854775807', text: 'mine' });
    expect(apply(state, { type: 'useLatest' })).toMatchObject({ draft: 'theirs', conflict: false });
  });

  it('freezes identity and text while edits continue; a newer GET cannot be overwritten by a late PUT', () => {
    let state = apply(loaded(), { type: 'edit', text: 'submitted' });
    state = submit(state);
    expect(state.submission).toMatchObject({ expectedUserId: userId, revision: '1', text: 'submitted' });
    state = apply(state, { type: 'edit', text: 'continued' }, { type: 'read/start', id: 3 },
      { type: 'read/success', id: 3, resource: resource('3', 'other') });
    expect(state.conflict).toBe(false);
    expect(apply(state, { type: 'discard' })).toBe(state);
    state = apply(state, { type: 'write/success', id: 2, resource: resource('2', 'submitted') });
    expect(state).toMatchObject({ resource: resource('3', 'other'), baseline: resource('2', 'submitted'), draft: 'continued', conflict: true });
  });

  it('retains the draft on conflict or definite failure and never treats a background GET as success', () => {
    const pending = submit(apply(loaded(), { type: 'edit', text: '' }));
    const failed = apply(pending, { type: 'write/error', id: 2, error: 'failed' }, { type: 'read/start', id: 3 },
      { type: 'read/success', id: 3, resource: resource('1', 'original') });
    expect(failed).toMatchObject({ draft: '', writeError: 'failed', write: 'idle' });
    expect(freezeSubmission(failed, userId, 4)).toMatchObject({ text: '' });
    const conflict = apply(pending, { type: 'write/conflict', id: 2, error: 'conflict' }, { type: 'read/start', id: 3 },
      { type: 'read/success', id: 3, resource: resource('2', 'other') });
    expect(conflict).toMatchObject({ draft: '', conflict: true, resource: resource('2', 'other') });
  });

  it('does not present a stale baseline as the latest value after a conflict read fails', () => {
    const pending = submit(apply(loaded(), { type: 'edit', text: 'mine' }));
    const conflicted = apply(pending, { type: 'write/conflict', id: 2, error: 'conflict' }, { type: 'read/start', id: 3 }, { type: 'read/error', id: 3, error: 'offline' });
    expect(conflicted).toMatchObject({ draft: 'mine', conflict: true, conflictReady: false });
    expect(apply(conflicted, { type: 'useLatest' })).toBe(conflicted);
    expect(apply(conflicted, { type: 'keepDraft' })).toBe(conflicted);
    const read = apply(conflicted, { type: 'read/start', id: 4 }, { type: 'read/success', id: 4, resource: resource('2', 'theirs') });
    expect(read.conflictReady).toBe(true);
    expect(apply(read, { type: 'useLatest' }).draft).toBe('theirs');
  });

  it('keeps an unknown submission until a successful explicit reconciliation', () => {
    const pending = submit(apply(loaded(), { type: 'edit', text: 'sent' }));
    let state = apply(pending, { type: 'write/unknown', id: 2, error: 'unknown' }, { type: 'edit', text: 'continued' },
      { type: 'read/start', id: 3 }, { type: 'reconcile/error', id: 3, error: 'offline' });
    expect(state).toMatchObject({ write: 'unknown', draft: 'continued', submission: { text: 'sent' }, readError: 'offline' });
    expect(freezeSubmission(state, userId, 4)).toBeNull();
    expect(apply(state, { type: 'useLatest' })).toBe(state);
    state = apply(state, { type: 'read/start', id: 5 }, { type: 'reconcile/success', id: 5, resource: resource('2', 'sent') });
    expect(state).toMatchObject({ baseline: resource('2', 'sent'), draft: 'continued', write: 'idle', reconciled: true, conflict: false });
    expect(freezeSubmission(state, userId, 6)).toMatchObject({ revision: '2', text: 'continued' });
    const differs = apply(pending, { type: 'write/unknown', id: 2, error: 'unknown' }, { type: 'read/start', id: 7 },
      { type: 'reconcile/success', id: 7, resource: resource('1', 'original') });
    expect(differs).toMatchObject({ draft: 'sent', conflict: true, reconciled: true });
  });

  it('ignores stale callbacks after reset and does not replay a pending write', () => {
    const pending = submit(apply(loaded(), { type: 'edit', text: 'secret' }));
    expect(freezeSubmission(pending, userId, 3)).toBeNull();
    const reset = apply(pending, { type: 'reset' }, { type: 'write/success', id: 2, resource: resource('2', 'secret') },
      { type: 'read/success', id: 1, resource: resource('1', 'original') });
    expect(reset).toEqual(initialPromptState());
  });

  it('abandons a draft on navigation without treating an in-flight write as rolled back', () => {
    const pending = submit(apply(loaded(), { type: 'edit', text: 'sent' }));
    const left = apply(pending, { type: 'edit', text: 'later' }, { type: 'abandon' });
    expect(promptDirty(left)).toBe(false);
    expect(left.draft).toBe('original');
    expect(left.submission?.text).toBe('sent');
    const unknown = apply(left, { type: 'write/unknown', id: 2, error: 'unknown' });
    expect(unknown.write).toBe('unknown');
    const checked = apply(unknown, { type: 'read/start', id: 3 }, { type: 'reconcile/success', id: 3, resource: resource('2', 'sent') });
    expect(checked).toMatchObject({ draft: 'sent', baseline: resource('2', 'sent'), write: 'idle', reconciled: true });
    expect(promptDirty(checked)).toBe(false);
  });

  it('protects edits back to the old baseline while a submission or conflicting result is outstanding', () => {
    const pending = submit(apply(loaded(), { type: 'edit', text: 'sent' }));
    const edited = apply(pending, { type: 'edit', text: 'original' });
    expect(promptDirty(edited)).toBe(true);
    const unknown = apply(edited, { type: 'write/unknown', id: 2, error: 'unknown' }, { type: 'read/start', id: 3 }, { type: 'reconcile/success', id: 3, resource: resource('2', 'other') });
    expect(unknown.conflict).toBe(true);
    expect(promptDirty(unknown)).toBe(true);
    const saved = apply(edited, { type: 'write/success', id: 2, resource: resource('2', 'sent') });
    expect(saved.draft).toBe('original');
    expect(promptDirty(saved)).toBe(true);
  });
});
