import { useI18n } from '../../i18n/LocaleProvider';

const en = {
  states: { offline: 'Offline', connecting: 'Connecting', recovering: 'Recovering', idle: 'Online · idle', working: 'Working', abnormal: 'Abnormal', unknown: 'Status unknown' },
  expired: 'Observation out of date', expiredCompact: 'Expired', machine: 'Machine', machineUnknown: 'Machine unknown', unknown: 'Unknown', observed: 'Observed', workerLastSeen: 'Worker last reported', sessionLastSeen: 'Session last reported', nativeSession: 'Native Session ID', platformSession: 'Daynight Session ID', workerId: 'Worker ID', lastState: 'Last observed status', reason: 'Reason', action: 'Next step', refresh: 'Refresh status', readFailed: 'Could not read this assistant’s status.',
  staleHelp: 'These are previously observed facts. Refresh the status before relying on them.',
  reasons: {
    worker_unobserved: 'This Worker has not reported yet.', worker_heartbeat_expired: 'The Worker heartbeat has expired.',
    hosting_identity_mismatch: 'The hosting machine does not match the assistant’s recovery identity.', provider_unavailable: 'The Provider is unavailable on this machine.',
    session_unregistered: 'The assistant’s Daynight Session has not been registered yet.', native_session_pending: 'Waiting for the first native Session ID.',
    session_missing: 'The registered Daynight Session could not be found.', session_identity_mismatch: 'The Session identity does not match this assistant.', session_inactive: 'The Session is no longer active.', startup_pending: 'The original Session is starting or recovering.',
    connection_expired: 'The Session connection has expired.', session_heartbeat_expired: 'The Session heartbeat has expired.', connection_reset: 'The Session connection was reset.', session_synchronizing: 'The Session is synchronizing.', session_observation_unavailable: 'A current Session activity observation is unavailable.',
    working: 'The assistant is working on its current turn.', idle: 'The assistant is ready and idle.', waiting_input: 'The assistant is waiting for input.', session_failed: 'The Session reported a failure.', session_stopped: 'The Session has stopped.', activity_unknown: 'The current Session activity is unknown.', startup_failed: 'The assistant failed to start.',
    native_identity_missing: 'The original native Session identity is missing.', native_session_missing: 'The original native Session record is missing.', directory_missing: 'The working directory is missing.', invalid_cwd: 'The working directory is unavailable.',
    recovery_material_missing: 'The original Session recovery material is missing.', recovery_material_invalid: 'The original Session recovery material failed verification.', recovery_material_incomplete: 'The original Session recovery material is incomplete.', recovery_version_unsupported: 'The Provider version cannot read this recovery material.', outcome_unknown: 'The previous operation’s outcome is unknown.',
  },
  actions: {
    version: 'On this machine, check the original recovery record and use its compatible Provider and recovery format versions before resuming.',
    outcome: 'On this machine, check the original operation and its observable effects. Do not resend it while its result is unknown.',
    offline: 'On the machine shown above, run', machineUnknown: 'Locate the Worker machine for this assistant, then run',
    provider: 'On this machine, check that the selected Provider is installed and signed in, then check the Worker report again.',
    native: 'On this machine, restore the original Session record from a verified backup and check its identity before resuming.',
    identity: 'On this machine, verify the original assistant, machine and Session identities and whether the original execution has stopped before recovering.',
    connecting: 'Check startup progress on this machine. The first native Session ID will appear after it is registered.',
    recovering: 'Check the Worker connection and synchronization on this machine, then refresh the status.',
    directory: 'Restore access to the assistant’s working directory on this machine, then check startup again.',
    failure: 'On this machine, inspect the original Session and Worker error using the reason above. Verify whether the original execution has stopped before recovering. Check unknown operation results before deciding whether to retry.',
  },
};
const zh: typeof en = {
  states: { offline: '离线', connecting: '连接中', recovering: '恢复中', idle: '在线 · 空闲', working: '工作中', abnormal: '异常', unknown: '状态未知' },
  expired: '观测已过期', expiredCompact: '已过期', machine: '机器', machineUnknown: '机器未知', unknown: '未知', observed: '观测时间', workerLastSeen: 'Worker 最后上报', sessionLastSeen: '会话最后上报', nativeSession: '原生 Session ID', platformSession: 'Daynight Session ID', workerId: 'Worker ID', lastState: '上次观测状态', reason: '原因', action: '下一步', refresh: '刷新状态', readFailed: '无法读取这个助手的状态。',
  staleHelp: '以下为先前观测的事实，使用前请刷新状态。',
  reasons: {
    worker_unobserved: '尚未收到这个 Worker 的报告。', worker_heartbeat_expired: 'Worker 心跳已过期。', hosting_identity_mismatch: '承载机器与助手的恢复身份不一致。', provider_unavailable: '这个机器上的 Provider 不可用。',
    session_unregistered: '助手尚未登记 Daynight 会话。', native_session_pending: '正在等待首次原生 Session ID。', session_missing: '找不到已登记的 Daynight 会话。', session_identity_mismatch: '会话身份与这个助手不一致。', session_inactive: '会话已不再活动。', startup_pending: '正在启动或恢复原会话。',
    connection_expired: '会话连接已过期。', session_heartbeat_expired: '会话心跳已过期。', connection_reset: '会话连接已重置。', session_synchronizing: '会话正在同步。', session_observation_unavailable: '暂时无法取得当前会话活动观测。',
    working: '助手正在处理当前轮次。', idle: '助手已就绪，处于空闲状态。', waiting_input: '助手正在等待输入。', session_failed: '会话报告了失败。', session_stopped: '会话已停止。', activity_unknown: '当前会话活动未知。', startup_failed: '助手启动失败。',
    native_identity_missing: '缺少原生会话身份。', native_session_missing: '缺少原生会话记录。', directory_missing: '工作目录不存在。', invalid_cwd: '工作目录不可访问。',
    recovery_material_missing: '缺少原会话恢复材料。', recovery_material_invalid: '原会话恢复材料未通过校验。', recovery_material_incomplete: '原会话恢复材料不完整。', recovery_version_unsupported: 'Provider 版本无法读取这份恢复材料。', outcome_unknown: '上次操作的结果未知。',
  },
  actions: {
    version: '请在这台机器核对原恢复记录，使用与其兼容的 Provider 和恢复格式版本后再恢复。',
    outcome: '请在这台机器核对原操作及其实际影响，结果未知时不要重发。',
    offline: '请在上述机器运行', machineUnknown: '请先找到这个助手的 Worker 所在机器，再运行',
    provider: '请在这台机器检查所选 Provider 的安装与登录状态，然后重新核对 Worker 报告。',
    native: '请在这台机器从已验证的备份恢复原会话记录，核对身份后再恢复执行。',
    identity: '请在这台机器核对原助手、机器和会话身份，确认原执行是否已停止后再恢复。',
    connecting: '请在这台机器查看启动进度，登记完成后将显示首次原生 Session ID。', recovering: '请检查这台机器的 Worker 连接与同步进度，然后刷新状态。',
    directory: '请恢复这台机器上助手工作目录的访问，再次核对启动结果。', failure: '请根据上方原因检查这台机器的原会话与 Worker 错误，恢复前确认原执行是否已停止。操作结果未知时，先核对结果再决定是否重试。',
  },
};
export const useBotObservationMessages = () => {
  const m = useI18n().locale === 'zh-CN' ? zh : en;
  return { ...m, describeReason: (reason: string) => m.reasons[reason as keyof typeof m.reasons] ?? reason };
};
