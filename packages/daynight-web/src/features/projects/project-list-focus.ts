import type { GraphIndex } from '../task-graph/model';
import type { TaskView } from './useProjectViewPreferences';
import type { ProjectGraphTarget } from './project-graph-target';

export type ProjectListOrigin = {
  readonly view: TaskView;
  readonly sourceGoalId: string | null;
  readonly resourceWitness: string;
  readonly trigger: HTMLElement;
};

export const focusVisible = (element: HTMLElement | null | undefined): boolean => {
  if (element == null || !element.isConnected || element.closest('[hidden], [inert]') !== null) return false;
  element.focus({ preventScroll: true });
  return document.activeElement === element;
};

export const focusProjectList = (view: TaskView, origin: ProjectListOrigin | null, target: ProjectGraphTarget | null, index: GraphIndex | null, resourceWitness: string | null = null, detailWitness: string | null = null): boolean => {
  if (origin?.view === view && focusVisible(origin.trigger)) return true;
  const witness = origin?.resourceWitness ?? (target?.kind === 'chain' ? target.witnessTaskId : target?.goalId) ?? resourceWitness ?? detailWitness;
  const list = document.getElementById(view === 'chains' ? 'project-chain-list' : view === 'goals' ? 'project-goal-list' : 'project-standalone-list');
  const sourceGoalId = origin?.view === view ? origin.sourceGoalId : view === 'goals' && witness !== null ? target?.kind === 'goal' ? target.goalId : index?.nodes.get(witness)?.parentId : null;
  if (view === 'goals' && list !== null && sourceGoalId != null) {
    const goal = [...list.querySelectorAll<HTMLElement>('[data-goal-id]')].find((item) => item.dataset.goalId === sourceGoalId);
    if (origin === null && target === null && detailWitness !== null && index?.nodes.get(detailWitness)?.parentId === sourceGoalId) {
      const entry = document.getElementById(`chain-task-goal-${sourceGoalId}-${detailWitness}`);
      if (entry !== null && goal?.contains(entry) && focusVisible(entry)) return true;
    }
    if (target?.kind === 'goal' && focusVisible(goal?.querySelector<HTMLElement>('.goal-list-graph'))) return true;
    if (focusVisible(goal?.querySelector<HTMLElement>('.goal-list-toggle')) || focusVisible(goal?.querySelector<HTMLElement>('.goal-list-detail'))) return true;
  }
  if (view === 'chains' && list !== null) {
    const representative = witness === null ? undefined : target?.kind === 'chain' && target.witnessTaskId === witness ? target.rootId : index?.componentByTask.get(witness);
    const entry = representative === undefined ? null : document.getElementById(`task-root-${representative}`);
    if (entry !== null && list.contains(entry) && focusVisible(entry)) return true;
    if (focusVisible(list.querySelector<HTMLElement>('.root-toggle'))) return true;
  }
  if (view === 'standalone' && focusVisible(list?.querySelector<HTMLElement>('.standalone-row'))) return true;
  return list?.dataset.listEmpty !== "true" && focusVisible(list);
};
