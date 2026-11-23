import type { ExecutionPlatform, TaskStatus, TaskTag } from '../../api/types';

export type TaskRowWorker =
  | { readonly kind: 'active' | 'historical'; readonly name: string; readonly currentName?: string }
  | { readonly kind: 'none' | 'unknown' | 'error' };

export type TaskRowSession = {
  readonly state: 'no_session' | 'not_registered' | 'pending' | 'working' | 'notice' | 'warning' | 'unavailable' | 'unobserved' | 'expired' | null;
  readonly needsAttention: boolean | null;
  readonly canOpen: boolean;
};

/** List-independent facts; null means a known absence, never an unavailable read. */
export type TaskRowModel = {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly status: TaskStatus;
  readonly assignedTo: string | null;
  readonly tags: readonly TaskTag[] | 'unknown' | 'error';
  readonly allowAgents: boolean;
  readonly requiredPlatform: ExecutionPlatform | null;
  readonly ready: boolean;
  readonly blocked: boolean;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
  readonly paused: boolean;
  readonly worker: TaskRowWorker;
  readonly session: TaskRowSession | null;
};
