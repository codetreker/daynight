import { useEffect, useRef, useState } from "react";
import type { CurrentUser } from "../../api/auth";
import { ApiError, authRequestsPaused, isAbortError, subscribeAuthPause, waitForAuthRequests } from "../../api/client";
import { listOwnerGrants, revokeOwnerGrant, type OwnerGrant } from "../../api/oauth-grants";
import { useI18n } from "../../i18n/LocaleProvider";
import { ManagementDialog } from "./ManagementDialog";
import { DateLabel, Identity, ManagementError } from "./feedback";

type GrantApi = { readonly list: typeof listOwnerGrants; readonly revoke: typeof revokeOwnerGrant };
const api: GrantApi = { list: listOwnerGrants, revoke: revokeOwnerGrant };
type Recovery = { readonly grantId: string; readonly name: string; readonly kind: "unknown" | "confirmed" };
const markerKey = (userId: string) => `daynight.oauthGrantRecovery.${userId}`;
const readMarker = (userId: string): { readonly available: boolean; readonly grantId: string | null } => {
  try { return { available: true, grantId: sessionStorage.getItem(markerKey(userId)) }; }
  catch { return { available: false, grantId: null }; }
};
const writeMarker = (userId: string, grantId: string | null): boolean => {
  try {
    if (grantId === null) sessionStorage.removeItem(markerKey(userId));
    else sessionStorage.setItem(markerKey(userId), grantId);
    return true;
  } catch { return false; }
};

export const OwnerGrantsPanel = ({ user, onIdentityMismatch, transport = api, visible = true }: {
  readonly user: CurrentUser;
  readonly onIdentityMismatch: () => void;
  readonly transport?: GrantApi;
  readonly visible?: boolean;
}) => <OwnerGrantsContent key={user.id} user={user} onIdentityMismatch={onIdentityMismatch} transport={transport} visible={visible} />;

const OwnerGrantsContent = ({ user, onIdentityMismatch, transport, visible }: {
  readonly user: CurrentUser;
  readonly onIdentityMismatch: () => void;
  readonly transport: GrantApi;
  readonly visible: boolean;
}) => {
  const { messages: { auth: { management: { account: m, common } } } } = useI18n();
  const [grants, setGrants] = useState<readonly OwnerGrant[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [dialogError, setDialogError] = useState<unknown>(null);
  const [selected, setSelected] = useState<OwnerGrant | null>(null);
  const [initialMarker] = useState(() => readMarker(user.id));
  const [storageError, setStorageError] = useState(!initialMarker.available);
  const [recovery, setRecovery] = useState<Recovery | null>(() => initialMarker.grantId === null ? null : { grantId: initialMarker.grantId, name: initialMarker.grantId, kind: "unknown" });
  const [notice, setNotice] = useState<{ readonly name: string; readonly kind: "observed" | "saved" } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const reading = useRef<{ readonly controller: AbortController; readonly reconcile: Recovery | null } | null>(null);
  const submitting = useRef<{ readonly controller: AbortController; readonly grant: OwnerGrant; dispatched: boolean } | null>(null);
  const abandoned = useRef<{ readonly grant: OwnerGrant; readonly dispatched: boolean } | null>(null);
  const publication = useRef<AbortController | null>(null);
  const dialogRevision = useRef(0);
  const priorVisible = useRef(visible);
  if (priorVisible.current !== visible) { priorVisible.current = visible; dialogRevision.current += 1; }
  const heading = useRef<HTMLHeadingElement>(null);
  const restoreFocus = useRef(false);

  const load = async (lifetime: AbortSignal, reconcile: Recovery | null = null, revision = dialogRevision.current) => {
    if (reading.current !== null || authRequestsPaused() || lifetime.aborted) return;
    const read = { controller: new AbortController(), reconcile }; reading.current = read;
    const signal = AbortSignal.any([lifetime, read.controller.signal]);
    setLoading(true); setError(null);
    try {
      const result = await transport.list(signal, user.id, onIdentityMismatch);
      await waitForAuthRequests(signal);
      if (signal.aborted || reading.current !== read) return;
      setGrants(result);
      if (reconcile !== null) {
        if (!writeMarker(user.id, null)) { setStorageError(true); return; }
        setStorageError(false); setRecovery(null);
        if (dialogRevision.current === revision) { setSelected(null); setDialogError(null); restoreFocus.current = true; }
        const actual = result.find((grant) => grant.id === reconcile.grantId);
        setNotice({ name: actual?.clientName || actual?.clientId || reconcile.name, kind: reconcile.kind === "unknown" ? "observed" : "saved" });
      }
    } catch (failure) {
      try { await waitForAuthRequests(signal); } catch { return; }
      if (!signal.aborted && reading.current === read && !isAbortError(failure)) setError(failure);
    } finally { if (reading.current === read) { reading.current = null; if (!lifetime.aborted) setLoading(false); } }
  };
  useEffect(() => {
    const active = new AbortController(); controller.current = active;
    const previous = abandoned.current; abandoned.current = null;
    if (previous !== null) {
      setPending(false);
      if (previous.dispatched || !writeMarker(user.id, null)) {
        if (!previous.dispatched) setStorageError(true);
        setRecovery({ grantId: previous.grant.id, name: previous.grant.clientName || previous.grant.clientId, kind: "unknown" });
      }
      setLoading(false);
    } else if (initialMarker.available && initialMarker.grantId === null) {
      if (authRequestsPaused()) {
        void (async () => {
          try { await waitForAuthRequests(active.signal); if (!active.signal.aborted) await load(active.signal); }
          catch { /* The panel was disposed or its identity invalidated. */ }
        })();
      } else void load(active.signal);
    }
    else setLoading(false);
    const unsubscribe = subscribeAuthPause(() => {
      if (submitting.current !== null && !submitting.current.dispatched) submitting.current.controller.abort();
      if (reading.current !== null && reading.current.reconcile !== null) { reading.current.controller.abort(); reading.current = null; setLoading(false); publication.current?.abort(); publication.current = null; }
    });
    return () => {
      unsubscribe(); active.abort();
      if (submitting.current !== null) { abandoned.current = submitting.current; submitting.current.controller.abort(); submitting.current = null; }
      reading.current?.controller.abort(); reading.current = null; publication.current?.abort(); publication.current = null;
    };
  }, [user.id, transport]);
  useEffect(() => {
    if (selected === null && restoreFocus.current) { restoreFocus.current = false; heading.current?.focus(); }
  }, [selected, notice]);

  const refresh = () => {
    if (submitting.current !== null || reading.current !== null || authRequestsPaused()) return;
    publication.current?.abort(); publication.current = null;
    if (storageError) {
      const marker = readMarker(user.id);
      if (!marker.available) return;
      setStorageError(false);
      const next = recovery ?? (marker.grantId === null ? null : { grantId: marker.grantId, name: marker.grantId, kind: "unknown" as const });
      setRecovery(next); void load(controller.current!.signal, next); return;
    }
    void load(controller.current!.signal, recovery);
  };
  const revoke = async (grant: OwnerGrant) => {
    if (submitting.current !== null || reading.current !== null || recovery !== null || authRequestsPaused() || !grants?.some((item) => item.id === grant.id && item.status === "active")) return;
    publication.current?.abort(); publication.current = null;
    if (!writeMarker(user.id, grant.id)) { setStorageError(true); return; }
    setStorageError(false); setPending(true); setDialogError(null); setNotice(null);
    const lifetime = controller.current!.signal;
    const operation = { controller: new AbortController(), grant, dispatched: false }; submitting.current = operation;
    const signal = AbortSignal.any([lifetime, operation.controller.signal]);
    const revision = dialogRevision.current;
    try {
      await transport.revoke(grant.id, user.id, signal, onIdentityMismatch, () => { operation.dispatched = true; });
      if (!operation.dispatched) signal.throwIfAborted();
      if (lifetime.aborted || submitting.current !== operation) return;
      const next: Recovery = { grantId: grant.id, name: grant.clientName || grant.clientId, kind: "confirmed" };
      setRecovery(next);
      const owner = new AbortController(); publication.current = owner;
      const publishSignal = AbortSignal.any([lifetime, owner.signal]);
      // Publication belongs to this panel and can be superseded or disposed independently of the revoke.
      void (async () => {
        try {
          await waitForAuthRequests(publishSignal);
          if (!publishSignal.aborted && publication.current === owner) await load(publishSignal, next, revision);
        } catch { /* Cancellation or identity invalidation retires this publication. */ }
        finally { if (publication.current === owner) publication.current = null; }
      })();
    } catch (failure) {
      if (lifetime.aborted || submitting.current !== operation) return;
      const refused = failure instanceof ApiError && failure.kind === "server" && failure.status !== null && failure.status >= 400 && failure.status < 500 && failure.status !== 408 && failure.status !== 429;
      if ((!operation.dispatched || refused) && writeMarker(user.id, null)) {
        if (!isAbortError(failure)) setDialogError(failure);
      } else {
        if (!operation.dispatched || refused) setStorageError(true);
        setRecovery({ grantId: grant.id, name: grant.clientName || grant.clientId, kind: "unknown" });
      }
    } finally { if (submitting.current === operation) { submitting.current = null; if (!lifetime.aborted) setPending(false); } }
  };
  const closeDialog = () => { dialogRevision.current += 1; if (recovery !== null) restoreFocus.current = true; setSelected(null); };
  const blocked = loading || pending || recovery !== null || error !== null || storageError;
  const uncertain = recovery?.kind === "unknown";
  return <>
    <section className="panel" aria-labelledby="grants-title">
      <div className="panel-heading"><div><h2 id="grants-title" ref={heading} tabIndex={-1}>{m.grantsTitle}</h2><p>{m.grantsDescription}</p></div><button className="button" type="button" disabled={loading || pending} aria-busy={loading} onClick={refresh}>{m.grantsRefresh}</button></div>
      {grants === null && loading && <div className="empty-inline" role="status">{m.grantsLoading}</div>}
      {error !== null && selected === null && <div className="grant-status-notice"><ManagementError error={error} retry={refresh} /></div>}
      {storageError && <div className="notice error grant-status-notice" role="alert">{m.grantStorage}</div>}
      {notice !== null && <p className="notice grant-status-notice" role="status"><strong>{notice.name}</strong> · {notice.kind === "observed" ? m.grantObserved : m.grantSaved}</p>}
      {grants !== null && (grants.length === 0 ? <div className="empty-inline">{m.grantsEmpty}</div> : grants.map((grant) => {
        const name = grant.clientName || grant.clientId;
        return <div className={`row grant-row${grant.status === "active" ? "" : " revoked"}`} key={grant.id}>
          <div className="grant-main"><div className="grant-meta-line"><strong className="person-name">{name}</strong><span className={`badge${grant.status === "active" ? "" : " warning"}`}>{grant.status === "active" ? m.grantActive : grant.status === "expired" ? m.grantExpired : m.grantRevoked}</span></div><div className="grant-origin">{m.grantClient}: {grant.clientId}</div><div className="grant-scope">{m.grantScope}: {grant.scope}</div></div>
          <div className="grant-facts"><p>{m.grantResource}: <strong>{grant.resource}</strong></p><p>{common.createdAt}: <DateLabel value={grant.createdAt} /></p><p>{common.expiresAt}: <DateLabel value={grant.expiresAt} /></p>{grant.revokedAt !== null && <p>{m.grantRevoked}: <DateLabel value={grant.revokedAt} /></p>}</div>
          <div className="actions">{grant.status === "active" ? <button className="button quiet" type="button" disabled={blocked} aria-label={m.grantRevoke({ name })} onClick={() => { dialogRevision.current += 1; setSelected(grant); setDialogError(null); setNotice(null); }}>{common.revoke}</button> : <span className="muted small">{common.unusable}</span>}</div>
        </div>;
      }))}
      {recovery !== null && selected === null && <div className="notice warning grant-status-notice" role="alert"><p>{uncertain ? m.grantUnknown : m.grantReadCurrent} · {recovery.name}</p><button className="button" type="button" disabled={loading || pending} onClick={refresh}>{m.grantReadCurrent}</button></div>}
    </section><div className="notice">{m.grantsNotice}</div>
    {selected !== null && <ManagementDialog title={m.grantRevokeTitle} busy={pending || loading} suspended={!visible} onClose={closeDialog} footer={<><button className="button" type="button" disabled={pending || loading} onClick={closeDialog}>{common.cancel}</button>{recovery !== null ? <button className="button primary" type="button" disabled={pending || loading} onClick={refresh}>{m.grantReadCurrent}</button> : <button className="button danger" type="button" disabled={loading || pending || recovery !== null || error !== null || !grants?.some((item) => item.id === selected.id && item.status === "active")} onClick={() => { void revoke(selected); }}>{pending ? m.revoking : m.grantRevokeConfirm}</button>}</>}>
      <div className="grant-dialog-client"><strong>{selected.clientName || selected.clientId}</strong><p>{m.grantClient}: {selected.clientId}</p><p>{m.grantResource}: {selected.resource}</p><p>{m.grantScope}: {selected.scope}</p></div>
      <p>{m.grantRevokeEffect}</p><div className="grant-dialog-account"><Identity user={user} /></div>
      {dialogError !== null && <ManagementError error={dialogError} />}
      {recovery !== null && <div className="notice warning" role="alert">{uncertain ? m.grantUnknown : m.grantReadCurrent}</div>}
      {error !== null && <ManagementError error={error} />}
      {storageError && <div className="notice error" role="alert">{m.grantStorage}</div>}
    </ManagementDialog>}
  </>;
};
