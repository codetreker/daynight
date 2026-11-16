import { useMemo } from 'react';
import type { PersonalTaskItem } from '../../api/personal-tasks';
import { useCurrentAccount } from '../../app/CurrentAccountContext';
import { taskDetailUrl } from '../../app/router';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { TaskAssigneeDisplay } from '../task-assignment/TaskAssigneeIdentity';
import { ClockInputProvider } from '../task-execution/TaskExecutionClock';
import { TaskRow } from '../task-row/TaskRow';
import { personalTaskRowModel } from './personal-task-row';
import { usePersonalTaskObservation } from './PersonalTaskObservations';

export type OpenPersonalDetail = (projectId: string, id: string, trigger: HTMLElement, tab: 'overview' | 'session') => void;

const Content = ({ item, open, active }: { readonly item: PersonalTaskItem; readonly open: OpenPersonalDetail; readonly active: boolean }) => {
  const account = useCurrentAccount();
  const scope = useTaskCacheScope();
  const session = usePersonalTaskObservation(item.task.id);
  if (account.user.id !== scope.userId || scope.isInvalidated) return null;
  const { task, project } = item;
  const model = personalTaskRowModel(item, scope.userId, session);
  const admitted = active && !account.admissionBlocked;
  const href = (id: string) => taskDetailUrl(project.id, id, { tab: 'overview', path: null });
  return <TaskRow model={model} projectId={project.id} tagsActive={admitted} href={href(task.id)} instanceId={`personal-task-${project.id}-${task.id}`}
    assignee={<TaskAssigneeDisplay assignedTo={account.user.id} person={{ name: account.user.name, avatarUrl: account.user.avatarUrl, hasProjectAccess: true }} />}
    {...(task.goal === null ? {} : { goal: { title: task.goal.title, href: href(task.goal.id), onOpen: (trigger: HTMLElement) => open(project.id, task.goal!.id, trigger, 'overview') } })}
    onOpenTask={(id, trigger) => open(project.id, id, trigger, 'overview')}
    {...(admitted ? { onOpenSession: (id: string, trigger: HTMLElement) => open(project.id, id, trigger, 'session') } : {})} />;
};

export const PersonalTaskRow = ({ item, open, active }: { readonly item: PersonalTaskItem; readonly open: OpenPersonalDetail; readonly active: boolean }) => {
  const input = useMemo(() => ({ observedAt: item.responseTaskAt, receivedMonotonic: item.receivedMonotonic, warningMinutes: item.project.executionWarningMinutes }), [item.responseTaskAt, item.receivedMonotonic, item.project.executionWarningMinutes]);
  return <ClockInputProvider input={input}><Content item={item} open={open} active={active} /></ClockInputProvider>;
};
