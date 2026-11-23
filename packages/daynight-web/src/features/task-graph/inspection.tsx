import { createContext, useContext } from 'react';
import { useI18n } from '../../i18n/LocaleProvider';

export type TaskInspection = {
  readonly selectedTaskId: string | null;
  // Includes the selected task and every transitive prerequisite.
  readonly highlightedIds: ReadonlySet<string>;
  // Includes the selected task and every transitive successor.
  readonly successorIds: ReadonlySet<string>;
};
export type TaskInspectionState = 'normal' | 'selected' | 'prerequisite' | 'successor' | 'unrelated';
export type DependencyInspectionState = 'normal' | 'highlighted' | 'successor' | 'unrelated';

export const TaskInspectionContext = createContext<TaskInspection | null>(null);

export const useTaskInspection = (): TaskInspection => {
  const inspection = useContext(TaskInspectionContext);
  if (inspection === null) throw new Error('Task inspection requires its graph provider.');
  return inspection;
};

export const getTaskInspectionState = ({ selectedTaskId, highlightedIds, successorIds }: TaskInspection, taskId: string): TaskInspectionState =>
  selectedTaskId === null ? 'normal' : selectedTaskId === taskId ? 'selected'
    : highlightedIds.has(taskId) ? 'prerequisite' : successorIds.has(taskId) ? 'successor' : 'unrelated';

export const getDependencyInspectionState = ({ selectedTaskId, highlightedIds, successorIds }: TaskInspection, source: string, target: string): DependencyInspectionState =>
  selectedTaskId === null ? 'normal'
    : highlightedIds.has(source) && highlightedIds.has(target) ? 'highlighted'
      : successorIds.has(source) && successorIds.has(target) ? 'successor' : 'unrelated';

export const useTaskInspectionState = (taskId: string): TaskInspectionState => getTaskInspectionState(useTaskInspection(), taskId);

export const InspectionLegend = () => {
  const { messages: { graph: m } } = useI18n();
  return <span className="graph-inspection-legend"><span className="graph-prerequisite-legend"><i aria-hidden="true" />{m.prerequisiteLegend}</span><span className="graph-successor-legend"><i aria-hidden="true" />{m.successorLegend}</span></span>;
};
