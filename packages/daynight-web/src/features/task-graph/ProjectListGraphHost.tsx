import { useCallback, type ComponentProps } from 'react';
import { TaskChainDialog } from './TaskChainDialog';
import { resolveProjectGraphTarget, type ProjectGraphTarget } from '../projects/project-graph-target';

type ProjectListGraphHostProps = Omit<ComponentProps<typeof TaskChainDialog>, 'onNavigateExternalTask' | 'rootId'> & {
  readonly target: ProjectGraphTarget;
  readonly onNavigateExternalTask?: (id: string, trigger: HTMLElement) => void;
  readonly onOpenChain: (id: string, trigger: HTMLElement) => void;
};

export const ProjectListGraphHost = ({ target, onOpenChain, onNavigateExternalTask, ...dialog }: ProjectListGraphHostProps) => {
  const navigateExternalTask = useCallback((id: string, trigger: HTMLElement) => {
    if (onNavigateExternalTask !== undefined) onNavigateExternalTask(id, trigger);
    else {
      const destination = resolveProjectGraphTarget(id, dialog.index);
      if (destination !== null) onOpenChain(destination.rootId, trigger);
      else { dialog.onClose(); dialog.onOpenTask(id, trigger); }
    }
  }, [dialog.index, dialog.onClose, dialog.onOpenTask, onOpenChain, onNavigateExternalTask]);
  return <TaskChainDialog {...dialog} rootId={target.rootId} onNavigateExternalTask={navigateExternalTask} />;
};
