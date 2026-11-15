import type { ComponentProps } from 'react';
import { ProjectTaskRow } from './ProjectTaskRow';

type Props = Omit<ComponentProps<typeof ProjectTaskRow>, 'onOpenTask' | 'workerMachine'> & {
  readonly onSelectTask: (id: string, trigger: HTMLElement) => void;
  readonly workerMachine?: ComponentProps<typeof ProjectTaskRow>['workerMachine'];
};

export const StandaloneTaskRow = ({ onSelectTask, workerMachine, ...props }: Props) =>
  <ProjectTaskRow {...props} workerMachine={workerMachine} onOpenTask={onSelectTask} />;
