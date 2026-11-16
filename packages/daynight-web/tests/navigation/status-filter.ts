import type { Page } from '@playwright/test';

const labels = {
  en: { all: 'All statuses', proposed: 'Proposed', todo: 'To do', in_progress: 'In progress', done: 'Done', cancelled: 'Cancelled' },
  'zh-CN': { all: '全部状态', proposed: '待确认', todo: '待办', in_progress: '进行中', done: '已完成', cancelled: '已取消' },
} as const;
type Status = keyof typeof labels.en;

export const statusSummary = (status: Status, locale: keyof typeof labels = 'en') => labels[locale][status];
export const statusButton = (page: Page) => page.locator('.task-status-multifilter > button');

export const selectStatus = async (page: Page, status: Status, locale: keyof typeof labels = 'en') => {
  const root = page.locator('.task-status-multifilter');
  const trigger = statusButton(page);
  await trigger.click();
  for (const [value, label] of Object.entries(labels[locale]).filter(([value]) => value !== 'all')) {
    const option = root.getByRole('checkbox', { name: label, exact: true });
    if (status === 'all' || value === status) await option.check();
    else await option.uncheck();
  }
  await trigger.click();
};
