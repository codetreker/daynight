import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError, isAbortError, readAuthRequestGeneration, waitForAuthRequests } from "../../api/client";
import { getBrowserSession, listBrowserSessions, revokeBrowserSession, type BrowserSession, type BrowserSessionPage } from "../../api/browser-sessions";
import type { CurrentUser } from "../../api/auth";
import { useI18n } from "../../i18n/LocaleProvider";
import { CredentialLastUse } from "./CredentialLastUse";
import { ManagementDialog } from "./ManagementDialog";
import { DateLabel, ManagementError } from "./feedback";
import { credentialWriteRefused } from "./CredentialDescription";
import "./browser-sessions.css";

type Transport = { list: typeof listBrowserSessions; get: typeof getBrowserSession; revoke: typeof revokeBrowserSession };
const api: Transport = { list: listBrowserSessions, get: getBrowserSession, revoke: revokeBrowserSession };
type Recovery = { sessionId: string; targetId: string };
const recoveryKey = (userId: string) => `daynight.browserSessionRecovery.${userId}`;
const readRecovery = (userId: string): Recovery | null => {
  const raw = sessionStorage.getItem(recoveryKey(userId));
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || !("sessionId" in value) || typeof value.sessionId !== "string" || !("targetId" in value) || typeof value.targetId !== "string") throw new Error("Invalid browser session recovery");
  return { sessionId: value.sessionId, targetId: value.targetId };
};
const writeRecovery = (userId: string, value: Recovery | null) => {
  if (value === null) sessionStorage.removeItem(recoveryKey(userId));
  else sessionStorage.setItem(recoveryKey(userId), JSON.stringify(value));
};
type Props = { user: CurrentUser; onIdentityMismatch: () => void; onSignOut: () => void; visible: boolean; onRetentionChange?: (retain: boolean) => void; transport?: Transport };
export const BrowserSessionsPanel = (props: Props) => <BrowserSessionsContent key={props.user.id} {...props} />;

const BrowserSessionsContent = ({ user, onIdentityMismatch, onSignOut, visible, onRetentionChange, transport = api }: Props) => {
  const { locale, messages: { auth: { management: { common } } } } = useI18n();
  const m = locale === "zh-CN" ? {
    title: "浏览器登录", description: "连续 7 天未使用的登录会过期。后台刷新也计入使用。", loading: "正在加载浏览器登录…", empty: "没有其他浏览器登录。", current: "当前浏览器", browser: "未知浏览器", os: "未知系统", login: "登录时间", lastUnknown: "最近使用：未知", expiry: "到期时间", end: "结束会话", signOut: "退出登录", more: "加载更多", refresh: "刷新", cancel: "取消", confirm: "结束浏览器会话？", body: "此浏览器将失去 Daynight 的访问权限。当前浏览器保持登录。", ending: "正在结束…", ended: "浏览器会话已结束。", unknown: "结束结果未知。请读取目标的当前状态；不会自动重试。", unavailable: "目标当前不再活跃，无法确认原请求是否成功。", active: "目标仍然活跃，请核对后决定是否再次结束。", read: "读取当前状态", changed: "当前浏览器登录已改变，请重新核对列表。", storage: "无法保存待核对状态，请检查浏览器存储并重试。",
  } : {
    title: "Browser logins", description: "Logins expire after 7 days without use. Background refreshes count as use.", loading: "Loading browser logins…", empty: "No other browser logins.", current: "Current browser", browser: "Unknown browser", os: "Unknown system", login: "Signed in", lastUnknown: "Last used: Unknown", expiry: "Expires", end: "End session", signOut: "Sign out", more: "Load more", refresh: "Refresh", cancel: "Cancel", confirm: "End browser session?", body: "This browser will lose access to Daynight. Your current browser stays signed in.", ending: "Ending…", ended: "Browser session ended.", unknown: "The result is unknown. Read the target's current state; the request will not be repeated automatically.", unavailable: "The target is no longer active. The original request's outcome cannot be confirmed.", active: "The target is still active. Review it before deciding whether to end it again.", read: "Read current state", changed: "The current browser login changed. Review the list again.", storage: "Unable to retain recovery state. Check browser storage and try again.",
  };
  const [page, setPage] = useState<BrowserSessionPage | null>(null), pageRef = useRef<BrowserSessionPage | null>(null);
  const updatePage = (next: BrowserSessionPage) => { pageRef.current = next; setPage(next); };
  const [loading, setLoading] = useState(true), [pending, setPending] = useState(false), [error, setError] = useState<unknown>(null);
  const [storageError, setStorageError] = useState(false);
  const [selected, setSelected] = useState<BrowserSession | null>(null), [unknown, setUnknown] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const pagesLoaded = useRef(0);
  const lifetime = useRef<AbortController | null>(null), busy = useRef(false), focusAfter = useRef(false), heading = useRef<HTMLHeadingElement>(null);
  const callbacks = useRef({ transport, onIdentityMismatch }); callbacks.current = { transport, onIdentityMismatch };
  const retain = pending || selected !== null || unknown !== null || storageError;
  useLayoutEffect(() => { onRetentionChange?.(retain); }, [retain, onRetentionChange]);
  useLayoutEffect(() => { if (focusAfter.current && selected === null && visible) { focusAfter.current = false; heading.current?.focus(); } }, [selected, visible, page]);
  const run = async (operation: (signal: AbortSignal, current: () => boolean) => Promise<void>, writing = false) => {
    const owner = lifetime.current;
    if (!owner || owner.signal.aborted || busy.current) return;
    busy.current = true; writing ? setPending(true) : setLoading(true);
    const generation = readAuthRequestGeneration();
    const current = () => !owner.signal.aborted && generation === readAuthRequestGeneration();
    try { await waitForAuthRequests(owner.signal); if (current()) await operation(owner.signal, current); }
    catch (failure) { if (current() && !isAbortError(failure)) setError(failure); }
    finally { busy.current = false; if (current()) { setLoading(false); setPending(false); } }
  };
  const restoreRecovery = (sessionId: string) => {
    try {
      const recovery = readRecovery(user.id);
      if (recovery && recovery.sessionId === sessionId) setUnknown(recovery.targetId);
      else { setUnknown(null); if (recovery) writeRecovery(user.id, null); }
      setStorageError(false);
    } catch { setStorageError(true); }
  };
  const read = (more = false) => void run(async (signal, current) => {
    const previous = pageRef.current;
    const count = more ? 1 : Math.max(1, pagesLoaded.current);
    let cursor = more ? previous?.nextCursor ?? undefined : undefined;
    let result: BrowserSessionPage | null = null;
    const items: BrowserSession[] = more && previous ? [...previous.items] : [];
    const ids = new Set(items.map(item => item.id));
    let fetched = 0;
    for (let i = 0; i < count; i++) {
      const next = await callbacks.current.transport.list(signal, user.id, callbacks.current.onIdentityMismatch, cursor);
      await waitForAuthRequests(signal); if (!current()) return;
      if ((result && next.current.id !== result.current.id) || (more && previous && next.current.id !== previous.current.id)) {
        const observed = await callbacks.current.transport.list(signal, user.id, callbacks.current.onIdentityMismatch);
        await waitForAuthRequests(signal); if (!current()) return;
        setSelected(null); restoreRecovery(observed.current.id); setNotice(m.changed); pagesLoaded.current = 1; updatePage(observed); return;
      }
      result = next; fetched++;
      for (const item of next.items) if (!ids.has(item.id)) { ids.add(item.id); items.push(item); }
      if (next.nextCursor === null) break;
      cursor = next.nextCursor;
    }
    if (!result) return;
    // The cookie can change to another session of the same account without an
    // account-generation change. Recheck the caller before publishing a page.
    const observed = await callbacks.current.transport.list(signal, user.id, callbacks.current.onIdentityMismatch);
    await waitForAuthRequests(signal); if (!current()) return;
    if (observed.current.id !== result.current.id || previous && result.current.id !== previous.current.id) {
      setSelected(null); restoreRecovery(observed.current.id); setNotice(m.changed); pagesLoaded.current = 1; updatePage(observed); return;
    }
    restoreRecovery(result.current.id);
    pagesLoaded.current = more ? pagesLoaded.current + fetched : fetched;
    updatePage({ ...result, items }); setError(null);
  });
  const latestRead = useRef(read); latestRead.current = read;
  useEffect(() => { const owner = new AbortController(); lifetime.current = owner; void latestRead.current(); return () => { owner.abort(); lifetime.current = null; busy.current = false; }; }, [user.id, transport]);
  const verifyCaller = async (signal: AbortSignal, expected: string, current: () => boolean): Promise<boolean> => {
    const observed = await callbacks.current.transport.list(signal, user.id, callbacks.current.onIdentityMismatch);
    await waitForAuthRequests(signal); if (!current()) return false;
    if (observed.current.id !== expected) { pagesLoaded.current = 1; updatePage(observed); setSelected(null); restoreRecovery(observed.current.id); setNotice(m.changed); return false; }
    return true;
  };
  const reconcile = (target: string) => void run(async (signal, current) => {
    const expected = pageRef.current?.current.id; if (!expected) return;
    let actual: BrowserSession | null;
    try { actual = await callbacks.current.transport.get(target, signal, user.id, callbacks.current.onIdentityMismatch); }
    catch (failure) { if (failure instanceof ApiError && failure.status === 404 && failure.kind === "server") actual = null; else throw failure; }
    if (!await verifyCaller(signal, expected, current)) return;
    const before = pageRef.current; if (!before) return;
    updatePage({ ...before, items: actual === null ? before.items.filter(item => item.id !== target) : before.items.map(item => item.id === target ? actual! : item) });
    try { writeRecovery(user.id, null); setStorageError(false); } catch { setStorageError(true); return; }
    setUnknown(null); setSelected(null); setError(null); setNotice(actual === null ? m.unavailable : m.active); focusAfter.current = true;
  });
  const revoke = (target: BrowserSession) => void run(async (signal, current) => {
    const expected = pageRef.current?.current.id; if (!expected) return;
    setError(null); let dispatched = false;
    try { writeRecovery(user.id, { sessionId: expected, targetId: target.id }); setStorageError(false); }
    catch { setStorageError(true); return; }
    try {
      await callbacks.current.transport.revoke(target.id, { expectedUserId: user.id, expectedSessionId: expected }, signal, callbacks.current.onIdentityMismatch, () => { dispatched = true; });
      if (!await verifyCaller(signal, expected, current)) return;
      const before = pageRef.current; if (!before) return;
      try { writeRecovery(user.id, null); setStorageError(false); } catch { setStorageError(true); setUnknown(target.id); setSelected(null); return; }
      updatePage({ ...before, items: before.items.filter(item => item.id !== target.id) }); setSelected(null); setNotice(m.ended); focusAfter.current = true;
    } catch (failure) {
      if (!current()) return;
      if (!dispatched || credentialWriteRefused(failure) || failure instanceof ApiError && failure.status === 409) {
        try { writeRecovery(user.id, null); setStorageError(false); } catch { setStorageError(true); return; }
      }
      if (failure instanceof ApiError && failure.status === 409) { setSelected(null); setNotice(m.changed); setError(failure); }
      else if (!dispatched || credentialWriteRefused(failure)) { if (!isAbortError(failure)) setError(failure); }
      else { setUnknown(target.id); setSelected(null); setNotice(null); focusAfter.current = true; }
    }
  }, true);
  const row = (item: BrowserSession, isCurrent: boolean) => <div className="row browser-session-row" key={item.id}>
    <div><strong>{item.browser ?? m.browser}</strong><div className="person-meta">{item.os ?? m.os}{isCurrent && <> · <span className="browser-session-current">{m.current}</span></>}</div></div>
    <div className="browser-session-time"><span>{m.login}</span><DateLabel value={item.createdAt} /></div>
    <div className="browser-session-time">{item.lastUsedAt === null ? <span>{m.lastUnknown}</span> : <CredentialLastUse value={item.lastUsedAt} />}</div>
    <div className="browser-session-time"><span>{m.expiry}</span><DateLabel value={item.expiresAt} /></div>
    <div className="actions">{isCurrent ? <button className="button" type="button" onClick={onSignOut}>{m.signOut}</button> : <button className="button quiet" type="button" disabled={loading || pending || unknown !== null || storageError || error !== null} aria-label={`${m.end}: ${item.browser ?? m.browser} · ${item.os ?? m.os}`} onClick={() => { setNotice(null); setSelected(item); }}>{m.end}</button>}</div>
  </div>;
  return <section className="panel" aria-labelledby="browser-sessions-title"><div className="panel-heading"><div><h2 id="browser-sessions-title" ref={heading} tabIndex={-1}>{m.title}</h2><p>{m.description}</p></div><button className="button" type="button" disabled={loading || pending || unknown !== null} onClick={() => read()}>{m.refresh}</button></div>
    {storageError && <div className="notice error" role="alert"><p>{m.storage}</p><button className="button" type="button" onClick={() => unknown ? reconcile(unknown) : read()}>{common.retry}</button></div>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {unknown && <div className="notice warning" role="alert"><p>{m.unknown}</p><button className="button" type="button" disabled={loading || pending} onClick={() => reconcile(unknown)}>{m.read}</button></div>}
    {error !== null && <ManagementError error={error} retry={() => unknown ? reconcile(unknown) : read()} />}
    {page === null && loading && <div className="empty-inline" role="status">{m.loading}</div>}
    {page && <>{row(page.current, true)}{page.items.map(item => row(item, false))}{page.items.length === 0 && page.nextCursor === null && <div className="empty-inline">{m.empty}</div>}{page.nextCursor !== null && <div className="panel-body"><button className="button" type="button" disabled={loading || pending || unknown !== null} onClick={() => read(true)}>{m.more}</button></div>}</>}
    {selected && <ManagementDialog title={m.confirm} initialFocus="cancel" busy={pending} suspended={!visible} onClose={() => setSelected(null)} footer={<><button className="button" type="button" data-dialog-cancel disabled={pending} onClick={() => setSelected(null)}>{m.cancel}</button><button className="button danger" type="button" disabled={pending} onClick={() => revoke(selected)}>{pending ? m.ending : m.end}</button></>}><p>{selected.browser ?? m.browser} · {selected.os ?? m.os}</p><p>{m.body}</p>{error !== null && <ManagementError error={error} />}</ManagementDialog>}
  </section>;
};
