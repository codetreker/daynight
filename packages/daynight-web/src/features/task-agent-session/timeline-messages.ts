import { useI18n } from '../../i18n/LocaleProvider';
const en = { running: 'Running', completed: 'Completed', failed: 'Failed', table: 'Markdown table', noOutput: 'No output.', command: 'Command', fileChanges: 'File changes', inputCancelled: 'Queued message cancelled', turnInterrupted: 'Turn interrupted' };
const zh: typeof en = { running: '运行中', completed: '已完成', failed: '失败', table: 'Markdown 表格', noOutput: '没有输出。', command: '命令', fileChanges: '文件变更', inputCancelled: '排队消息已取消', turnInterrupted: '本轮已中断' };
export const useTimelineMessages = () => useI18n().locale === 'zh-CN' ? zh : en;
