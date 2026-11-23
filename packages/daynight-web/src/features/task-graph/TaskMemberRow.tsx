import type { ComponentProps } from 'react';
import { ProjectTaskRow } from '../projects/ProjectTaskRow';

type Props = ComponentProps<typeof ProjectTaskRow>;

export const TaskMemberRow = ({ instanceId, task, ...props }: Props) =>
  <ProjectTaskRow {...props} task={task} instanceId={`chain-task-${instanceId}-${task.id}`} />;
