import type { AssignmentMessages } from '../assignment';
export const assignment: AssignmentMessages = {
  label: '负责人', unassigned: '未分配', formerMember: '已失去项目权限',
  personLabel: ({ name }) => `负责人：${name}`,
  search: '搜索人员', loading: '正在加载人员…', loadFailed: '无法加载人员。',
  retry: '重试', noPeople: '没有匹配的人员', all: '所有负责人', me: '分配给我',
  filter: '负责人', noMatches: '没有匹配此负责人的任务',
  matchingChildren: ({ count }) => `${count} 个匹配子任务`,
  uncertain: '待核对', checking: '正在核对…', checkState: '核对当前状态',
  saveFailed: '无法更新负责人。', versionConflict: '任务已变化，请刷新后重新分配。',
  assigneeUnavailable: '此人员已失去项目权限。',
};
