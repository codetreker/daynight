import { useI18n } from '../../i18n/LocaleProvider';
const en = { running: 'Running', completed: 'Completed', failed: 'Failed', table: 'Markdown table', noOutput: 'No output.', command: 'Command', fileChanges: 'File changes', inputCancelled: 'Queued message cancelled', turnInterrupted: 'Turn interrupted', retryNotice: 'Retry notice', turnFailed: 'Turn failed', error: 'Error', errorReported: 'An error was reported.', technicalDetails: 'Technical details' };
export const timelineNativeLabels = Object.freeze({ command: en.command, fileChanges: en.fileChanges });
const zh: typeof en = { running: '运行中', completed: '已完成', failed: '失败', table: 'Markdown 表格', noOutput: '没有输出。', command: '命令', fileChanges: '文件变更', inputCancelled: '排队消息已取消', turnInterrupted: '本轮已中断', retryNotice: '重试通知', turnFailed: '本轮失败', error: '错误', errorReported: '发生错误。', technicalDetails: '技术详情' };
export const useTimelineMessages = () => useI18n().locale === 'zh-CN' ? zh : en;
