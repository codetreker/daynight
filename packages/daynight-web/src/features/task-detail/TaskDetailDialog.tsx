import { useState } from 'react';
import { createPortal } from 'react-dom';
import { TaskDetailSessionBoundary } from './TaskDetailSession';
import { TaskDetailSurface, type TaskDetailSurfaceProps } from './TaskDetailSurface';

export type TaskDetailDialogProps = Omit<TaskDetailSurfaceProps, 'fullscreen' | 'presentation' | 'navigation' | 'onNavigate' | 'attachmentApi' | 'attachmentUrls' | 'detailUrl' | 'onClose' | 'onRestoreFocus'> & {
  readonly onClose: () => void;
  readonly onRestoreFocus: () => void;
};

export const TaskDetailDialog = (props: TaskDetailDialogProps) => {
  const [fullscreen, setFullscreen] = useState(false);
  return <TaskDetailSessionBoundary>{createPortal(<TaskDetailSurface {...props} fullscreen={{ active: fullscreen, onChange: setFullscreen }} presentation="dialog" />, document.body)}</TaskDetailSessionBoundary>;
};
