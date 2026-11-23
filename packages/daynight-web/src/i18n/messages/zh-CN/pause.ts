import type { PauseMessages } from '../pause';

export const pause: PauseMessages = {
  label: '受阻', count: (count) => `${count} 受阻`, listTitle: '受阻任务', truncated: '标题已截断',
  unpause: '解除阻塞', unpausing: '处理中…', unavailable: '确认当前任务详情与访问权限前无法修改任务。',
  confirmed: '任务已解除阻塞。',
  conflict: '任务已变化，请检查当前受阻状态后重试。',
  unknown: '解除阻塞的结果尚未确认。再次操作前，请先检查当前任务。',
  reconciled: '已读取当前任务状态；这不能证明先前解除阻塞请求的结果。',
  checking: '正在检查当前任务…', checkState: '检查当前任务', checkFailed: '暂时无法读取当前任务，检查成功前无法再次修改。',
  networkError: '未能取得可确认的解除阻塞响应。', protocolError: '服务响应无法确认解除阻塞结果。',
  versionConflict: '任务版本已变化，本次解除阻塞未能生效。',
  notFound: '任务或项目已无法读取。', refused: '服务拒绝解除阻塞。', requestFailed: '解除阻塞请求失败。',
};
