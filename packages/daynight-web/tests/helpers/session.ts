import type { SessionSnapshot } from '../../src/api/types';
export type TaskSessionSnapshot = Extract<SessionSnapshot, { readonly claimId: string }> & {
  readonly identity: Extract<SessionSnapshot['identity'], { readonly projectId: string }>;
};
