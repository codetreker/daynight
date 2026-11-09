import type { PromptResource } from '../../api/worker-prompts';

export type PromptSubmission = {
  readonly id: number;
  readonly expectedUserId: string;
  readonly revision: string;
  readonly text: string;
  readonly editGeneration: number;
};

export type PromptState = {
  readonly resource: PromptResource | null;
  readonly baseline: PromptResource | null;
  readonly draft: string;
  readonly editGeneration: number;
  readonly read: 'idle' | 'pending' | 'error';
  readonly readId: number | null;
  readonly readError: string | null;
  readonly submission: PromptSubmission | null;
  readonly write: 'idle' | 'pending' | 'unknown';
  readonly writeError: string | null;
  readonly conflict: boolean;
  readonly conflictReady: boolean;
  readonly reconciled: boolean;
  readonly abandoned: boolean;
};

export const initialPromptState = (): PromptState => ({
  resource: null, baseline: null, draft: '', editGeneration: 0,
  read: 'idle', readId: null, readError: null,
  submission: null, write: 'idle', writeError: null, conflict: false, conflictReady: false, reconciled: false, abandoned: false,
});

export const promptDirty = (state: PromptState): boolean => !state.abandoned && state.baseline !== null && (
  state.draft !== state.baseline.text ||
  state.submission !== null && state.draft !== state.submission.text ||
  state.conflict && (!state.conflictReady || state.resource !== null && state.draft !== state.resource.text)
);

// A revision is an int64 string, never a JavaScript number. Input is validated by the API boundary.
const newer = (current: PromptResource | null, incoming: PromptResource): PromptResource =>
  current === null || BigInt(incoming.revision) > BigInt(current.revision) ? incoming : current;

export const freezeSubmission = (state: PromptState, expectedUserId: string, id: number): PromptSubmission | null => {
  if (!state.baseline || state.write !== 'idle' || state.conflict) return null;
  return { id, expectedUserId, revision: state.baseline.revision, text: state.draft, editGeneration: state.editGeneration };
};

export type PromptAction =
  | { type: 'reset' }
  | { type: 'edit'; text: string }
  | { type: 'read/start'; id: number }
  | { type: 'read/success'; id: number; resource: PromptResource }
  | { type: 'read/error'; id: number; error: string }
  | { type: 'write/start'; submission: PromptSubmission }
  | { type: 'write/success'; id: number; resource: PromptResource }
  | { type: 'write/conflict'; id: number; error: string }
  | { type: 'write/error'; id: number; error: string }
  | { type: 'write/unknown'; id: number; error: string }
  | { type: 'write/cancel'; id: number }
  | { type: 'reconcile/success'; id: number; resource: PromptResource }
  | { type: 'reconcile/error'; id: number; error: string }
  | { type: 'useLatest' }
  | { type: 'keepDraft' }
  | { type: 'abandon' }
  | { type: 'discard' };

export const promptReducer = (state: PromptState, action: PromptAction): PromptState => {
  switch (action.type) {
    case 'reset': return initialPromptState();
    case 'edit':
      return action.text === state.draft ? state : { ...state, draft: action.text, editGeneration: state.editGeneration + 1, reconciled: false, abandoned: false };
    case 'read/start': return { ...state, read: 'pending', readId: action.id, readError: null };
    case 'read/error':
    case 'reconcile/error':
      return state.readId !== action.id ? state : { ...state, read: 'error', readId: null, readError: action.error };
    case 'read/success': {
      if (state.readId !== action.id) return state;
      const resource = newer(state.resource, action.resource);
      const result = { ...state, resource, read: 'idle' as const, readId: null, readError: null };
      if (state.write !== 'idle') return result;
      if (!state.baseline || (!promptDirty(state) && !state.conflict)) return { ...result, baseline: resource, draft: resource.text };
      const newerRevision = BigInt(resource.revision) > BigInt(state.baseline.revision);
      const observedNewer = BigInt(action.resource.revision) > BigInt(state.baseline.revision);
      return { ...result, conflict: state.conflict || newerRevision, conflictReady: state.conflictReady || observedNewer };
    }
    case 'write/start': {
      const submission = action.submission;
      if (state.write !== 'idle' || state.conflict || !state.baseline || submission.revision !== state.baseline.revision || submission.text !== state.draft || submission.editGeneration !== state.editGeneration) return state;
      return { ...state, submission, write: 'pending', writeError: null, reconciled: false };
    }
    case 'write/success': {
      const submission = state.submission;
      if (state.write !== 'pending' || !submission || submission.id !== action.id) return state;
      const resource = newer(state.resource, action.resource);
      const edited = state.editGeneration !== submission.editGeneration;
      const later = BigInt(resource.revision) > BigInt(action.resource.revision);
      if (!edited || state.abandoned) return { ...state, resource, baseline: resource, draft: resource.text, submission: null, write: 'idle', writeError: null, conflict: false, conflictReady: false, abandoned: false };
      return { ...state, resource, baseline: action.resource, submission: null, write: 'idle', writeError: null, conflict: later, conflictReady: later };
    }
    case 'write/conflict':
    case 'write/error':
      if (state.write !== 'pending' || state.submission?.id !== action.id) return state;
      if (state.abandoned && state.resource) return { ...state, baseline: state.resource, draft: state.resource.text, submission: null, write: 'idle', writeError: action.error, conflict: false, conflictReady: false, abandoned: false };
      const newerRevision = state.baseline !== null && state.resource !== null && BigInt(state.resource.revision) > BigInt(state.baseline.revision);
      return { ...state, submission: null, write: 'idle', writeError: action.error,
        conflict: action.type === 'write/conflict' || newerRevision, conflictReady: action.type === 'write/conflict' ? false : newerRevision };
    case 'write/unknown':
      if (state.write !== 'pending' || state.submission?.id !== action.id) return state;
      return { ...state, write: 'unknown', writeError: action.error };
    case 'write/cancel':
      if (state.write !== 'pending' || state.submission?.id !== action.id || !state.resource) return state;
      return { ...state, baseline: state.resource, draft: state.resource.text, submission: null, write: 'idle', writeError: null, conflict: false, conflictReady: false, abandoned: false };
    case 'reconcile/success': {
      if (state.write !== 'unknown' || !state.submission || state.readId !== action.id) return state;
      const resource = newer(state.resource, action.resource);
      const matches = resource.text === state.submission.text;
      return { ...state, resource, baseline: matches || state.abandoned ? resource : state.baseline, draft: state.abandoned ? resource.text : state.draft, read: 'idle', readId: null, readError: null,
        submission: null, write: 'idle', writeError: null, conflict: !matches && !state.abandoned, conflictReady: !matches && !state.abandoned, reconciled: true, abandoned: false };
    }
    case 'abandon':
      if (state.write !== 'idle') return { ...state, draft: state.resource?.text ?? state.baseline?.text ?? '', abandoned: true };
      return promptReducer(state, { type: 'discard' });
    case 'useLatest':
    case 'discard':
      if (action.type === 'useLatest' && state.conflict && !state.conflictReady) return state;
      if (state.write !== 'idle' || !state.resource) return state;
      return { ...state, baseline: state.resource, draft: state.resource.text, editGeneration: state.editGeneration + 1, conflict: false, conflictReady: false, writeError: null, reconciled: false, abandoned: false };
    case 'keepDraft':
      if (state.write !== 'idle' || !state.resource || !state.conflict || !state.conflictReady) return state;
      return { ...state, baseline: state.resource, conflict: false, conflictReady: false, writeError: null, reconciled: false };
  }
};
