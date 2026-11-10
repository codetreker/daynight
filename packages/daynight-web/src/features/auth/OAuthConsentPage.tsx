import { useCallback, useEffect, useRef, useState } from 'react';
import { decideConsent, inspectConsent, isLoopbackCallback, type ConsentView } from '../../api/oauth-consent';
import type { CurrentUser } from '../../api/auth-types';
import { ApiError, isAbortError } from '../../api/client';
import { useI18n } from '../../i18n/LocaleProvider';
import { LanguageSelector } from '../../i18n/LanguageSelector';

const copy = {
  'zh-CN': {
    eyebrow: '连接到 DAYNIGHT', title: '授权客户端访问', subtitle: '查看此客户端申请的访问权限。', loading: '正在读取客户端信息…', loadingTitle: '确认授权请求', callback: '返回目标', callbackFull: '查看完整返回地址', local: '此授权将返回到你设备上的客户端，请确认这是你正在连接的应用。', access: '此客户端将能够', groups: [['项目', '查看和创建项目，转移项目所属 Team。'], ['Team 与成员', '管理 Team、成员角色及邀请。'], ['邀请', '查看并接受发给你的邀请。'], ['Bot', '创建、查看和删除 Bot 定义。'], ['任务与工作材料', '管理任务、依赖、属性、Steps、讨论和附件。']], summary: '此客户端将以你的身份操作，权限不会超出你在 Daynight 中已有的权限。请仅授权你信任的客户端。', resource: '访问资源', duration: '授权有效期最长 30 天。', switchAccount: '切换账户', allow: '允许访问', deny: '拒绝', submitting: '提交中…', approved: '授权请求已批准', approvedDetail: '你已允许此客户端请求的访问。请返回客户端完成连接。', approvedMore: '关闭此页面不会撤销已生效的授权。', denied: '已拒绝访问', deniedDetail: '此授权请求已被拒绝，客户端没有获得访问权限。', expired: '授权请求已过期', expiredDetail: '请返回客户端重新发起连接。此请求已不能继续授权。', invalid: '无法授权此客户端', invalidDetail: '客户端或返回地址不符合此授权请求，无法继续。请返回客户端重新连接。', service: '暂时无法读取授权请求', serviceDetail: 'Daynight 暂时无法确认此请求。请重试读取客户端信息，再决定是否授权。', retry: '重新读取', unknown: '授权结果尚未确认', unknownDetail: '提交后连接中断，暂时无法确认授权结果。请先检查授权状态。关闭页面不会撤销已经生效的授权。', check: '检查授权状态', checking: '正在检查…', checkFailed: '无法读取授权状态。请重试。', approvedUnknown: '请求已批准，连接尚未确认', approvedUnknownDetail: '已确认此请求得到批准，但未能确认授权信息是否送达客户端。请返回客户端重新发起连接。此页面不会再次发送或生成授权信息。', return: '返回客户端', reconnect: '返回客户端重新连接', current: '当前账户', nameUnverified: '客户端名称由其自行提供，未经独立验证。', sources: { dcr: '动态注册客户端', cimd: '客户端元数据地址', preregistered: '预注册客户端' }, backgroundError: '无法确认当前请求。请重新读取后再决定。', storage: '无法保存授权状态。请检查浏览器存储设置后重试。', pending: '目前请求仍在等待。请稍后再次检查。'
  },
  en: {
    eyebrow: 'CONNECT TO DAYNIGHT', title: 'Authorize client access', subtitle: 'Review the access this client is requesting.', loading: 'Reading client information…', loadingTitle: 'Check authorization request', callback: 'Return destination', callbackFull: 'View complete return address', local: 'This authorization returns to a client on your device. Confirm that this is the application you are connecting.', access: 'This client will be able to', groups: [['Projects', 'View and create projects, and transfer project ownership.'], ['Teams and members', 'Manage Teams, member roles and invitations.'], ['Invitations', 'Inspect and accept invitations sent to you.'], ['Bots', 'Create, view and delete Bot definitions.'], ['Tasks and work materials', 'Manage tasks, dependencies, properties, Steps, discussions and attachments.']], summary: 'This client will act as you, within the permissions you already have in Daynight. Only authorize clients you trust.', resource: 'Resource', duration: 'Authorization lasts up to 30 days.', switchAccount: 'Switch account', allow: 'Allow access', deny: 'Deny', submitting: 'Submitting…', approved: 'Authorization request approved', approvedDetail: 'You approved this client’s requested access. Return to the client to complete the connection.', approvedMore: 'Closing this page does not revoke authorization that has already taken effect.', denied: 'Access denied', deniedDetail: 'You denied this authorization request. The client did not receive access.', expired: 'Authorization request expired', expiredDetail: 'Return to the client and start a new connection. This request can no longer be authorized.', invalid: 'Cannot authorize this client', invalidDetail: 'The client or return address does not match this authorization request. Return to the client to reconnect.', service: 'Unable to read this request', serviceDetail: 'Daynight cannot confirm this request right now. Retry reading the client information before deciding whether to authorize it.', retry: 'Read request again', unknown: 'Authorization outcome unconfirmed', unknownDetail: 'The connection was interrupted after submission, so the outcome is not yet confirmed. Check its status before taking another action. Closing this page does not revoke authorization that has already taken effect.', check: 'Check authorization status', checking: 'Checking…', checkFailed: 'Unable to read the authorization status. Please retry.', approvedUnknown: 'Approved; connection unconfirmed', approvedUnknownDetail: 'This request was approved, but delivery of the authorization information to the client is unconfirmed. Return to the client and start a new connection. This page will not send or generate the authorization information again.', return: 'Return to client', reconnect: 'Return to client to reconnect', current: 'Current account', nameUnverified: 'The client supplied this name; it has not been independently verified.', sources: { dcr: 'Dynamically registered client', cimd: 'Client metadata URL', preregistered: 'Pre-registered client' }, backgroundError: 'Unable to confirm this request. Read it again before deciding.', storage: 'Unable to save the authorization state. Check browser storage settings and try again.', pending: 'The request is still pending. Check again later.'
  }
} as const;

type State =
  | { kind: 'loading' }
  | { kind: 'storage' }
  | { kind: 'error'; invalid: boolean }
  | { kind: 'ready'; view: ConsentView }
  | { kind: 'sending'; view: ConsentView }
  | { kind: 'unknown'; view: ConsentView; checking: boolean; pending: boolean; failed: boolean }
  | { kind: 'result'; result: 'approved' | 'denied' | 'expired' | 'approvedUnknown'; redirect?: string };

type Transport = { inspect: typeof inspectConsent; decide: typeof decideConsent };
const transportDefault: Transport = { inspect: inspectConsent, decide: decideConsent };
export const OAuthConsentPage = ({ user, requestId, onSwitchAccount, onIdentityMismatch, transport = transportDefault, navigate = (url: string) => window.location.assign(url) }: { user: CurrentUser; requestId: string | null; onSwitchAccount: () => void; onIdentityMismatch: () => void; transport?: Transport; navigate?: (url: string) => void }) => {
  const { locale } = useI18n(); const m = copy[locale];
  const [backgroundError, setBackgroundError] = useState(false);
  const [state, setState] = useState<State>(requestId === null ? { kind: 'error', invalid: true } : { kind: 'loading' });
  const active = useRef<AbortController | null>(null);
  const decisionDispatched = useRef(false);
  const activeMode = useRef<'initial' | 'background' | 'unknown' | 'decision' | null>(null);
  const storageKey = `daynight.oauth.decision.${requestId}`;
  const clearMarker = () => { try { sessionStorage.removeItem(storageKey); } catch { /* The terminal state remains authoritative. */ } };
  const stateRef = useRef(state); stateRef.current = state;
  const title = useRef<HTMLHeadingElement>(null);
  const received = useRef(false);
  const transition = (next: State, focus = false) => { setState(next); if (focus) requestAnimationFrame(() => title.current?.focus()); };
  const read = useCallback((mode: 'initial' | 'background' | 'unknown') => {
    if (requestId === null || active.current !== null) return;
    const previous = stateRef.current;
    if (mode === 'unknown' && previous.kind !== 'unknown' || mode === 'background' && previous.kind !== 'ready') return;
    const controller = new AbortController(); active.current = controller; activeMode.current = mode;
    if (mode === 'initial') setState({ kind: 'loading' });
    if (mode === 'unknown' && previous.kind === 'unknown') setState({ ...previous, checking: true, failed: false });
    void transport.inspect(requestId, user.id, controller.signal, onIdentityMismatch).then((view) => {
      if (controller.signal.aborted) return;
      setBackgroundError(false);
      if (view.status !== 'pending') clearMarker();
      if (view.status === 'approved' || view.status === 'consumed') transition({ kind: 'result', result: 'approvedUnknown' }, mode !== 'background');
      else if (view.status === 'denied' || view.status === 'expired') transition({ kind: 'result', result: view.status }, mode !== 'background');
      else if (mode === 'unknown' && previous.kind === 'unknown') setState({ ...previous, view, checking: false, pending: true, failed: false });
      else if (mode === 'initial') {
        try { setState(sessionStorage.getItem(storageKey) === 'pending' ? { kind: 'unknown', view, checking: false, pending: true, failed: false } : { kind: 'ready', view }); }
        catch { setState({ kind: 'storage' }); }
      } else setState({ kind: 'ready', view });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || isAbortError(error)) return;
      if (mode === 'unknown' && previous.kind === 'unknown') setState({ ...previous, checking: false, failed: true });
      else if (mode !== 'background') transition({ kind: 'error', invalid: error instanceof ApiError && (error.status === 400 || error.status === 404) }, true);
      else if (error instanceof ApiError && (error.status === 400 || error.status === 404)) transition({ kind: 'error', invalid: true });
      else setBackgroundError(true);
    }).finally(() => { if (active.current === controller) { active.current = null; activeMode.current = null; } });
  }, [requestId, user.id, onIdentityMismatch, transport]);
  useEffect(() => { if (requestId !== null) read('initial'); return () => { if (activeMode.current === 'decision' && !decisionDispatched.current) clearMarker(); active.current?.abort(); active.current = null; activeMode.current = null; }; }, [read, requestId]);
  useEffect(() => {
    const check = () => { if (document.visibilityState === 'visible') read('background'); };
    window.addEventListener('focus', check); document.addEventListener('visibilitychange', check);
    return () => { window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check); };
  }, [read]);
  const decide = (decision: 'approve' | 'deny') => {
    if (state.kind !== 'ready' || backgroundError) return;
    if (active.current !== null) {
      if (activeMode.current !== 'background') return;
      active.current.abort(); active.current = null; activeMode.current = null;
    }
    try { sessionStorage.setItem(storageKey, 'pending'); } catch { transition({ kind: 'storage' }, true); return; }
    const view = state.view, controller = new AbortController(); active.current = controller; activeMode.current = 'decision'; decisionDispatched.current = false;
    setState({ kind: 'sending', view });
    void transport.decide(view, decision, controller.signal, clearMarker, () => { decisionDispatched.current = true; }).then((redirect) => {
      if (!controller.signal.aborted) { clearMarker(); transition({ kind: 'result', result: decision === 'approve' ? 'approved' : 'denied', redirect }, true); }
    }).catch((error: unknown) => {
      if (controller.signal.aborted || isAbortError(error)) { if (!decisionDispatched.current) clearMarker(); return; }
      const rejected = error instanceof ApiError && error.kind === 'server' && (((error.status === 400 || error.status === 404) && error.code === 'invalid_request') || (error.status === 403 && error.code === 'forbidden') || (error.status === 401 && error.code === 'unauthorized'));
      if (rejected) {
        clearMarker(); active.current = null; activeMode.current = null; read('initial');
      } else transition({ kind: 'unknown', view, checking: false, pending: false, failed: false }, true);
    }).finally(() => { if (active.current === controller) { active.current = null; activeMode.current = null; } });
  };
  const isReady = state.kind === 'ready' || state.kind === 'sending';
  const view = isReady ? state.view : null;
  const result = state.kind === 'result' ? state.result : null;
  const heading = state.kind === 'storage' ? m.service : state.kind === 'loading' ? m.loadingTitle : state.kind === 'error' ? state.invalid ? m.invalid : m.service : state.kind === 'unknown' ? m.unknown : result === 'approved' ? m.approved : result === 'denied' ? m.denied : result === 'expired' ? m.expired : result === 'approvedUnknown' ? m.approvedUnknown : m.title;
  return <div className="invite-page device-page"><div className="brand" aria-label="Daynight"><span className="brand-mark" aria-hidden="true" />daynight</div><main className="invite-card device-card consent-card" aria-labelledby="consent-title"><LanguageSelector /><p className="eyebrow">{m.eyebrow}</p><h1 ref={title} id="consent-title" tabIndex={-1}>{heading}</h1>
    {state.kind === 'loading' && <div className="device-loading" role="status"><span className="spinner" aria-hidden="true" /><p>{m.loading}</p></div>}
    {state.kind === 'storage' && <div className="device-result" role="alert"><p>{m.storage}</p><button className="button" type="button" onClick={() => read('initial')}>{m.retry}</button></div>}
    {state.kind === 'error' && <div className="device-result" role="alert"><div className="device-result-mark" aria-hidden="true">!</div><p>{state.invalid ? m.invalidDetail : m.serviceDetail}</p>{!state.invalid && <button className="button" type="button" onClick={() => read('initial')}>{m.retry}</button>}</div>}
    {view !== null && <><p className="subtitle">{m.subtitle}</p><div className="client-identity"><div className="client-mark" aria-hidden="true">▤</div><div><p className="client-name">{view.clientName}</p><p className="client-origin">{m.sources[view.clientProvenance]}{view.clientProvenance === 'cimd' ? ` · ${new URL(view.clientId).origin}` : ` · ${view.clientId}`}</p><p className="client-origin">{m.nameUnverified}</p></div></div><section className="callback-box" aria-label={m.callback}><p>{m.callback}</p><strong>{new URL(view.redirectUri).host}</strong><details><summary>{m.callbackFull}</summary><code>{view.redirectUri}</code></details>{isLoopbackCallback(view.redirectUri) && <p className="callback-local">{m.local}</p>}</section><h2 className="access-heading">{m.access}</h2><ul className="access-list">{m.groups.map(([name, detail], i) => <li key={name}><span className="access-mark" aria-hidden="true">{['▱', '♙', '✉', '◇', '☷'][i]}</span><div><strong>{name}</strong><p>{detail}</p></div></li>)}</ul><p className="access-summary">{m.summary}</p><p className="resource-label"><span>{m.resource}</span><code>{view.resource}</code></p><p className="authorization-duration">{m.duration}</p><div className="invite-footer"><div className="invite-account"><div className="person"><span className="avatar" aria-hidden="true">{(user.name ?? user.email ?? '?').slice(0, 1).toUpperCase()}</span><div><p className="person-name">{user.name ?? m.current}</p>{user.email !== null && <p className="person-meta">{user.email}</p>}</div></div><button className="inline-link" type="button" disabled={state.kind === 'sending'} onClick={onSwitchAccount}>{m.switchAccount}</button></div>{backgroundError && <div className="notice warning" role="alert"><p>{m.backgroundError}</p><button className="button" type="button" onClick={() => read('background')}>{m.retry}</button></div>}<div className="device-actions"><button className="button primary" type="button" disabled={state.kind === 'sending' || backgroundError} aria-busy={state.kind === 'sending'} onClick={() => decide('approve')}>{state.kind === 'sending' ? m.submitting : m.allow}</button><button className="button danger" type="button" disabled={state.kind === 'sending' || backgroundError} onClick={() => decide('deny')}>{m.deny}</button></div></div></>}
    {state.kind === 'unknown' && <div className="device-result" role="alert"><div className="device-result-mark" aria-hidden="true">?</div><p>{m.unknownDetail}</p>{state.pending && <p>{m.pending}</p>}{state.failed && <p>{m.checkFailed}</p>}<button className="button primary" type="button" disabled={state.checking} onClick={() => read('unknown')}>{state.checking ? m.checking : m.check}</button></div>}
    {state.kind === 'result' && <div className="device-result" role="status"><div className={`device-result-mark ${result === 'approved' ? 'success' : ''}`} aria-hidden="true">{result === 'approved' ? '✓' : result === 'denied' ? '×' : '?'}</div><p>{result === 'approved' ? m.approvedDetail : result === 'denied' ? m.deniedDetail : result === 'expired' ? m.expiredDetail : m.approvedUnknownDetail}</p>{result === 'approved' && <p className="result-detail">{m.approvedMore}</p>}{state.redirect && <button className="button" type="button" onClick={() => { if (!received.current && state.redirect) { received.current = true; navigate(state.redirect); } }}>{m.return}</button>}{!state.redirect && <p className="result-detail">{m.reconnect}</p>}</div>}
  </main></div>;
};
