import { useEffect, type ReactNode } from 'react';
import { TaskCacheProvider } from '../../src/features/task-cache/TaskCacheProvider';
import { TaskDetailSessionBoundary, useTaskDetailSessions } from '../../src/features/task-detail/TaskDetailSession';
import { detailProjectId, type createTaskDetailFixture } from './task-detail-fixture';

type Fixture = ReturnType<typeof createTaskDetailFixture>;
const ProjectRefresh = ({ fixture }: { readonly fixture: Fixture }) => {
  const sessions = useTaskDetailSessions();
  useEffect(() => sessions.subscribeProject(detailProjectId, () => { void fixture.refresh(); }), [sessions, fixture]);
  return null;
};

export const TaskDetailFixtureBoundary = ({ fixture, children }: { readonly fixture: Fixture; readonly children: ReactNode }) =>
  <TaskCacheProvider scope={fixture.scope}><TaskDetailSessionBoundary><ProjectRefresh fixture={fixture} />{children}</TaskDetailSessionBoundary></TaskCacheProvider>;
