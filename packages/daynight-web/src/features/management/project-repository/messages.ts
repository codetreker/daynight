export const repositoryMessages = {
  'zh-CN': {
    title: '仓库地址', project: '项目', current: '当前仓库', target: '新仓库地址', hint: '支持 HTTPS、SSH 和 SCP 格式。', preview: '预览更改',
    restricted: '只有项目管理员可以修改仓库地址。', invalid: '请输入有效的 HTTPS、SSH 或 SCP 仓库地址。', tooLong: '仓库地址不能超过 4096 字节。',
    confirm: '确认修改仓库地址', checking: '正在读取预览…', saving: '正在保存…', reading: '正在核对当前地址…', cancel: '取消', close: '关闭', save: '保存地址', switch: '确认更换仓库',
    retryPreview: '重新预览', check: '核对当前地址', unchanged: '地址与当前值相同，可以直接关闭。', same: '这是同一个仓库。保留 GitHub App 连接和 Worker 项目选择。', different: '新地址指向另一个仓库。', unverified: '无法确认新旧地址是否属于同一个仓库。',
    acknowledge: '按更换仓库处理', impact: '更换仓库的影响', github: '断开 Daynight 项目中的 GitHub App 连接并停止旧仓库同步。旧 PR 保留。需要时由管理员手工连接。', worker: '从已有 Worker 的云端配置移除项目。Worker 同步后停止领取；同步前仍可能有新领取，现有执行也可能在配置应用时中断。',
    failed: '无法读取仓库改址预览。请重试。', rejected: '保存遭到拒绝。请检查原因并修正后重试。', occupied: '此 Team 已有其他活动项目使用该仓库。', conflict: '项目仓库地址或确认事实已变化。请重新预览并确认。', unknown: '无法确认这次保存的结果。请核对当前地址；读回只反映当前状态，不能确认原操作成功，也不会再次提交。', observed: '读到的当前地址', readFailed: '无法核对当前地址。请重试。', saved: '仓库地址已保存。', switched: '仓库地址已保存。项目的 GitHub App 连接已断开，已有 Worker 项目选择已移除。', request: '请求 ID：',
  },
  en: {
    title: 'Repository address', project: 'Project', current: 'Current repository', target: 'New repository address', hint: 'Supports HTTPS, SSH, and SCP addresses.', preview: 'Preview change',
    restricted: 'Only project administrators can change the repository address.', invalid: 'Enter a valid HTTPS, SSH, or SCP repository address.', tooLong: 'The address must be at most 4096 bytes.',
    confirm: 'Confirm repository address change', checking: 'Loading preview…', saving: 'Saving…', reading: 'Checking the current address…', cancel: 'Cancel', close: 'Close', save: 'Save address', switch: 'Confirm repository switch',
    retryPreview: 'Preview again', check: 'Check current address', unchanged: 'The address matches the current value.', same: 'This is the same repository. The GitHub App connection and Worker selections are retained.', different: 'The new address points to a different repository.', unverified: 'Daynight could not verify whether both addresses point to the same repository.',
    acknowledge: 'Proceed as a repository switch', impact: 'Repository switch effects', github: 'Disconnect the project’s GitHub App connection in Daynight and stop old-repository sync. Existing PRs are kept. An administrator can connect again manually.', worker: 'Remove the project from existing Worker cloud selections. A Worker stops claiming after applying the configuration. Claims can still occur before then, and applying removal can interrupt running work.',
    failed: 'Could not load the repository change preview. Try again.', rejected: 'The save was rejected. Check the details and correct the address before retrying.', occupied: 'Another active project in this Team already uses this repository.', conflict: 'The project repository or confirmation facts changed. Preview the change again and confirm.', unknown: 'The save outcome is unknown. Check the current address. Readback only shows the current state; it cannot confirm the original operation and will not resend it.', observed: 'Current address observed', readFailed: 'Could not check the current address. Try again.', saved: 'Repository address saved.', switched: 'Repository address saved. The project’s GitHub App connection and existing Worker selections were removed.', request: 'Request ID: ',
  },
};
