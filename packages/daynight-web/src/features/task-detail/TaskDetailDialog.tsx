import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TaskDetailSessionBoundary } from './TaskDetailSession';
import { TaskDetailSurface, type TaskDetailSurfaceProps } from './TaskDetailSurface';
import { TypedDetail } from './TypedDetail';
import type { GoalChildren } from '../../app/page-history';
import type { TaskObservationInput } from './TaskDetailSession';

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
  const admission = useRef<{ identity: string; typed: boolean; knownTask: boolean; summary: TaskObservationInput | null }>({ identity, typed: false, knownTask: false, summary: null });
  if (admission.current.identity !== identity) admission.current = { identity, typed: false, knownTask: false, summary: null };
  if (props.observation?.kind === 'direct') { admission.current.typed = true; admission.current.summary = null; }
  else if (props.snapshot != null) {
    if (props.snapshot.summaries.get(props.taskId)?.type !== 'task') admission.current.typed = true;
    else admission.current.knownTask = true;
    if (props.observation?.kind === 'project-summary' && props.observation.revision > 0) admission.current.summary = props.observation;
  } else if (props.observation?.kind !== 'project-summary' || !admission.current.knownTask) admission.current.typed = true;
  const observation = props.snapshot == null && props.observation?.kind === 'project-summary' ? admission.current.summary ?? props.observation : props.observation;
  const knownTask = !admission.current.typed;
  const fullscreenState = { active: fullscreen, onChange: setFullscreen };
  const detailProps = observation === undefined ? props : { ...props, observation };
  return <TaskDetailSessionBoundary>{createPortal(knownTask ? <TaskDetailSurface {...detailProps} fullscreen={fullscreenState} presentation="dialog" /> : <TypedDetail key={`${props.projectId}/${props.taskId}`} {...detailProps} fullscreen={fullscreenState} presentation="dialog" />, document.body)}</TaskDetailSessionBoundary>;
};
