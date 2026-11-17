import { useI18n } from '../../i18n/LocaleProvider';
const en = {
  records: 'Session recordings', more: 'Load earlier records', close: 'Close recording',
  empty: 'No Session recordings yet.', loading: 'Loading session…', refresh: 'Refresh', error: 'The session could not be loaded or verified.',
  pending: 'Recording is waiting to be archived.', failed: 'This recording could not be saved or verified.', unavailable: 'No recording is available for this execution.',
  readonly: 'Read-only', notRegistered: 'This execution has not registered a Session yet.',
  unsupported: 'This execution environment does not support this Session operation.', permission: 'You no longer have permission to access this Session.',
};
type Messages = { readonly [K in keyof typeof en]: string };
const zh: Messages = {
  records: 'Session 记录', more: '加载更早记录', close: '关闭回放',
  empty: '尚无 Session 记录。', loading: '正在加载会话…', refresh: '刷新', error: '无法加载或验证此会话。',
  pending: '录制正在等待归档。', failed: '无法保存或验证这份录制。', unavailable: '这次执行没有可用录制。',
  readonly: '只读', notRegistered: '此执行尚未注册 Session。',
  unsupported: '此执行环境不支持该 Session 操作。', permission: '你已无权访问此 Session。',
};
export const useTerminalHostMessages = (): Messages => useI18n().locale === 'zh-CN' ? zh : en;
