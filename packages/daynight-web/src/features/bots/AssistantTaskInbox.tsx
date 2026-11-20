import { useCallback, useId, useState } from 'react';
import { type AssistantTask, type AssistantTaskInboxOperation, type AssistantTaskInboxResult, type AssistantTaskInboxRotation, AssistantTaskWriteUnknown, assistantTaskInboxUrl, disableAssistantTaskInbox, enableAssistantTaskInbox, getAssistantTaskInbox, getAssistantTaskInboxOperation, rotateAssistantTaskInbox } from '../../api/assistant-tasks';
import { ApiError } from '../../api/client';
import { useI18n } from '../../i18n/LocaleProvider';
import { ValueCopyButton } from '../../ui/copy-button/ValueCopyButton';
import { useTaskCacheScope, type TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { AssistantTaskDialog } from './AssistantTaskDialog';
import { assistantTaskAdmission } from './assistant-task-data';
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
  immediateMode: 'Revoke the previous token now', immediateHint: 'Use this when the token may have leaked.',
  disableTitle: 'Disable inbox', disableConfirm: 'Disable this inbox? Every token is revoked and this URL stops accepting messages permanently. Enabling again creates a new URL. Disable or delete Webhook endpoints that point to this inbox.',
  conflict: 'This task changed since you loaded it, so the request was not applied. Reload to see the current inbox.', reload: 'Reload',
  refused: 'The request was not applied.', unknown: 'The result of this request is unknown.', checkOperation: 'Check original operation',
  applied: 'The server applied this request.', notFound: 'The server has no record of this request.', checkFailed: 'Could not check the original operation.',
  receiptToken: 'A token issued by this request cannot be shown again. Rotate the token if you did not copy it.',
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
  immediateMode: '立即废止旧令牌', immediateHint: '用于令牌可能已经泄露的情况。',
  disableTitle: '停用收件箱', disableConfirm: '停用这个收件箱？全部令牌将被废止，该地址永久停止接收消息；再次开启会生成新的地址。请停用或删除指向这个收件箱的 Webhook 端点。',
  conflict: '加载后任务已经变化，这次请求没有生效。请重新加载查看当前收件箱。', reload: '重新加载',
  refused: '这次请求没有生效。', unknown: '这次请求的结果未知。', checkOperation: '核对原操作',
  applied: '服务端已执行这次请求。', notFound: '服务端没有这次请求的记录。', checkFailed: '无法核对原操作。',
  receiptToken: '这次请求生成的令牌无法再次显示。如果没有复制它，请轮换令牌。',
  confirm: '确认', cancel: '取消', error: '无法读取收件箱。', retry: '重试', loading: '正在加载…',
};
const useInboxMessages = () => { const { locale } = useI18n(); return { ...(locale === 'zh-CN' ? zh : en), locale }; };

type Outcome =
  | { readonly kind: 'refused'; readonly error: unknown }
  | { readonly kind: 'unknown'; readonly operationId: string; readonly error: unknown; readonly check: null | { readonly receipt: AssistantTaskInboxOperation } | { readonly missing: true } | { readonly failed: unknown } };

/**
 * Owner management of the assistant task inbox. The server owns concurrency and policy: every write submits the task version
 * this panel observed when the action started together with a fresh operation ID, and the server's version check and operation
 * receipts decide the result. A conflict is shown with a Reload action; an unknown result offers one lookup of the original
 * operation receipt. The token exists only in this mounted panel, taken from the enable or rotate response that generated it,
 * and is shown only while the displayed inbox ID is the one it was issued for.
 */
export function AssistantTaskInbox({ task, enabled, disabled, onChanged }: { readonly task: AssistantTask; readonly enabled: boolean; readonly disabled: boolean; readonly onChanged: () => Promise<unknown> }) {
  const m = useInboxMessages(), scope = useTaskCacheScope(), taskId = task.id, heading = useId(), modeName = useId();
  const load = useCallback((owner: TaskCacheScope, signal: AbortSignal) => getAssistantTaskInbox(taskId, signal, assistantTaskAdmission(owner)), [taskId]);
  const read = useBotRead(`assistant-task-inbox:${taskId}`, enabled, load), inbox = read.value;
  const [pending, setPending] = useState(false), [outcome, setOutcome] = useState<Outcome | null>(null);
  const [issued, setIssued] = useState<{ readonly inboxId: string | null; readonly value: string } | null>(null);
  const [dialog, setDialog] = useState<{ readonly kind: 'rotate' | 'disable'; readonly version: string } | null>(null);
  const [mode, setMode] = useState<AssistantTaskInboxRotation>('overlap');
  const token = issued !== null && inbox !== null && issued.inboxId === inbox.inboxId ? issued.value : null;
  const blocked = disabled || pending || !inbox;
  const conflict = outcome?.kind === 'refused' && outcome.error instanceof ApiError && outcome.error.code === 'version_conflict';
  const reload = () => { setOutcome(null); setIssued(null); setDialog(null); read.refresh(); void onChanged().catch(() => undefined); };
  const submit = async (write: (operationId: string, signal: AbortSignal) => Promise<AssistantTaskInboxResult>) => {
    if (blocked) return;
    const operationId = crypto.randomUUID();
    setPending(true); setOutcome(null);
    try {
      const result = await write(operationId, scope.signal);
      if (result.token !== null) setIssued({ inboxId: result.inbox.inboxId, value: result.token });
      read.refresh();
      // Later actions submit the task version, so keep them disabled until the task detail shows the new one.
      await onChanged().catch(() => undefined);
    } catch (error) {
      setOutcome(error instanceof AssistantTaskWriteUnknown ? { kind: 'unknown', operationId, error, check: null } : { kind: 'refused', error });
    } finally { setPending(false); setDialog(null); }
  };
  const checkOperation = async (operationId: string) => {
    let check: Extract<Outcome, { kind: 'unknown' }>['check'];
    try { check = { receipt: (await getAssistantTaskInboxOperation(taskId, operationId, scope.signal, assistantTaskAdmission(scope))).operation }; }
    catch (error) { check = error instanceof ApiError && error.status === 404 ? { missing: true } : { failed: error }; }
    setOutcome(old => old?.kind === 'unknown' && old.operationId === operationId ? { ...old, check } : old);
  };
  return <section className="assistant-task-panel assistant-task-inbox" aria-labelledby={heading}>
    <header><h3 id={heading}>{m.title}</h3>{inbox ? <span className="assistant-task-badge">{inbox.enabled ? m.enabled : m.disabled}</span> : null}</header>
    <p className="assistant-task-meta">{m.intro}</p>
    {outcome ? <div className="notice error" role="alert">
      {outcome.kind === 'unknown' ? <>
        <p>{m.unknown}</p><ServerError error={outcome.error} />
        <button className="button" type="button" onClick={() => void checkOperation(outcome.operationId)}>{m.checkOperation}</button>
        {outcome.check === null ? null : 'receipt' in outcome.check ? <><p>{m.applied} <code>{outcome.check.receipt.kind}</code></p>{outcome.check.receipt.kind !== 'inbox_disable' ? <p>{m.receiptToken}</p> : null}</>
          : 'missing' in outcome.check ? <p>{m.notFound}</p> : <><p>{m.checkFailed}</p><ServerError error={outcome.check.failed} /></>}
      </> : <><p>{conflict ? m.conflict : m.refused}</p><ServerError error={outcome.error} /></>}
      {conflict ? <button className="button" type="button" onClick={reload}>{m.reload}</button> : null}
    </div> : null}
    {read.error ? <div className="notice error" role="alert"><p>{m.error}</p><button className="button" type="button" onClick={read.refresh}>{m.retry}</button></div> : null}
    {!inbox ? read.error ? null : <p role="status">{m.loading}</p> : null}
    {token ? <div className="assistant-task-inbox-token" role="group" aria-label={m.token}>
      <strong>{m.token}</strong><p>{m.tokenHint}</p>
      <div className="assistant-task-inbox-value"><code>{token}</code><InboxCopy value={token} label={m.copyToken} copied={m.tokenCopied} failed={m.copyFailed} /></div>
      <button className="button" type="button" onClick={() => setIssued(null)}>{m.hideToken}</button>
    </div> : null}
    {inbox && !inbox.enabled ? <><p>{m.off}</p><div className="assistant-task-actions"><InboxAction label={m.enable} primary disabled={blocked} onClick={() => { const ifVersion = task.version; void submit((operationId, signal) => enableAssistantTaskInbox(taskId, { operationId, ifVersion }, signal, assistantTaskAdmission(scope))); }} /></div></> : null}
    {inbox?.enabled && inbox.inboxId ? <>
      <dl className="assistant-task-inbox-details">
        <div className="assistant-task-inbox-url"><dt>{m.url}</dt><dd><div className="assistant-task-inbox-value"><code>{assistantTaskInboxUrl(inbox.inboxId)}</code><InboxCopy value={assistantTaskInboxUrl(inbox.inboxId)} label={m.copyUrl} copied={m.urlCopied} failed={m.copyFailed} /></div><p className="assistant-task-meta">{m.urlHint}</p></dd></div>
        {([[m.created, inbox.createdAt], [m.rotated, inbox.rotatedAt], [m.overlap, inbox.overlapUntil]] as const).map(([label, date]) => <div key={label}><dt>{label}</dt><dd>{date ? <time dateTime={date}>{new Date(date).toLocaleString(m.locale)}</time> : m.never}</dd></div>)}
        <div><dt>{m.suppressed}</dt><dd>{inbox.suppressedCount}</dd></div>
      </dl>
      <div className="assistant-task-actions"><InboxAction label={m.rotate} disabled={blocked} onClick={() => { setMode('overlap'); setDialog({ kind: 'rotate', version: task.version }); }} /><InboxAction label={m.disable} danger disabled={blocked} onClick={() => setDialog({ kind: 'disable', version: task.version })} /></div>
    </> : null}
    {dialog ? <AssistantTaskDialog title={dialog.kind === 'rotate' ? m.rotateTitle : m.disableTitle} onClose={() => { if (!pending) setDialog(null); }}><form onSubmit={event => {
      event.preventDefault();
      const ifVersion = dialog.version, admission = assistantTaskAdmission(scope);
      void submit(dialog.kind === 'rotate'
        ? (operationId, signal) => rotateAssistantTaskInbox(taskId, { operationId, ifVersion, mode }, signal, admission)
        : (operationId, signal) => disableAssistantTaskInbox(taskId, { operationId, ifVersion }, signal, admission));
    }}>
      <div className="dialog-body assistant-task-form">{dialog.kind === 'rotate' ? <fieldset className="assistant-task-inbox-modes" disabled={pending}><legend>{m.rotateMode}</legend>
        <label><input type="radio" name={modeName} value="overlap" checked={mode === 'overlap'} onChange={() => setMode('overlap')} /><span><strong>{m.overlapMode}</strong><span className="assistant-task-meta">{m.overlapHint}</span></span></label>
        <label><input type="radio" name={modeName} value="immediate" checked={mode === 'immediate'} onChange={() => setMode('immediate')} /><span><strong>{m.immediateMode}</strong><span className="assistant-task-meta">{m.immediateHint}</span></span></label>
      </fieldset> : <p>{m.disableConfirm}</p>}</div>
      <footer className="dialog-footer"><button type="button" className="button" disabled={pending} onClick={() => setDialog(null)}>{m.cancel}</button><button type="submit" className={`button ${dialog.kind === 'disable' ? 'danger' : 'primary'}`} disabled={blocked}>{dialog.kind === 'disable' ? m.disable : m.confirm}</button></footer>
    </form></AssistantTaskDialog> : null}
  </section>;
}
/** Shows the server's error code, message and request ID as returned. */
function ServerError({ error }: { readonly error: unknown }) {
  const failure = error instanceof AssistantTaskWriteUnknown && error.cause instanceof ApiError ? error.cause : error;
  if (!(failure instanceof ApiError)) return null;
  return <p><code>{failure.code}</code>{failure.serverMessage ? ` ${failure.serverMessage}` : ''}{failure.requestId ? <> <code>{failure.requestId}</code></> : null}</p>;
}
function InboxAction({ label, onClick, disabled, primary = false, danger = false }: { readonly label: string; readonly onClick: () => void; readonly disabled: boolean; readonly primary?: boolean; readonly danger?: boolean }) {
  return <button className={`button${primary ? ' primary' : danger ? ' danger' : ''}`} type="button" disabled={disabled} onClick={onClick}>{label}</button>;
}
function InboxCopy({ value, label, copied, failed }: { readonly value: string; readonly label: string; readonly copied: string; readonly failed: string }) {
  return <ValueCopyButton value={value} label={label} className="assistant-task-inbox-copy" feedback={state => state === 'copied' ? <span role="status">{copied}</span> : state === 'failed' ? <span role="alert">{failed}</span> : null} />;
}
