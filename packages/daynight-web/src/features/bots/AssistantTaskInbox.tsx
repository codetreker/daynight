import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { type AssistantTask, type AssistantTaskInboxResult, type AssistantTaskInboxRotation, assistantTaskInboxUrl, disableAssistantTaskInbox, enableAssistantTaskInbox, getAssistantTaskInbox, getAssistantTaskInboxOperation, rotateAssistantTaskInbox } from '../../api/assistant-tasks';
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
  receiptToken: 'This request issued a new token, and its receipt cannot return it. If you did not copy that token, rotate the token to issue a new one.',
  rotateTitle: 'Rotate inbox token', rotateMode: 'Rotation mode',
  overlapMode: 'Keep the previous token for 24 hours', overlapHint: 'Use this to switch external senders without dropping messages.',
  overlapBlocked: 'The previous token is still in its overlap period. Rotate immediately instead.',
  immediateMode: 'Revoke the previous token now', immediateHint: 'Use this when the token may have leaked.',
  disableTitle: 'Disable inbox', disableConfirm: 'Disable this inbox? Every token is revoked and this URL stops accepting messages permanently. Enabling again creates a new URL. Disable or delete Webhook endpoints that point to this inbox.',
  changed: 'This task changed after you opened this confirmation. Close it and review the current inbox before trying again.',
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
  receiptToken: '这次请求生成了新令牌，回执无法返回该令牌。如果没有复制它，请轮换令牌以获取新的令牌。',
  rotateTitle: '轮换收件箱令牌', rotateMode: '轮换方式',
  overlapMode: '旧令牌继续有效 24 小时', overlapHint: '用于让外部发送方平稳切换，不丢失消息。',
  overlapBlocked: '旧令牌仍在重叠有效期内，只能立即轮换。',
  immediateMode: '立即废止旧令牌', immediateHint: '用于令牌可能已经泄露的情况。',
  disableTitle: '停用收件箱', disableConfirm: '停用这个收件箱？全部令牌将被废止，该地址永久停止接收消息；再次开启会生成新的地址。请停用或删除指向这个收件箱的 Webhook 端点。',
  changed: '打开此确认后任务已经发生变化。请关闭它并查看当前收件箱后再操作。',
  confirm: '确认', cancel: '取消', error: '无法读取收件箱。', retry: '重试', loading: '正在加载…',
};
const useInboxMessages = () => { const { locale } = useI18n(); return { ...(locale === 'zh-CN' ? zh : en), locale }; };

/**
 * Owner management of the assistant task inbox. The token exists only in this mounted panel after the request that generated it.
 * Every write submits the task version paired with the displayed inbox snapshot: the version observed before that inbox read
 * started. The inbox shown is therefore never older than the submitted version, so a concurrent inbox change becomes a conflict
 * instead of a write against an inbox other than the one displayed. A confirmation keeps the version it was opened against.
 * The token is published as soon as its write response is validated, without waiting for the task detail refresh, and is
 * retired once an inbox read that started after the write response shows the issuing credential disabled, replaced or rotated.
 * Every reload after a write or a result check waits for such an inbox read, so the inbox shown afterwards follows the write.
 */
export function AssistantTaskInbox({ task, enabled, disabled, onChanged }: { readonly task: AssistantTask; readonly enabled: boolean; readonly disabled: boolean; readonly onChanged: () => Promise<unknown> }) {
  const m = useInboxMessages(), scope = useTaskCacheScope(), admission = assistantTaskAdmission(scope), taskId = task.id, heading = useId(), modeName = useId();
  const observed = useRef(task.version); observed.current = task.version;
  // Numbers inbox reads in start order. The task version cannot order a read against an issued token, because the task detail
  // read that supplies it may lag behind the write that issued the token.
  const started = useRef(0);
  const load = useCallback(async (scope: TaskCacheScope, signal: AbortSignal) => {
    const version = observed.current, sequence = ++started.current;
    return { version, sequence, inbox: await getAssistantTaskInbox(taskId, signal, assistantTaskAdmission(scope)) };
  }, [taskId]);
  const read = useBotRead(`assistant-task-inbox:${taskId}`, enabled, load);
  // A snapshot paired with an older task version may predate a concurrent inbox change, so it cannot authorize writes;
  // re-read the inbox to pair it with the version the task now reports.
  const current = read.value !== null && read.value.version === task.version, refreshRead = read.refresh;
  useEffect(() => { if (read.value !== null && read.value.version !== task.version) refreshRead(); }, [read.value, task.version, refreshRead]);
  const reread = read.reread, reload = async () => { await Promise.all([reread(), onChanged()]); };
  const mutation = useAssistantTaskMutation(`assistant-task-inbox:${taskId}`, enabled && !read.stale && !!read.value, reload, getAssistantTaskInboxOperation, receipt => (receipt as AssistantTaskInboxResult).operation.kind === 'inbox_disable' ? null : m.receiptToken);
  // The issued token stays bound to the identity scope that received it and is never shown to another identity. It also keeps
  // the issuing inbox and rotation so an inbox read started after its write response that no longer shows that credential,
  // such as a disable, re-enable or rotation from another tab, retires it.
  const [issuedToken, setIssuedToken] = useState<{ readonly scope: TaskCacheScope; readonly value: string; readonly inboxId: string | null; readonly rotatedAt: string | null; readonly after: number } | null>(null);
  const superseded = issuedToken !== null && read.value !== null && read.value.sequence > issuedToken.after
    && (!read.value.inbox.enabled || read.value.inbox.inboxId !== issuedToken.inboxId || read.value.inbox.rotatedAt !== issuedToken.rotatedAt);
  useEffect(() => { if (superseded) setIssuedToken(null); }, [superseded]);
  const token = issuedToken !== null && !superseded && issuedToken.scope === scope && !scope.isInvalidated ? issuedToken.value : null;
  const [dialog, setDialog] = useState<{ readonly kind: 'rotate' | 'disable'; readonly version: string } | null>(null);
  const owner = useRef({ scope, taskId }); owner.current = { scope, taskId };
  const inbox = read.value?.inbox ?? null, snapshotVersion = read.value?.version ?? task.version, overlapActive = inbox?.overlapUntil != null;
  const [mode, setMode] = useState<AssistantTaskInboxRotation>('overlap');
  const blocked = disabled || mutation.blocked || !current, changed = dialog !== null && dialog.version !== task.version;
  // Hiding the tab stops new writes, but a token from a completed request is unrecoverable elsewhere,
  // so it stays visible while this panel remains mounted for the same identity and task.
  // The token is published from inside the write, before the mutation's task detail reload, so a stalled reload cannot withhold it.
  const issue = async (operation: (signal: AbortSignal, admission: ReturnType<typeof assistantTaskAdmission>) => Promise<AssistantTaskInboxResult>, onIssued?: () => void) => {
    const origin = { scope, taskId };
    let retained = false;
    const ok = await mutation.run(async signal => {
      const result = await operation(signal, admission);
      if (result.token === null || origin.scope.isInvalidated || owner.current.scope !== origin.scope || owner.current.taskId !== origin.taskId) return;
      retained = true;
      setIssuedToken({ scope: origin.scope, value: result.token, inboxId: result.inbox.inboxId, rotatedAt: result.inbox.rotatedAt, after: started.current });
      onIssued?.();
    });
    // A retained result skipped the mutation's own reload; refresh the task so later writes use its new version.
    if (!ok && retained) void onChanged().catch(() => undefined);
    return ok || retained;
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
      <button className="button" type="button" onClick={() => setIssuedToken(null)}>{m.hideToken}</button>
    </div> : null}
    {inbox && !inbox.enabled ? <><p>{m.off}</p><div className="assistant-task-actions"><InboxAction label={m.enable} primary disabled={blocked} onClick={() => void issue((signal, access) => enableAssistantTaskInbox(taskId, { operationId: crypto.randomUUID(), ifVersion: snapshotVersion }, signal, access))} /></div></> : null}
    {inbox?.enabled && inbox.inboxId ? <>
      <dl className="assistant-task-inbox-details">
        <div className="assistant-task-inbox-url"><dt>{m.url}</dt><dd><div className="assistant-task-inbox-value"><code>{assistantTaskInboxUrl(inbox.inboxId)}</code><InboxCopy value={assistantTaskInboxUrl(inbox.inboxId)} label={m.copyUrl} copied={m.urlCopied} failed={m.copyFailed} /></div><p className="assistant-task-meta">{m.urlHint}</p></dd></div>
        {([[m.created, inbox.createdAt], [m.rotated, inbox.rotatedAt], [m.overlap, inbox.overlapUntil]] as const).map(([label, date]) => <div key={label}><dt>{label}</dt><dd>{date ? <time dateTime={date}>{new Date(date).toLocaleString(m.locale)}</time> : m.never}</dd></div>)}
        <div><dt>{m.suppressed}</dt><dd>{inbox.suppressedCount}</dd></div>
      </dl>
      <div className="assistant-task-actions"><InboxAction label={m.rotate} disabled={blocked} onClick={() => { setMode(overlapActive ? 'immediate' : 'overlap'); setDialog({ kind: 'rotate', version: snapshotVersion }); }} /><InboxAction label={m.disable} danger disabled={blocked} onClick={() => setDialog({ kind: 'disable', version: snapshotVersion })} /></div>
    </> : null}
    {dialog ? <AssistantTaskDialog title={dialog.kind === 'rotate' ? m.rotateTitle : m.disableTitle} onClose={() => setDialog(null)}><form onSubmit={event => { event.preventDefault(); if (changed) return; void (async () => {
      const operationId = crypto.randomUUID(), ifVersion = dialog.version;
      const ok = dialog.kind === 'rotate'
        ? await issue((signal, access) => rotateAssistantTaskInbox(taskId, { operationId, ifVersion, mode }, signal, access), () => setDialog(null))
        : await mutation.run(async signal => { await disableAssistantTaskInbox(taskId, { operationId, ifVersion }, signal, admission); });
      if (ok) { setDialog(null); if (dialog.kind === 'disable') setIssuedToken(null); }
    })(); }}>
      <div className="dialog-body assistant-task-form">{dialog.kind === 'rotate' ? <fieldset className="assistant-task-inbox-modes"><legend>{m.rotateMode}</legend>
        <label><input type="radio" name={modeName} value="overlap" checked={mode === 'overlap'} disabled={overlapActive} onChange={() => setMode('overlap')} /><span><strong>{m.overlapMode}</strong><span className="assistant-task-meta">{overlapActive ? m.overlapBlocked : m.overlapHint}</span></span></label>
        <label><input type="radio" name={modeName} value="immediate" checked={mode === 'immediate'} onChange={() => setMode('immediate')} /><span><strong>{m.immediateMode}</strong><span className="assistant-task-meta">{m.immediateHint}</span></span></label>
      </fieldset> : <p>{m.disableConfirm}</p>}{changed ? <div className="notice error" role="alert">{m.changed}</div> : null}{mutation.notice}</div>
      <footer className="dialog-footer"><button type="button" className="button" onClick={() => setDialog(null)}>{m.cancel}</button><button type="submit" className={`button ${dialog.kind === 'disable' ? 'danger' : 'primary'}`} disabled={blocked || changed}>{dialog.kind === 'disable' ? m.disable : m.confirm}</button></footer>
    </form></AssistantTaskDialog> : null}
  </section>;
}
function InboxAction({ label, onClick, disabled, primary = false, danger = false }: { readonly label: string; readonly onClick: () => void; readonly disabled: boolean; readonly primary?: boolean; readonly danger?: boolean }) {
  return <button className={`button${primary ? ' primary' : danger ? ' danger' : ''}`} type="button" disabled={disabled} onClick={onClick}>{label}</button>;
}
function InboxCopy({ value, label, copied, failed }: { readonly value: string; readonly label: string; readonly copied: string; readonly failed: string }) {
  return <ValueCopyButton value={value} label={label} className="assistant-task-inbox-copy" feedback={state => state === 'copied' ? <span role="status">{copied}</span> : state === 'failed' ? <span role="alert">{failed}</span> : null} />;
}
