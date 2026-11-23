import { fireEvent, screen, within } from '@testing-library/react';

const labels = { proposed: '待确认', todo: '待办', in_progress: '进行中', done: '已完成', cancelled: '已取消' } as const;
type Status = keyof typeof labels;

export const statusLabel = (status: Status | 'all') => status === 'all' ? '全部状态' : labels[status];
export const statusTrigger = () => screen.getByRole('button', { name: /^状态:/ });

export const selectStatuses = (statuses: readonly Status[]) => {
  const trigger = statusTrigger();
  fireEvent.click(trigger);
  const root = trigger.closest('.task-status-filter')!;
  for (const [value, label] of Object.entries(labels)) {
    const checkbox = within(root as HTMLElement).getByRole('checkbox', { name: label }) as HTMLInputElement;
    if (checkbox.checked !== statuses.includes(value as Status)) fireEvent.click(checkbox);
  }
  fireEvent.click(trigger);
};

export const selectStatus = (status: Status | 'all') => selectStatuses(status === 'all' ? Object.keys(labels) as Status[] : [status]);
