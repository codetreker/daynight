import { useCallback, type ComponentProps } from 'react';
import { TaskChainDialog } from './TaskChainDialog';
import { GoalGraphDialog } from './GoalGraphDialog';
import { resolveProjectGraphTarget, type ProjectGraphTarget } from '../projects/project-graph-target';

type ProjectListGraphHostProps = Omit<ComponentProps<typeof TaskChainDialog>, 'onNavigateExternalTask' | 'rootId'> & {
  readonly target: ProjectGraphTarget;
  readonly onOpenGoalTask?: (id: string, trigger: HTMLElement) => void;
  readonly graphError?: unknown;
  readonly onRefreshGraph?: () => void;
  readonly onNavigateExternalTask?: (id: string, trigger: HTMLElement) => void;
  readonly onOpenChain: (id: string, trigger: HTMLElement) => void;
};

export const ProjectListGraphHost = ({ target, onOpenChain, onNavigateExternalTask, onOpenGoalTask, graphError, onRefreshGraph, ...dialog }: ProjectListGraphHostProps) => {
  const navigateExternalTask = useCallback((id: string, trigger: HTMLElement) => {
    if (onNavigateExternalTask !== undefined) onNavigateExternalTask(id, trigger);
    else {
      const destination = resolveProjectGraphTarget(id, dialog.index);
      if (destination?.kind === 'chain') onOpenChain(destination.rootId, trigger);
      else { dialog.onClose(); dialog.onOpenTask(id, trigger); }
    }
  }, [dialog.index, dialog.onClose, dialog.onOpenTask, onOpenChain, onNavigateExternalTask]);
  if (target.kind === 'goal') return dialog.summaries === undefined ? null : <GoalGraphDialog {...dialog} summaries={dialog.summaries} goalId={target.goalId} onOpenTask={onOpenGoalTask ?? dialog.onOpenTask} graphError={graphError} {...(onRefreshGraph === undefined ? {} : { onRefreshGraph })} />;
  return <TaskChainDialog {...dialog} rootId={target.rootId} onNavigateExternalTask={navigateExternalTask} />;
};
