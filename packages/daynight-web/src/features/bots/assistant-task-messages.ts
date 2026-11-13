import { useI18n } from '../../i18n/LocaleProvider';

const en = {
  staleDraft: 'This task changed while you were editing. Your draft is kept. Cancel and review the current content before editing again.',
  body: 'Manual', rules: 'Structured rules', appendix: 'Notes / appendix', history: 'Revision history', current: 'Current version',
  noAppendix: 'No appendix notes yet', appendixBoundary: 'Appendix notes are references. They do not authorize additional direct actions.',
  edit: 'Edit', remove: 'Delete', confirmRemove: 'Delete this appendix note?', cancel: 'Cancel', save: 'Save', text: 'Note',
  rollback: 'Roll back to v{version}', rollbackConfirm: 'Create a new manual version with the content of v{version}?', confirmRollback: 'Confirm rollback',
  initial: 'Initial manual', revision: 'Approved revision', rollbackSource: 'Rollback', evidence: 'Evidence records', record: 'Record {id}',
  pending: 'Awaiting your decision', approved: 'Approved', edited: 'Approved with changes', rejected: 'Rejected',
  proposals: 'Manual revision proposals', noProposals: 'No pending proposals', base: 'Based on v{version}',
  widens: 'Expands direct actions', widensExplanation: 'Review the proposed rules and their limits before approving additional direct actions.',
  proposedBody: 'Proposed manual', proposedRules: 'Proposed structured rules', reason: 'Reason', decisionNote: 'Decision note',
  approve: 'Approve', editApprove: 'Edit and approve', reject: 'Reject', rejectReason: 'Reason for rejection',
  invalidRules: 'Enter valid JSON for the structured rules.', noHistory: 'No revision history',
  moreHistory: 'Load more history', moreRecords: 'Load more records', loading: 'Loading…', retry: 'Retry',
  recordsError: 'Could not load work records.', itemsError: 'Could not load items.',
  records: 'Work records', noRecords: 'No work records yet', noMatches: 'No matching records on the loaded pages',
  loadedOnly: 'Type and author filters apply to the loaded records.', clearFilters: 'Clear filters', all: 'All',
  item: 'Item', allItems: 'All items', general: 'Task-wide records', open: 'Open', closed: 'Closed',
  kind: 'Record type', author: 'Author', allAuthors: 'All authors', system: 'System', unknownAssistant: 'Assistant {id}',
  fact: 'Fact', guess: 'Assessment', action: 'Action', unknown: 'Unknown', question: 'Question', answer: 'Answer', note: 'Note',
  recordMissing: 'The referenced record was not found.', references: 'References', resourcesUnavailable: 'Resource unavailable', table: 'Table',
};
const zh: typeof en = {
  staleDraft: '编辑期间任务已变化，草稿已保留。请取消编辑，核对最新内容后重新编辑。',
  body: '手册正文', rules: '结构化规则', appendix: '注意事项 / 附录', history: '修订历史', current: '当前版本',
  noAppendix: '附录还是空的', appendixBoundary: '附录仅供参考，不会扩大无需询问的直接动作。',
  edit: '编辑', remove: '删除', confirmRemove: '删除这条附录？', cancel: '取消', save: '保存', text: '注意事项',
  rollback: '回退到 v{version}', rollbackConfirm: '使用 v{version} 的内容创建一个新的手册版本？', confirmRollback: '确认回退',
  initial: '初始手册', revision: '已批准的修订', rollbackSource: '回退', evidence: '依据的工作记录', record: '记录 {id}',
  pending: '待你决定', approved: '已同意', edited: '修改后同意', rejected: '已拒绝',
  proposals: '手册修订提案', noProposals: '没有待决定的提案', base: '基于 v{version}',
  widens: '扩大直接动作', widensExplanation: '同意扩大直接动作前，请核对提案中的规则及其边界。',
  proposedBody: '修订后的手册', proposedRules: '修订后的结构化规则', reason: '修订理由', decisionNote: '决定说明',
  approve: '同意', editApprove: '修改后同意', reject: '拒绝', rejectReason: '拒绝理由',
  invalidRules: '请输入有效的 JSON 结构化规则。', noHistory: '还没有修订历史',
  moreHistory: '加载更多历史', moreRecords: '加载更多记录', loading: '正在加载…', retry: '重试',
  recordsError: '无法读取工作记录。', itemsError: '无法读取事项。',
  records: '工作记录', noRecords: '还没有工作记录', noMatches: '已加载记录中没有符合条件的记录',
  loadedOnly: '类型与作者筛选适用于已加载的记录。', clearFilters: '清除筛选', all: '全部',
  item: '事项', allItems: '全部事项', general: '任务整体记录', open: '处理中', closed: '已结束',
  kind: '记录类型', author: '作者', allAuthors: '全部作者', system: '系统', unknownAssistant: '助手 {id}',
  fact: '事实', guess: '推测', action: '动作', unknown: '未知', question: '提问', answer: '回答', note: '注意事项',
  recordMissing: '未找到引用的工作记录。', references: '引用', resourcesUnavailable: '资源不可用', table: '表格',
};
export const useAssistantTaskContentMessages = () => {
  const { locale } = useI18n();
  return { ...(locale === 'zh-CN' ? zh : en), locale };
};
