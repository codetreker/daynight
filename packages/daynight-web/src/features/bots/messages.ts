import { useI18n } from '../../i18n/LocaleProvider';

const en = {
  welcomeTitle: 'Start with a conversation', welcomeDescription: 'Check progress, clarify an idea, or move your work forward.',
  conversationStarters: [
    { label: 'See which tasks are running', prompt: 'Show me which tasks are running right now' },
    { label: 'Break an idea into smaller tasks', prompt: 'Help me break this idea into smaller tasks' },
    { label: 'Plan today’s priorities', prompt: 'Help me work out what to prioritize today' },
  ],
  runInformation: 'Run information', sessionInformation: 'Session', botStartup: 'Assistant startup', workerObservation: 'Worker availability', sessionUnavailable: 'Session information unavailable',
  conversationActions: 'More actions', backToList: 'Back to assistants', connected: 'Connected',
  attentionCount: '{count} items need your attention', attentionSeenError: 'Could not confirm that these items were seen.',
  yourAssistants: 'Your assistants', workerUnknown: 'Worker status unknown', workerStates: { offline: 'Worker offline', stale: 'Worker report stale', unsupported: 'Hosting unsupported', unavailable: 'Worker unavailable' },
  delete: 'Delete assistant', actionsFor: 'More actions for {name}', deleteTitle: 'Delete {name}?', deleteDescription: 'This removes the assistant and its Daynight conversation history. Tasks it created are kept.', deletionStatus: 'Assistant deletion', deleting: 'Requesting deletion…', deletionUnknown: 'Deletion result unknown', deletionPending: 'Waiting for cleanup', deletionFailed: 'Cleanup failed', deletionCompleted: 'Deletion completed', deletionRejected: 'Deletion was not accepted. Review the current assistant before deleting again.', deletionUnavailable: 'Assistant unavailable. Cleanup completion is unconfirmed.', checkDeletion: 'Check deletion', retryDeletion: 'Retry original deletion', workerCleanup: 'Worker cleanup', serverCleanup: 'Server cleanup', cleanupPending: 'Pending', cleanupFailed: 'Failed', cleanupCompleted: 'Completed',

  workerOnline: 'Worker online', details: 'Assistant details', closeDetails: 'Close assistant details', status: 'Status', title: 'Assistants', create: 'Create assistant', createTitle: 'Create assistant', name: 'Name', advanced: 'Advanced settings', worker: 'Worker', cwd: 'Working directory', agent: 'Agent', cancel: 'Cancel', close: 'Close', closeCreate: 'Close creation form', creating: 'Creating…', checkCreation: 'Check creation', checking: 'Checking…',
  unknown: 'The creation result is unknown. Check the original request before trying again.', notConfirmed: 'Creation is not confirmed. Check this ID again before creating another assistant.', defaultsError: 'Could not load creation defaults.', createError: 'Could not create the assistant.', invalidName: 'Enter 1–40 characters without control characters.', invalidCwd: 'Enter an absolute directory path without control characters, or leave it empty to use the Worker default.',
  refresh: 'Refresh', retry: 'Retry', loading: 'Loading…', more: 'Load more', search: 'Search assistants', empty: 'No assistants yet', noMatches: 'No matching assistants', select: 'Choose an assistant to open its conversation.', closeChat: 'Close conversation', listError: 'Could not load assistants.', detailError: 'Could not load this assistant.', pending: 'Starting', ready: 'Started', failed: 'Startup failed', offline: 'Worker offline', unsupported: 'This Worker does not support assistant hosting.', stale: 'The Worker capability report is out of date.', unavailable: 'Assistant hosting is unavailable.', noWorker: 'No available Worker. Connect a Worker that supports assistant hosting.', deleted: 'This assistant has been deleted.', end: 'All assistants are shown.', requestId: 'Request ID', automatic: 'Automatic', defaultAgent: 'Worker default', providerUnavailable: 'This Agent is unavailable on the selected Worker.', host: 'Hosted by', connectionUnknown: 'Connection unconfirmed',
};
const zh: typeof en = {
  welcomeTitle: '从一段对话开始', welcomeDescription: '查进度、理清想法，或一起推进手头的工作。',
  conversationStarters: [
    { label: '看看现在有哪些任务在执行', prompt: '看看我现在有哪些任务在执行' },
    { label: '把一个想法拆成几个小任务', prompt: '帮我把这个想法拆成几个小任务' },
    { label: '梳理今天的优先事项', prompt: '帮我梳理今天应该优先处理什么' },
  ],
  runInformation: '运行信息', sessionInformation: '会话', botStartup: '助手启动', workerObservation: 'Worker 可用性', sessionUnavailable: '会话信息暂不可用',
  conversationActions: '更多操作', backToList: '返回助手列表', connected: '已连接',
  attentionCount: '{count} 件事需要关注', attentionSeenError: '无法确认已看到这些事项。',
  yourAssistants: '你的助手', workerUnknown: 'Worker 状态未知', workerStates: { offline: 'Worker 离线', stale: 'Worker 信息过期', unsupported: '不支持助手托管', unavailable: 'Worker 不可用' },
  delete: '删除助手', actionsFor: '{name}的更多操作', deleteTitle: '删除“{name}”？', deleteDescription: '将删除助手及其 Daynight 对话历史。它创建的任务会保留。', deletionStatus: '助手删除状态', deleting: '正在请求删除…', deletionUnknown: '删除结果未知', deletionPending: '等待清理', deletionFailed: '清理失败', deletionCompleted: '删除完成', deletionRejected: '删除未受理。请查看助手当前状态后重新确认删除。', deletionUnavailable: '助手不可访问，尚未确认清理完成。', checkDeletion: '核对删除结果', retryDeletion: '重试原删除请求', workerCleanup: 'Worker 清理', serverCleanup: '服务端清理', cleanupPending: '待处理', cleanupFailed: '失败', cleanupCompleted: '完成',

  workerOnline: 'Worker 在线', details: '助手详情', closeDetails: '关闭助手详情', status: '状态', title: '助手', create: '创建助手', createTitle: '创建助手', name: '名称', advanced: '高级设置', worker: 'Worker', cwd: '工作目录', agent: 'Agent', cancel: '取消', close: '关闭', closeCreate: '关闭创建表单', creating: '正在创建…', checkCreation: '核对创建结果', checking: '正在核对…',
  unknown: '创建结果未知。请先核对原请求，再决定下一步。', notConfirmed: '尚未确认创建结果。创建另一个助手前，请再次核对这个 ID。', defaultsError: '无法读取创建默认值。', createError: '无法创建助手。', invalidName: '请输入 1–40 个字符，不可包含控制字符。', invalidCwd: '请输入不含控制字符的绝对目录路径，或留空使用 Worker 默认目录。',
  refresh: '刷新', retry: '重试', loading: '正在加载…', more: '加载更多', search: '搜索助手', empty: '还没有助手', noMatches: '没有匹配的助手', select: '选择助手，打开对话。', closeChat: '关闭对话', listError: '无法读取助手列表。', detailError: '无法读取这个助手。', pending: '正在启动', ready: '已启动', failed: '启动失败', offline: 'Worker 离线', unsupported: '这个 Worker 不支持助手托管。', stale: 'Worker 能力报告已过期。', unavailable: '助手托管不可用。', noWorker: '没有可用 Worker。请连接支持助手托管的 Worker。', deleted: '这个助手已删除。', end: '已显示全部助手。', requestId: '请求 ID', automatic: '自动选择', defaultAgent: 'Worker 默认', providerUnavailable: '所选 Worker 上的这个 Agent 不可用。', host: '托管于', connectionUnknown: '连接未确认',
};
export const useBotMessages = () => {
  const m = useI18n().locale === 'zh-CN' ? zh : en;
  return { ...m, cleanupState: (state: 'pending' | 'failed' | 'completed') => state === 'pending' ? m.cleanupPending : state === 'failed' ? m.cleanupFailed : m.cleanupCompleted, reason: (code: string): string => {
    if (code === 'no_available_worker') return m.noWorker;
    if (code === 'offline') return m.offline;
    if (code === 'unsupported') return m.unsupported;
    if (code === 'stale') return m.stale;
    if (code === 'invalid_cwd') return m.invalidCwd;
    if (code.startsWith('provider_')) return `${m.providerUnavailable} (${code})`;
    return `${m.unavailable} (${code})`;
  } };
};
