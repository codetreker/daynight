import type { PersonalTaskItem } from '../../api/personal-tasks';
import { normalizeTaskSession, taskSessionNextChange, type TaskSessionClock } from '../task-session-summary/observation';

const clockFor = (item: PersonalTaskItem): TaskSessionClock => ({
  startedAt: item.task.startedAt, responseTaskAt: Date.parse(item.responseTaskAt),
  responseSessionAt: Date.parse(item.responseSessionAt), receivedMonotonic: item.receivedMonotonic,
});

export const personalTaskSession = (item: PersonalTaskItem, nowMonotonic: number) =>
  normalizeTaskSession(item.sessionRow, clockFor(item), nowMonotonic);

export const personalTaskSessionNextChange = (item: PersonalTaskItem, nowMonotonic: number) =>
  taskSessionNextChange(item.sessionRow, clockFor(item), nowMonotonic);
