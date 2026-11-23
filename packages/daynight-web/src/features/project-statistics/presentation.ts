import type { BarChartPoint } from '../../ui/bar-chart';

export const statisticsText = (locale: string) => locale === 'zh-CN' ? {
  tasks: '任务统计', prs: 'PR 统计', total: '总数', dailyTasks: '每日新建任务', dailyPRs: '每日新建 PR', taskFilter: '按负责人筛选每日新建任务', all: '所有人', loading: '正在读取…', retry: '重试', taskError: '无法读取任务统计。', prError: '无法读取 PR 统计。', notConnected: '尚未连接 GitHub', initializing: '正在进行首次 PR 同步…', noSavedData: '暂无已保存的 PR 数据',
} : {
  tasks: 'Task statistics', prs: 'PR statistics', total: 'Total', dailyTasks: 'Tasks created daily', dailyPRs: 'PRs created daily', taskFilter: 'Filter tasks by assignee', all: 'Everyone', loading: 'Loading…', retry: 'Retry', taskError: 'Unable to load task statistics.', prError: 'Unable to load PR statistics.', notConnected: 'GitHub is not connected', initializing: 'Initial PR sync in progress…', noSavedData: 'No saved PR data',
};

export const chartMaximum = (values: readonly bigint[]): bigint => values.reduce((max, value) => value > max ? value : max, 0n);
export const chartPoints = (dates: readonly string[], values: readonly bigint[], locale: string): BarChartPoint[] => dates.map((date, index) => {
  const instant = new Date(`${date}T12:00:00Z`);
  return { key: date, label: new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeZone: 'UTC' }).format(instant), axisLabel: new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric', timeZone: 'UTC' }).format(instant), value: values[index]! };
});
