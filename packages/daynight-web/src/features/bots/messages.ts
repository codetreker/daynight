import { useI18n } from '../../i18n/LocaleProvider';

const en = {
  workerOnline: 'Worker online', details: 'Assistant details', closeDetails: 'Close assistant details', status: 'Status', title: 'Assistants', create: 'Create assistant', createTitle: 'Create assistant', name: 'Name', advanced: 'Advanced settings', worker: 'Worker', cwd: 'Working directory', agent: 'Agent', cancel: 'Cancel', close: 'Close', closeCreate: 'Close creation form', creating: 'Creating…', checkCreation: 'Check creation', checking: 'Checking…',
  unknown: 'The creation result is unknown. Check the original request before trying again.', notConfirmed: 'Creation is not confirmed. Check this ID again before creating another assistant.', defaultsError: 'Could not load creation defaults.', createError: 'Could not create the assistant.', invalidName: 'Enter 1–40 characters without control characters.', invalidCwd: 'Enter an absolute directory path without control characters, or leave it empty to use the Worker default.',
  refresh: 'Refresh', retry: 'Retry', loading: 'Loading…', more: 'Load more', search: 'Search assistants', empty: 'No assistants yet', noMatches: 'No matching assistants', select: 'Choose an assistant to open its conversation.', closeChat: 'Close conversation', listError: 'Could not load assistants.', detailError: 'Could not load this assistant.', pending: 'Starting', ready: 'Started', failed: 'Startup failed', offline: 'Worker offline', unsupported: 'This Worker does not support assistant hosting.', stale: 'The Worker capability report is out of date.', unavailable: 'Assistant hosting is unavailable.', noWorker: 'No available Worker. Connect a Worker that supports assistant hosting.', deleted: 'This assistant has been deleted.', end: 'All assistants are shown.', requestId: 'Request ID', automatic: 'Automatic', defaultAgent: 'Worker default', providerUnavailable: 'This Agent is unavailable on the selected Worker.', host: 'Hosted by', connectionUnknown: 'Connection unconfirmed',
};
const zh: typeof en = {
  workerOnline: 'Worker 在线', details: '助手详情', closeDetails: '关闭助手详情', status: '状态', title: '助手', create: '创建助手', createTitle: '创建助手', name: '名称', advanced: '高级设置', worker: 'Worker', cwd: '工作目录', agent: 'Agent', cancel: '取消', close: '关闭', closeCreate: '关闭创建表单', creating: '正在创建…', checkCreation: '核对创建结果', checking: '正在核对…',
  unknown: '创建结果未知。请先核对原请求，再决定下一步。', notConfirmed: '尚未确认创建结果。创建另一个助手前，请再次核对这个 ID。', defaultsError: '无法读取创建默认值。', createError: '无法创建助手。', invalidName: '请输入 1–40 个字符，不可包含控制字符。', invalidCwd: '请输入不含控制字符的绝对目录路径，或留空使用 Worker 默认目录。',
  refresh: '刷新', retry: '重试', loading: '正在加载…', more: '加载更多', search: '搜索助手', empty: '还没有助手', noMatches: '没有匹配的助手', select: '选择助手，打开对话。', closeChat: '关闭对话', listError: '无法读取助手列表。', detailError: '无法读取这个助手。', pending: '正在启动', ready: '已启动', failed: '启动失败', offline: 'Worker 离线', unsupported: '这个 Worker 不支持助手托管。', stale: 'Worker 能力报告已过期。', unavailable: '助手托管不可用。', noWorker: '没有可用 Worker。请连接支持助手托管的 Worker。', deleted: '这个助手已删除。', end: '已显示全部助手。', requestId: '请求 ID', automatic: '自动选择', defaultAgent: 'Worker 默认', providerUnavailable: '所选 Worker 上的这个 Agent 不可用。', host: '托管于', connectionUnknown: '连接未确认',
};
export const useBotMessages = () => {
  const m = useI18n().locale === 'zh-CN' ? zh : en;
  return { ...m, reason: (code: string): string => {
    if (code === 'no_available_worker') return m.noWorker;
    if (code === 'offline') return m.offline;
    if (code === 'unsupported') return m.unsupported;
    if (code === 'stale') return m.stale;
    if (code === 'invalid_cwd') return m.invalidCwd;
    if (code.startsWith('provider_')) return `${m.providerUnavailable} (${code})`;
    return `${m.unavailable} (${code})`;
  } };
};
