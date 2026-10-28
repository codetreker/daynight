import { useI18n } from '../../i18n/LocaleProvider';
const en = {
  title: 'Test Sessions', session: 'Test Session', subtitle: 'Your online test sessions, most recently updated first.', refresh: 'Refresh', more: 'Load more', loading: 'Loading test sessions…', error: 'Could not load test sessions.', retry: 'Retry', empty: 'No online test sessions', create: 'Start a session from your project directory:', back: 'All test sessions', updated: 'Updated', created: 'Created', active: 'Active', draining: 'Stopping', archived: 'Archived', connected: 'Connected', disconnected: 'Disconnected', synchronizing: 'Synchronizing', open: 'Open session', end: 'All online sessions are shown.',
};
const zh: typeof en = {
  title: '测试会话', session: '测试会话', subtitle: '仅显示在线测试会话，最近更新的排在前面。', refresh: '刷新', more: '加载更多', loading: '正在加载测试会话…', error: '无法加载测试会话。', retry: '重试', empty: '当前没有在线测试会话', create: '在项目目录运行以下命令新建会话：', back: '全部测试会话', updated: '更新于', created: '创建于', active: '活跃', draining: '正在停止', archived: '已归档', connected: '已连接', disconnected: '未连接', synchronizing: '同步中', open: '打开会话', end: '已显示全部在线会话。',
};
export const useTestSessionListMessages = () => useI18n().locale === 'zh-CN' ? zh : en;
