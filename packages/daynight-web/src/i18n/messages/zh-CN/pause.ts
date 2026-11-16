import type { PauseMessages } from '../pause';

export const pause: PauseMessages = {
  label: '已暂停', count: (count) => `${count} 已暂停`, openTask: (title) => `查看暂停任务：${title}`, listTitle: '已暂停的任务', truncated: '标题已截断',
  unpause: '解除暂停', unpausing: '处理中…', unavailable: '确认当前任务详情与访问权限前无法修改任务。',
  confirmed: '任务已解除暂停。',
  conflict: '任务已变化，请检查当前暂停状态后重试。',
  unknown: '解除暂停的结果尚未确认。再次操作前，请先检查当前任务。',
  reconciled: '已读取当前任务状态；这不能证明先前解除暂停请求的结果。',
  checking: '正在检查当前任务…', checkState: '检查当前任务', checkFailed: '暂时无法读取当前任务，检查成功前无法再次修改。',
  networkError: '未能取得可确认的解除暂停响应。', protocolError: '服务响应无法确认解除暂停结果。',
  versionConflict: '任务版本已变化，本次解除暂停未能生效。',
  notFound: '任务或项目已无法读取。', refused: '服务拒绝解除暂停。', requestFailed: '解除暂停请求失败。',
};
