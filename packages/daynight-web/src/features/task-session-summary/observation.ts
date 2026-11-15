import type { TaskSyncObservation } from '../../api/types';
import type { TaskRowSession } from '../task-row/model';

export type TaskSessionClock = {
  readonly startedAt: string | null;
  readonly responseTaskAt: number;
  readonly responseSessionAt: number;
  readonly receivedMonotonic: number;
};

type Observation = Omit<TaskSyncObservation, 'taskVersion'>;

const deadlines = (observation: Observation, clock: TaskSessionClock, nowMonotonic: number) => {
  const elapsed = Math.max(0, nowMonotonic - clock.receivedMonotonic);
  const expiry = observation.observedAt === null || observation.freshUntil === null ? -Infinity
    : Math.min(Date.parse(observation.freshUntil), Date.parse(observation.observedAt) + 30_000);
  return {
    freshness: expiry - (clock.responseSessionAt + elapsed),
    grace: clock.startedAt === null ? -Infinity : Date.parse(clock.startedAt) + 120_000 - (clock.responseTaskAt + elapsed),
  };
};

export const normalizeTaskSession = (observation: Observation, clock: TaskSessionClock, nowMonotonic: number): TaskRowSession => {
  const { freshness, grace } = deadlines(observation, clock, nowMonotonic);
  const expired = freshness <= 0;
  const state = observation.state === 'unavailable' ? 'unavailable' : expired ? 'expired'
    : observation.state === 'warning' && grace > 0 ? null : observation.state;
  return { state, needsAttention: expired || state === null ? null : observation.needsAttention, canOpen: !expired && observation.canOpen };
};

export const taskSessionNextChange = (observation: Observation, clock: TaskSessionClock, nowMonotonic: number): number | null => {
  const { freshness, grace } = deadlines(observation, clock, nowMonotonic);
  if (freshness <= 0) return null;
  return observation.state === 'warning' && grace > 0 ? Math.min(freshness, grace) : freshness;
};
