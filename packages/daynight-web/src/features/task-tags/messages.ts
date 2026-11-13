export const tagMessages = {
  en: {
    title: 'Tags', description: 'Manage the tags shared by this project.', search: 'Search tags', create: 'New tag', rename: 'Rename', remove: 'Delete',
    loading: 'Loading tags…', refreshing: 'Checking tags…', empty: 'No tags yet.', noMatches: 'No matching tags.', readError: 'Could not load tags.', retry: 'Retry', next: 'Next', first: 'First page',
    usage: (tasks: number, goals: number) => `${tasks} Tasks · ${goals} Goals`, name: 'Name', hint: '1–64 Unicode characters; names are unique ignoring ASCII case.',
    invalid: 'Enter 1–64 characters without control characters or line breaks.', duplicate: 'A tag with this name already exists.', cancel: 'Cancel', save: 'Save', saving: 'Saving…',
    deleteTitle: 'Delete tag?', deleteWarning: 'This removes all associations, including those added after this preview. Tasks and Goals are not deleted.', deleteConfirm: 'Delete tag', preview: 'Loading current tag…',
    checkPermission: 'Check permission', checkingPermission: 'Checking permission…', permissionCheckFailed: 'Could not confirm project access. Try again.',
    denied: 'You do not have permission to manage tags.', failed: 'The request failed.', conflict: 'This tag changed. Check its current state before continuing.', unknown: 'The outcome is unknown. Checking current state cannot prove the original outcome and will not resend the request.',
    check: 'Check current state', checking: 'Checking…', current: 'Current tag', missing: 'The tag is no longer available.', useCurrent: 'Use current version', close: 'Close', checked: 'I checked; close',
  },
  'zh-CN': {
    title: '标签', description: '管理项目共用的标签。', search: '搜索标签', create: '新建标签', rename: '重命名', remove: '删除',
    loading: '正在读取标签…', refreshing: '正在检查标签…', empty: '还没有标签。', noMatches: '没有匹配的标签。', readError: '无法读取标签。', retry: '重试', next: '下一页', first: '首页',
    usage: (tasks: number, goals: number) => `${tasks} 个 Task · ${goals} 个 Goal`, name: '名称', hint: '1–64 个 Unicode 字符；名称按 ASCII 大小写不区分重名。',
    invalid: '请输入 1–64 个字符，不能包含控制字符或换行。', duplicate: '已存在同名标签。', cancel: '取消', save: '保存', saving: '正在保存…',
    deleteTitle: '删除标签？', deleteWarning: '这将删除全部关联，包括预览后新增的关联，不会删除 Task 或 Goal。', deleteConfirm: '删除标签', preview: '正在读取当前标签…',
    checkPermission: '检查权限', checkingPermission: '正在检查权限…', permissionCheckFailed: '无法确认项目访问权限，请重试。',
    denied: '你没有管理标签的权限。', failed: '请求失败。', conflict: '标签已更改，请核对当前状态后继续。', unknown: '操作结果尚未确认。核对当前状态不能证明原操作的结果，也不会重新提交。',
    check: '核对当前状态', checking: '正在核对…', current: '当前标签', missing: '标签已不可用。', useCurrent: '使用当前版本', close: '关闭', checked: '已核对，关闭',
  },
} as const;
