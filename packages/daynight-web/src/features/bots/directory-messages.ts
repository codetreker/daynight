import { useI18n } from '../../i18n/LocaleProvider';

const en = {
  title: 'Choose a working directory', close: 'Close directory browser', path: 'Browse path', parent: 'Parent directory', go: 'Go',
  defaultDirectory: 'Default directory', filter: 'Filter loaded folders', hidden: 'Show hidden folders', more: 'Load more folders',
  empty: 'This directory has no subfolders.', noMatches: 'No matching loaded folders.', select: 'Select this directory', cancel: 'Cancel', retry: 'Retry',
  errors: {
    unsupported: 'This Worker does not support directory browsing. Return to use its default or enter a path.',
    offline: 'This Worker is offline. Reconnect it and retry.',
    permission_denied: 'This Worker cannot access the directory.',
    not_found: 'The directory was not found on this Worker.',
    timeout: 'The directory request timed out. Retry or return to the form.',
    invalid_path: 'Enter an absolute path on this Worker.',
    invalid_cursor: 'The directory changed. Reload it to continue.',
    protocol: 'The directory changed or returned an invalid response. Reload it.',
    busy: 'This Worker is busy. Retry shortly.',
    limit_exceeded: 'This directory exceeds the browsing limit. Enter a more specific path.',
    forbidden: 'You no longer have permission to browse this Worker.',
    generic: 'Could not read this directory. Retry or return to the form.',
  },
};
const zh: typeof en = {
  title: '选择工作目录', close: '关闭目录浏览', path: '浏览路径', parent: '上一级目录', go: '前往',
  defaultDirectory: '默认目录', filter: '筛选已加载的文件夹', hidden: '显示隐藏目录', more: '加载更多文件夹',
  empty: '此目录没有子文件夹。', noMatches: '已加载的文件夹中没有匹配项。', select: '选择此目录', cancel: '取消', retry: '重试',
  errors: {
    unsupported: '此 Worker 尚不支持目录浏览。请返回使用默认目录或输入路径。',
    offline: '此 Worker 已离线。请连接后重试。',
    permission_denied: '此 Worker 无权访问该目录。',
    not_found: '此 Worker 上不存在该目录。',
    timeout: '目录请求超时。请重试或返回表单。',
    invalid_path: '请输入此 Worker 上的绝对路径。',
    invalid_cursor: '目录已变化，请重新加载后继续。',
    protocol: '目录已变化或返回了无效响应，请重新加载。',
    busy: '此 Worker 正忙，请稍后重试。',
    limit_exceeded: '此目录超过浏览上限，请输入更具体的路径。',
    forbidden: '你已无权浏览此 Worker。',
    generic: '无法读取此目录，请重试或返回表单。',
  },
};
export const useDirectoryMessages = () => useI18n().locale === 'zh-CN' ? zh : en;
