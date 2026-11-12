import type { GraphIndex } from '../task-graph/model';
import type { TaskView } from './useProjectViewPreferences';

export type ProjectListOrigin = {
  readonly view: TaskView;
  readonly sourceGoalId: string | null;
  readonly taskWitness: string;
  readonly trigger: HTMLElement;
};

export const focusVisible = (element: HTMLElement | null | undefined): boolean => {
  if (element == null || !element.isConnected || element.closest('[hidden], [inert]') !== null) return false;
  element.focus({ preventScroll: true });
  return document.activeElement === element;
};

export const focusProjectList = (view: TaskView, origin: ProjectListOrigin | null, witness: string | null, index: GraphIndex | null): boolean => {
  if (origin?.view === view && focusVisible(origin.trigger)) return true;
  const list = document.getElementById(view === 'chains' ? 'project-chain-list' : view === 'goals' ? 'project-goal-list' : 'project-standalone-list');
  if (list !== null && origin?.view === view && origin.sourceGoalId !== null) {
    const goal = [...list.querySelectorAll<HTMLElement>('[data-goal-id]')].find((item) => item.dataset.goalId === origin.sourceGoalId);
    if (focusVisible(goal?.querySelector<HTMLElement>('.goal-toggle'))) return true;
  }
  if (view === 'chains' && list !== null) {
    const representative = witness === null ? undefined : index?.componentByTask.get(witness);
    const entry = representative === undefined ? null : document.getElementById(`task-root-${representative}`);
    if (entry !== null && list.contains(entry) && focusVisible(entry)) return true;
    if (focusVisible(list.querySelector<HTMLElement>('.root-toggle'))) return true;
  }
  if (view === 'standalone' && focusVisible(list?.querySelector<HTMLElement>('.standalone-row'))) return true;
  return list?.dataset.listEmpty !== "true" && focusVisible(list);
};
