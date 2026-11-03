import { useEffect, useState, type ReactNode } from 'react';
import { createTaskCacheScope, TaskCacheProvider, type TaskCacheScope } from '../../src/features/task-cache/TaskCacheProvider';
import { TaskAssigneesProvider } from '../../src/features/task-assignees/TaskAssignees';
import { TEST_VIEWER_ID } from './taskSync';

export type TestTaskCacheOptions = {
  readonly viewerId?: string;
  readonly onIdentityMismatch?: () => void;
  readonly scope?: TaskCacheScope;
};

const failIdentityMismatch = (): never => { throw new Error('The test fixture returned another principal.'); };

export const TestTaskCacheBoundary = ({ children, viewerId = TEST_VIEWER_ID, onIdentityMismatch = failIdentityMismatch, scope }: TestTaskCacheOptions & { readonly children: ReactNode }) => {
  const [initialScope] = useState(() => scope ?? createTaskCacheScope({ userId: viewerId, onIdentityMismatch }));
  useEffect(() => scope === undefined ? () => initialScope.dispose() : undefined, [initialScope, scope]);
  return <TaskCacheProvider scope={scope ?? initialScope}><TaskAssigneesProvider>{children}</TaskAssigneesProvider></TaskCacheProvider>;
};

export const createTaskCacheWrapper = (options: TestTaskCacheOptions = {}) =>
  ({ children }: { readonly children: ReactNode }) => <TestTaskCacheBoundary {...options}>{children}</TestTaskCacheBoundary>;
