import { useEffect, useState, type ReactNode } from 'react';
import { createTaskCacheScope, TaskCacheProvider } from '../../src/features/task-cache/TaskCacheProvider';
import { TEST_VIEWER_ID } from './taskSync';

export type TestTaskCacheOptions = {
  readonly viewerId?: string;
  readonly onIdentityMismatch?: () => void;
};

const failIdentityMismatch = (): never => { throw new Error('The test fixture returned another principal.'); };

export const TestTaskCacheBoundary = ({ children, viewerId = TEST_VIEWER_ID, onIdentityMismatch = failIdentityMismatch }: TestTaskCacheOptions & { readonly children: ReactNode }) => {
  const [scope] = useState(() => createTaskCacheScope({ userId: viewerId, onIdentityMismatch }));
  useEffect(() => () => scope.dispose(), [scope]);
  return <TaskCacheProvider scope={scope}>{children}</TaskCacheProvider>;
};

export const createTaskCacheWrapper = (options: TestTaskCacheOptions = {}) =>
  ({ children }: { readonly children: ReactNode }) => <TestTaskCacheBoundary {...options}>{children}</TestTaskCacheBoundary>;
