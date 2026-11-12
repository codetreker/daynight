import { useCallback, type ComponentProps } from 'react';
import { TaskChainDialog } from './TaskChainDialog';

type ProjectListGraphHostProps = Omit<ComponentProps<typeof TaskChainDialog>, 'onNavigateExternalTask'> & {
  readonly onNavigateExternalTask?: (id: string, trigger: HTMLElement) => void;
  readonly onOpenChain: (id: string, trigger: HTMLElement) => void;
};

export const ProjectListGraphHost = ({ onOpenChain, onNavigateExternalTask, ...dialog }: ProjectListGraphHostProps) => {
  const navigateExternalTask = useCallback((id: string, trigger: HTMLElement) => {
    if (onNavigateExternalTask !== undefined) onNavigateExternalTask(id, trigger);
    else {
      const representative = dialog.index.componentByTask.get(id)!;
      if (dialog.index.components.get(representative)!.memberIds.size > 1) onOpenChain(representative, trigger);
      else { dialog.onClose(); dialog.onOpenTask(id, trigger); }
    }
  }, [dialog.index, dialog.onClose, dialog.onOpenTask, onOpenChain, onNavigateExternalTask]);
  return <TaskChainDialog {...dialog} onNavigateExternalTask={navigateExternalTask} />;
};
