import { useLayoutEffect, useRef, useState } from "react";
import type { CurrentUser } from "../../api/auth";
import { isAbortError, waitForAuthRequests } from "../../api/client";
import { listOwnerGrants, revokeOwnerGrant, updateOwnerGrantDescription, type OwnerGrant } from "../../api/oauth-grants";
import { useI18n } from "../../i18n/LocaleProvider";
import { ManagementDialog } from "./ManagementDialog";
import { DateLabel, Identity, ManagementError } from "./feedback";
import { CredentialLastUse } from "./CredentialLastUse";
import { credentialWriteRefused, useCredentialDescriptions } from "./CredentialDescription";
import { useCredentialPanel } from "./useCredentialPanel";

type GrantApi = { readonly list: typeof listOwnerGrants; readonly revoke: typeof revokeOwnerGrant; readonly describe: typeof updateOwnerGrantDescription };
const api: GrantApi = { list: listOwnerGrants, revoke: revokeOwnerGrant, describe: updateOwnerGrantDescription };
type Recovery = { readonly grantId: string; readonly name: string; readonly kind: "unknown" | "confirmed" };
const markerKey = (userId: string) => `daynight.oauthGrantRecovery.${userId}`;
const readMarker = (userId: string): { readonly available: boolean; readonly grantId: string | null } => {
  try { return { available: true, grantId: sessionStorage.getItem(markerKey(userId)) }; }
  catch { return { available: false, grantId: null }; }
};
const writeMarker = (userId: string, grantId: string | null): boolean => {
  try { if (grantId === null) sessionStorage.removeItem(markerKey(userId)); else sessionStorage.setItem(markerKey(userId), grantId); return true; }
  catch { return false; }
};
type Props = { readonly user: CurrentUser; readonly onIdentityMismatch: () => void; readonly transport?: GrantApi; readonly visible?: boolean; readonly onRetentionChange?: (retain: boolean) => void };
export const OwnerGrantsPanel = (props: Props) => <OwnerGrantsContent key={props.user.id} {...props} />;
const OwnerGrantsContent = ({ user, onIdentityMismatch, transport = api, visible = true, onRetentionChange }: Props) => {
  const { messages: { auth: { management: { account: m, common } } } } = useI18n();
  const [initialMarker] = useState(() => readMarker(user.id));
  const panel = useCredentialPanel(user.id, transport.list, onIdentityMismatch, initialMarker.available && initialMarker.grantId === null);
  const { items: grants, loading, pending, error } = panel;
  const [dialogError, setDialogError] = useState<unknown>(null), [selected, setSelected] = useState<OwnerGrant | null>(null);
  const [storageError, setStorageError] = useState(!initialMarker.available);
  const [recovery, setRecovery] = useState<Recovery | null>(() => initialMarker.grantId === null ? null : { grantId: initialMarker.grantId, name: initialMarker.grantId, kind: "unknown" });
  const [notice, setNotice] = useState<{ readonly name: string; readonly kind: "observed" | "saved" } | null>(null);
  const dialogRevision = useRef(0), priorVisible = useRef(visible);
  if (priorVisible.current !== visible) { priorVisible.current = visible; ++dialogRevision.current; }
  const heading = useRef<HTMLHeadingElement>(null), restoreFocus = useRef(false);
  const descriptions = useCredentialDescriptions({ panel, userId: user.id, mismatch: onIdentityMismatch, transport: transport.describe, visible, name: grant => grant.clientName || grant.clientId, onOpen: () => { ++dialogRevision.current; setSelected(null); } });
  const retained = pending || selected !== null || recovery !== null || descriptions.retained;
  useLayoutEffect(() => { onRetentionChange?.(retained); }, [retained, onRetentionChange]);
  useLayoutEffect(() => { if (selected === null && restoreFocus.current && visible) { restoreFocus.current = false; heading.current?.focus(); } }, [selected, notice, visible]);
  const read = (target: Recovery | null = recovery, revision = dialogRevision.current) => { void panel.read(items => {
    if (target === null) return;
    if (!writeMarker(user.id, null)) { setStorageError(true); return; }
    setStorageError(false); setRecovery(null);
    if (dialogRevision.current === revision) { setSelected(null); setDialogError(null); restoreFocus.current = true; }
    const actual = items.find(grant => grant.id === target.grantId);
    setNotice({ name: actual?.clientName || actual?.clientId || target.name, kind: target.kind === "unknown" ? "observed" : "saved" });
  }); };
  const refresh = () => {
    if (panel.busy()) return;
    if (storageError) {
      const marker = readMarker(user.id); if (!marker.available) return;
      setStorageError(false);
      const next = recovery ?? (marker.grantId === null ? null : { grantId: marker.grantId, name: marker.grantId, kind: "unknown" as const });
      setRecovery(next); read(next); return;
    }
    read();
  };
  const revoke = async (grant: OwnerGrant) => {
    if (panel.busy() || recovery !== null || descriptions.unresolved(grant.id) || !grants?.some(item => item.id === grant.id && item.status === "active")) return;
    if (!writeMarker(user.id, grant.id)) { setStorageError(true); return; }
    const revision = dialogRevision.current;
    setStorageError(false); setDialogError(null); setNotice(null);
    await panel.write(async context => {
      try {
        await transport.revoke(grant.id, user.id, context.signal, onIdentityMismatch, context.onDispatch);
        context.settled();
        const next: Recovery = { grantId: grant.id, name: grant.clientName || grant.clientId, kind: "confirmed" };
        setRecovery(next);
        await waitForAuthRequests(context.signal);
        if (context.current()) read(next, revision);
      } catch (failure) {
        if (!context.current()) return;
        if ((!context.dispatched() || credentialWriteRefused(failure)) && writeMarker(user.id, null)) {
          if (!isAbortError(failure) && dialogRevision.current === revision) setDialogError(failure);
        } else {
          if (!context.dispatched() || credentialWriteRefused(failure)) setStorageError(true);
          setRecovery({ grantId: grant.id, name: grant.clientName || grant.clientId, kind: "unknown" });
        }
      }
    }, () => {
      if (readMarker(user.id).grantId !== null) setRecovery({ grantId: grant.id, name: grant.clientName || grant.clientId, kind: "unknown" });
    });
  };
  const closeDialog = () => { if (pending) return; ++dialogRevision.current; if (recovery !== null) restoreFocus.current = true; setSelected(null); };
  const blocked = loading || pending || recovery !== null || error !== null || storageError;
  const uncertain = recovery?.kind === "unknown";
  return <>
    {descriptions.recovery}
    <section className="panel" aria-labelledby="grants-title"><div className="panel-heading panel-heading-description"><div><h2 id="grants-title" ref={heading} tabIndex={-1}>{m.grantsTitle}</h2><p>{m.grantsDescription}</p></div><button className="button" type="button" disabled={loading || pending} aria-busy={loading} onClick={refresh}>{m.grantsRefresh}</button></div>
      {grants === null && loading && <div className="empty-inline" role="status">{m.grantsLoading}</div>}{error !== null && selected === null && <div className="grant-status-notice"><ManagementError error={error} retry={refresh} /></div>}{storageError && <div className="notice error grant-status-notice" role="alert">{m.grantStorage}</div>}
      {notice !== null && <p className="notice grant-status-notice" role="status"><strong>{notice.name}</strong> · {notice.kind === "observed" ? m.grantObserved : m.grantSaved}</p>}
      {grants !== null && (grants.length === 0 ? <div className="empty-inline">{m.grantsEmpty}</div> : grants.map(grant => {
        const name = grant.clientName || grant.clientId;
        return <div className={`row grant-row owner-grant-row${grant.status === "active" ? "" : " revoked"}`} key={grant.id}>
          <div className="grant-main"><div className="grant-meta-line"><div>{descriptions.label(grant)}</div><span className={`badge${grant.status === "active" ? "" : " warning"}`}>{grant.status === "active" ? m.grantActive : grant.status === "expired" ? m.grantExpired : m.grantRevoked}</span></div><div className="grant-origin">{m.grantClient}: {grant.clientId}</div><div className="grant-scope">{m.grantScope}: {grant.scope}</div></div>
          <div className="grant-facts"><p>{m.grantResource}: <strong>{grant.resource}</strong></p><p>{common.createdAt}: <DateLabel value={grant.createdAt} /></p><p>{common.expiresAt}: <DateLabel value={grant.expiresAt} /></p><CredentialLastUse value={grant.lastUsedAt} />{grant.revokedAt !== null && <p>{m.grantRevoked}: <DateLabel value={grant.revokedAt} /></p>}</div>
          <div className="actions">{grant.status === "active" ? <button className="button quiet" type="button" disabled={blocked || descriptions.unresolved(grant.id)} aria-label={m.grantRevoke({ name })} onClick={() => { descriptions.close(); ++dialogRevision.current; setSelected(grant); setDialogError(null); setNotice(null); }}>{common.revoke}</button> : <span className="muted small">{common.unusable}</span>}</div>
        </div>;
      }))}
      {recovery !== null && selected === null && <div className="notice warning grant-status-notice" role="alert"><p>{uncertain ? m.grantUnknown : m.grantReadCurrent} · {recovery.name}</p><button className="button" type="button" disabled={loading || pending} onClick={refresh}>{m.grantReadCurrent}</button></div>}
    </section><div className="notice">{m.grantsNotice}</div>{descriptions.editor}
    {selected !== null && <ManagementDialog title={m.grantRevokeTitle} busy={pending || loading} suspended={!visible} onClose={closeDialog} footer={<><button className="button" type="button" disabled={pending || loading} onClick={closeDialog}>{common.cancel}</button>{recovery !== null ? <button className="button primary" type="button" disabled={pending || loading} onClick={refresh}>{m.grantReadCurrent}</button> : <button className="button danger" type="button" disabled={loading || pending || recovery !== null || error !== null || !grants?.some(item => item.id === selected.id && item.status === "active")} onClick={() => { void revoke(selected); }}>{pending ? m.revoking : m.grantRevokeConfirm}</button>}</>}>
      <div className="grant-dialog-client"><strong>{selected.clientName || selected.clientId}</strong><p>{m.grantClient}: {selected.clientId}</p><p>{m.grantResource}: {selected.resource}</p><p>{m.grantScope}: {selected.scope}</p></div><p>{m.grantRevokeEffect}</p><div className="grant-dialog-account"><Identity user={user} /></div>
      {dialogError !== null && <ManagementError error={dialogError} />}{recovery !== null && <div className="notice warning" role="alert">{uncertain ? m.grantUnknown : m.grantReadCurrent}</div>}{error !== null && <ManagementError error={error} />}{storageError && <div className="notice error" role="alert">{m.grantStorage}</div>}
    </ManagementDialog>}
  </>;
};
