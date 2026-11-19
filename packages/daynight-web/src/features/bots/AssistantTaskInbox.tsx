import { useCallback, useId, useState } from 'react';
import { type AssistantTask, type AssistantTaskInboxRotation, assistantTaskInboxUrl, disableAssistantTaskInbox, enableAssistantTaskInbox, getAssistantTaskInbox, getAssistantTaskInboxOperation, rotateAssistantTaskInbox } from '../../api/assistant-tasks';
import { useI18n } from '../../i18n/LocaleProvider';
import { ValueCopyButton } from '../../ui/copy-button/ValueCopyButton';
import { useTaskCacheScope, type TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { AssistantTaskDialog } from './AssistantTaskDialog';
import { assistantTaskAdmission } from './assistant-task-data';
import { useAssistantTaskMutation } from './useAssistantTaskMutation';
import { useBotRead } from './useBotRead';

const en = {
  title: 'Inbox', enabled: 'Enabled', disabled: 'Disabled',
  intro: 'External systems and your Daynight Webhooks can deliver messages to the responsible assistant through this inbox. The assistant treats every delivered message as data, not as instructions.',
  off: 'The inbox is off. Enabling it creates a receiving URL and a token for external senders.',
  enable: 'Enable inbox', rotate: 'Rotate token', disable: 'Disable inbox',
  url: 'Receiving URL', copyUrl: 'Copy inbox URL', urlCopied: 'Inbox URL copied.', copyFailed: 'Could not copy. Select and copy it manually.',
  urlHint: 'The URL contains no token. Daynight Webhooks can target it directly; external senders add the token in an Authorization: Bearer header.',
  created: 'Enabled at', rotated: 'Token rotated at', overlap: 'Previous token valid until', suppressed: 'Suppressed self-triggered events', never: '—',
  token: 'New token', tokenHint: 'This token is shown only once. Copy it now and store it with the external sender. If it is lost, rotate the token to get a new one.',
  copyToken: 'Copy token', tokenCopied: 'Token copied.', hideToken: 'I have saved the token',
  rotateTitle: 'Rotate inbox token', rotateMode: 'Rotation mode',
  overlapMode: 'Keep the previous token for 24 hours', overlapHint: 'Use this to switch external senders without dropping messages.',
  overlapBlocked: 'The previous token is still in its overlap period. Rotate immediately instead.',
  immediateMode: 'Revoke the previous token now', immediateHint: 'Use this when the token may have leaked.',
  disableTitle: 'Disable inbox', disableConfirm: 'Disable this inbox? Every token is revoked and this URL stops accepting messages permanently. Enabling again creates a new URL. Disable or delete Webhook endpoints that point to this inbox.',
  confirm: 'Confirm', cancel: 'Cancel', error: 'Could not load the inbox.', retry: 'Retry', loading: 'Loading…',
};
const zh: typeof en = {
  title: '收件箱', enabled: '已开启', disabled: '未开启',
  intro: '外部系统和你的 Daynight Webhook 可以通过收件箱把消息送达负责的助手。助手把送达的消息视为数据，而不是指令。',
  off: '收件箱未开启。开启后会生成接收地址和供外部发送方使用的令牌。',
  enable: '开启收件箱', rotate: '轮换令牌', disable: '停用收件箱',
  url: '接收地址', copyUrl: '复制收件箱地址', urlCopied: '已复制收件箱地址。', copyFailed: '无法复制，请手动选择并复制。',
  urlHint: '地址不含令牌。Daynight Webhook 可以直接以它为目标；外部发送方通过 Authorization: Bearer 请求头提供令牌。',
  created: '开启时间', rotated: '令牌轮换时间', overlap: '旧令牌有效至', suppressed: '已抑制的自触发事件', never: '—',
  token: '新令牌', tokenHint: '令牌只显示这一次。请立即复制并交给外部发送方保存；如果丢失，请轮换令牌获取新的令牌。',
  copyToken: '复制令牌', tokenCopied: '已复制令牌。', hideToken: '我已保存令牌',
  rotateTitle: '轮换收件箱令牌', rotateMode: '轮换方式',
  overlapMode: '旧令牌继续有效 24 小时', overlapHint: '用于让外部发送方平稳切换，不丢失消息。',
  overlapBlocked: '旧令牌仍在重叠有效期内，只能立即轮换。',
  immediateMode: '立即废止旧令牌', immediateHint: '用于令牌可能已经泄露的情况。',
  disableTitle: '停用收件箱', disableConfirm: '停用这个收件箱？全部令牌将被废止，该地址永久停止接收消息；再次开启会生成新的地址。请停用或删除指向这个收件箱的 Webhook 端点。',
  confirm: '确认', cancel: '取消', error: '无法读取收件箱。', retry: '重试', loading: '正在加载…',
};
const useInboxMessages = () => { const { locale } = useI18n(); return { ...(locale === 'zh-CN' ? zh : en), locale }; };

/** Owner management of the assistant task inbox. The token exists only in this mounted panel after the request that generated it. */
export function AssistantTaskInbox({ task, enabled, disabled, onChanged }: { readonly task: AssistantTask; readonly enabled: boolean; readonly disabled: boolean; readonly onChanged: () => Promise<unknown> }) {
  const m = useInboxMessages(), scope = useTaskCacheScope(), admission = assistantTaskAdmission(scope), taskId = task.id, heading = useId(), modeName = useId();
  const load = useCallback((scope: TaskCacheScope, signal: AbortSignal) => getAssistantTaskInbox(taskId, signal, assistantTaskAdmission(scope)), [taskId]);
  const read = useBotRead(`assistant-task-inbox:${taskId}`, enabled, load);
  const reload = async () => { read.refresh(); await onChanged(); };
  const mutation = useAssistantTaskMutation(`assistant-task-inbox:${taskId}`, enabled && !read.stale && !!read.value, reload, getAssistantTaskInboxOperation);
  const [token, setToken] = useState<string | null>(null), [dialog, setDialog] = useState<'rotate' | 'disable' | null>(null);
  const inbox = read.value, overlapActive = inbox?.overlapUntil != null;
  const [mode, setMode] = useState<AssistantTaskInboxRotation>('overlap');
  const blocked = disabled || mutation.blocked;
  const issue = async (operation: (signal: AbortSignal, admission: ReturnType<typeof assistantTaskAdmission>) => Promise<{ readonly token: string | null }>) => {
    let issued: string | null = null;
    const ok = await mutation.run(async signal => { issued = (await operation(signal, admission)).token; });
    if (ok) setToken(issued);
    return ok;
  };
  return <section className="assistant-task-panel assistant-task-inbox" aria-labelledby={heading}>
    <header><h3 id={heading}>{m.title}</h3>{inbox ? <span className="assistant-task-badge">{inbox.enabled ? m.enabled : m.disabled}</span> : null}</header>
    <p className="assistant-task-meta">{m.intro}</p>
    {mutation.notice}
    {read.error ? <div className="notice error" role="alert"><p>{m.error}</p><button className="button" type="button" onClick={read.refresh}>{m.retry}</button></div> : null}
    {!inbox ? read.error ? null : <p role="status">{m.loading}</p> : null}
    {token ? <div className="assistant-task-inbox-token" role="group" aria-label={m.token}>
      <strong>{m.token}</strong><p>{m.tokenHint}</p>
      <div className="assistant-task-inbox-value"><code>{token}</code><InboxCopy value={token} label={m.copyToken} copied={m.tokenCopied} failed={m.copyFailed} /></div>
      <button className="button" type="button" onClick={() => setToken(null)}>{m.hideToken}</button>
    </div> : null}
    {inbox && !inbox.enabled ? <><p>{m.off}</p><div className="assistant-task-actions"><InboxAction label={m.enable} primary disabled={blocked} onClick={() => void issue((signal, access) => enableAssistantTaskInbox(taskId, { operationId: crypto.randomUUID(), ifVersion: task.version }, signal, access))} /></div></> : null}
    {inbox?.enabled && inbox.inboxId ? <>
      <dl className="assistant-task-inbox-details">
        <div className="assistant-task-inbox-url"><dt>{m.url}</dt><dd><div className="assistant-task-inbox-value"><code>{assistantTaskInboxUrl(inbox.inboxId)}</code><InboxCopy value={assistantTaskInboxUrl(inbox.inboxId)} label={m.copyUrl} copied={m.urlCopied} failed={m.copyFailed} /></div><p className="assistant-task-meta">{m.urlHint}</p></dd></div>
        {([[m.created, inbox.createdAt], [m.rotated, inbox.rotatedAt], [m.overlap, inbox.overlapUntil]] as const).map(([label, date]) => <div key={label}><dt>{label}</dt><dd>{date ? <time dateTime={date}>{new Date(date).toLocaleString(m.locale)}</time> : m.never}</dd></div>)}
        <div><dt>{m.suppressed}</dt><dd>{inbox.suppressedCount}</dd></div>
      </dl>
      <div className="assistant-task-actions"><InboxAction label={m.rotate} disabled={blocked} onClick={() => { setMode(overlapActive ? 'immediate' : 'overlap'); setDialog('rotate'); }} /><InboxAction label={m.disable} danger disabled={blocked} onClick={() => setDialog('disable')} /></div>
    </> : null}
    {dialog ? <AssistantTaskDialog title={dialog === 'rotate' ? m.rotateTitle : m.disableTitle} onClose={() => setDialog(null)}><form onSubmit={event => { event.preventDefault(); void (async () => {
      const operationId = crypto.randomUUID();
      const ok = dialog === 'rotate'
        ? await issue((signal, access) => rotateAssistantTaskInbox(taskId, { operationId, ifVersion: task.version, mode }, signal, access))
        : await mutation.run(async signal => { await disableAssistantTaskInbox(taskId, { operationId, ifVersion: task.version }, signal, admission); });
      if (ok) { setDialog(null); if (dialog === 'disable') setToken(null); }
    })(); }}>
      <div className="dialog-body assistant-task-form">{dialog === 'rotate' ? <fieldset className="assistant-task-inbox-modes"><legend>{m.rotateMode}</legend>
        <label><input type="radio" name={modeName} value="overlap" checked={mode === 'overlap'} disabled={overlapActive} onChange={() => setMode('overlap')} /><span><strong>{m.overlapMode}</strong><span className="assistant-task-meta">{overlapActive ? m.overlapBlocked : m.overlapHint}</span></span></label>
        <label><input type="radio" name={modeName} value="immediate" checked={mode === 'immediate'} onChange={() => setMode('immediate')} /><span><strong>{m.immediateMode}</strong><span className="assistant-task-meta">{m.immediateHint}</span></span></label>
      </fieldset> : <p>{m.disableConfirm}</p>}{mutation.notice}</div>
      <footer className="dialog-footer"><button type="button" className="button" onClick={() => setDialog(null)}>{m.cancel}</button><button type="submit" className={`button ${dialog === 'disable' ? 'danger' : 'primary'}`} disabled={blocked}>{dialog === 'disable' ? m.disable : m.confirm}</button></footer>
    </form></AssistantTaskDialog> : null}
  </section>;
}
function InboxAction({ label, onClick, disabled, primary = false, danger = false }: { readonly label: string; readonly onClick: () => void; readonly disabled: boolean; readonly primary?: boolean; readonly danger?: boolean }) {
  return <button className={`button${primary ? ' primary' : danger ? ' danger' : ''}`} type="button" disabled={disabled} onClick={onClick}>{label}</button>;
}
function InboxCopy({ value, label, copied, failed }: { readonly value: string; readonly label: string; readonly copied: string; readonly failed: string }) {
  return <ValueCopyButton value={value} label={label} className="assistant-task-inbox-copy" feedback={state => state === 'copied' ? <span role="status">{copied}</span> : state === 'failed' ? <span role="alert">{failed}</span> : null} />;
}
