import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TaskDetailSessionBoundary } from './TaskDetailSession';
import { TaskDetailSurface, type TaskDetailSurfaceProps } from './TaskDetailSurface';
import { TypedDetail } from './TypedDetail';
import type { GoalChildren } from '../../app/page-history';

export type TaskDetailDialogProps = Omit<TaskDetailSurfaceProps, 'fullscreen' | 'presentation' | 'attachmentApi' | 'attachmentUrls' | 'detailUrl' | 'onClose' | 'onRestoreFocus'> & {
  readonly onClose: () => void;
  readonly onRestoreFocus: () => void;
  readonly onNavigateExternalTask?: (id: string, trigger: HTMLElement) => void;
  readonly initialWitness?: string;
  readonly goalChildren?: GoalChildren;
  readonly onGoalChildrenChange?: (next: GoalChildren, options?: { readonly replace?: boolean }) => void;
  readonly requireParentMatch?: boolean;
};

export const TaskDetailDialog = (props: TaskDetailDialogProps) => {
  const identity = `${props.projectId}/${props.taskId}`;
  const [fullscreen, setFullscreen] = useState(false);
  const admission = useRef({ identity, typed: false });
  if (admission.current.identity !== identity) admission.current = { identity, typed: false };
  if (props.snapshot == null || props.observation?.kind === 'direct' || props.snapshot.summaries.get(props.taskId)?.type !== 'task') admission.current.typed = true;
  const knownTask = !admission.current.typed;
  const fullscreenState = { active: fullscreen, onChange: setFullscreen };
  return <TaskDetailSessionBoundary>{createPortal(knownTask ? <TaskDetailSurface {...props} fullscreen={fullscreenState} presentation="dialog" /> : <TypedDetail key={`${props.projectId}/${props.taskId}`} {...props} fullscreen={fullscreenState} presentation="dialog" />, document.body)}</TaskDetailSessionBoundary>;
};
