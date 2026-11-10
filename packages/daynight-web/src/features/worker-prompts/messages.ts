import type { Locale } from '../../i18n/locale';

const messages = {
  en: {
    titles: { user: 'User prompt', project: 'Personal project prompt', worker: 'Worker prompt' },
    descriptions: { user: 'Appended to tasks on all of your Workers.', project: 'Appended to your tasks in this project on any Worker. Other members have their own prompt.', worker: 'Appended to tasks on this Worker.' },
    text: 'Prompt text', hint: 'Text, spaces and line breaks are preserved. Save an empty value to clear this layer.',
    order: 'Append order', builtin: 'Built-in prompt', timing: 'When changes take effect', timingDetail: 'After the Worker receives the saved value, new starts, recovery inputs and periodic pings use it. Delivery can take time.',
    preview: 'Combined example', example: 'This example uses your draft for this layer and placeholders for other layers. It does not show an actual task input.',
    placeholder: '[Example content for this layer]', scenario: 'Input scenario', start: 'Start a task', resume: 'New recovery input', ping: 'Periodic ping',
    resumeNote: 'Recovery of an existing delivery retains its original input.',
    loading: 'Loading prompt', readError: 'Could not read the prompt. Try again.', retry: 'Retry', unavailable: 'This prompt is no longer available.',
    saveError: 'Could not save. Your draft is retained.', conflict: 'The saved version has changed. Your draft is retained.', latest: 'View latest saved text', useLatest: 'Use latest text', keepDraft: 'Keep draft against latest version',
    uncertain: 'The save result is unknown. Read the current value before saving again.', verify: 'Check current value', reconciled: 'Current value checked; this does not confirm the original request.',
    invalid: 'Text contains unsupported control characters or invalid Unicode.', tooLarge: 'The complete request exceeds the 1 MiB limit.',
    dirty: 'Unsaved changes', clean: 'No unsaved changes', discard: 'Discard changes', save: 'Save changes', saving: 'Saving', revision: 'Saved revision',
    leaveQuestion: 'Leave with unsaved prompt changes?', leaveExplanation: 'Unsaved drafts will be discarded. A write already sent is not cancelled by leaving.',
  },
  'zh-CN': {
    titles: { user: '用户级 Prompt', project: '项目个人 Prompt', worker: 'Worker 级 Prompt' },
    descriptions: { user: '追加到你的所有 Worker 执行的任务。', project: '追加到你在此项目中执行的任务；其他成员维护自己的内容。', worker: '追加到此 Worker 执行的任务。' },
    text: 'Prompt 内容', hint: '保留原始文字、空格和换行。清空后保存以移除此层内容。',
    order: '追加顺序', builtin: '内置 Prompt', timing: '生效时机', timingDetail: 'Worker 收到保存的内容后，后续启动、恢复输入和周期 ping 使用新内容；送达需要时间。',
    preview: '组合效果示例', example: '本层使用当前草稿，其他层使用占位内容；这不是实际任务输入。',
    placeholder: '【此层内容示例】', scenario: '输入场景', start: '启动新任务', resume: '新生成的恢复输入', ping: '周期 ping',
    resumeNote: '恢复已有投递时沿用原输入。',
    loading: '正在读取 Prompt', readError: '无法读取 Prompt，请重试。', retry: '重试', unavailable: '此 Prompt 已不可访问。',
    saveError: '保存失败，草稿已保留。', conflict: '保存版本已变化，草稿已保留。', latest: '查看最新保存内容', useLatest: '使用最新内容', keepDraft: '保留草稿并使用最新版本',
    uncertain: '保存结果未知。再次保存前请读取当前内容。', verify: '核对当前内容', reconciled: '已核对当前内容；这不能确认原请求是否提交。',
    invalid: '内容包含不支持的控制字符或无效 Unicode。', tooLarge: '完整请求超过 1 MiB 限制。',
    dirty: '有未保存的修改', clean: '没有未保存的修改', discard: '放弃修改', save: '保存修改', saving: '正在保存', revision: '保存版本',
    leaveQuestion: '放弃未保存的 Prompt 修改并离开？', leaveExplanation: '未保存草稿将被放弃。已经发送的写入不会因离开而取消。',
  },
} as const;
export const promptMessages = (locale: Locale) => messages[locale];
