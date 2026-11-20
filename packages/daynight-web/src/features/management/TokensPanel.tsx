import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createToken, listTokens, revokeToken, updateTokenDescription, updateTokenExpiry, type CurrentUser, type PersonalAccessToken } from "../../api/auth";
import { ApiError, isAbortError, waitForAuthRequests } from "../../api/client";
import { credentialDescriptionProblem, normalizeCredentialDescription } from "../../api/credential-description";
import { useI18n } from "../../i18n/LocaleProvider";
import { ManagementDialog } from "./ManagementDialog";
import { DateLabel, ManagementError, SecretDialog } from "./feedback";
import { parseTokenExpiryDraft, tokenExpiryDraft, TokenExpiryField } from "./TokenExpiryField";
import { CredentialLastUse, latestCredentialUse } from "./CredentialLastUse";
import { credentialWriteRefused, DescriptionField, descriptionMessages, useCredentialDescriptions } from "./CredentialDescription";
import { useCredentialPanel } from "./useCredentialPanel";

export type TokenManagementApi = { readonly list: typeof listTokens; readonly create: typeof createToken; readonly revoke: typeof revokeToken; readonly update: typeof updateTokenExpiry; readonly describe: typeof updateTokenDescription };
const api: TokenManagementApi = { list: listTokens, create: createToken, revoke: revokeToken, update: updateTokenExpiry, describe: updateTokenDescription };
type Dialog = { readonly kind: "create" } | { readonly kind: "revoke" | "expiry"; readonly token: PersonalAccessToken } | { readonly kind: "secret"; readonly secret: string };
type Recovery = { readonly tokenId: string; readonly notice: "expiryConflict" | "expiryReconciled" };
type Notice = Recovery["notice"] | "expirySaved" | "expiryUnavailable";
const TokenExpiration = ({ value }: { readonly value: string | null }) => { const { messages: { auth: { management: { account: m } } } } = useI18n(); return value === null ? <>{m.neverExpires}</> : <DateLabel value={value} />; };
type TokensPanelProps = { readonly user: CurrentUser; readonly onIdentityMismatch: () => void; readonly transport?: TokenManagementApi; readonly visible?: boolean; readonly onRetentionChange?: (retain: boolean) => void };
export const TokensPanel = (props: TokensPanelProps) => <TokensContent key={props.user.id} {...props} />;
const TokensContent = ({ user, onIdentityMismatch, transport = api, visible = true, onRetentionChange }: TokensPanelProps) => {
  const { locale, messages: { auth: { management: { account: m, common } } } } = useI18n(), d = descriptionMessages(locale);
  const panel = useCredentialPanel(user.id, transport.list, onIdentityMismatch), { items: tokens, loading, pending, error } = panel;
  const [dialog, setDialog] = useState<Dialog | null>(null), [dialogError, setDialogError] = useState<unknown>(null);
  const [name, setName] = useState(""), [description, setDescription] = useState(""), [descriptionProblem, setDescriptionProblem] = useState<ReturnType<typeof credentialDescriptionProblem>>(null);
  const [expiry, setExpiry] = useState(() => tokenExpiryDraft(null)), [invalid, setInvalid] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null), [recovery, setRecovery] = useState<Recovery | null>(null), [createRecovery, setCreateRecovery] = useState(false), [createObserved, setCreateObserved] = useState(false);
  const revision = useRef(0);
  const descriptions = useCredentialDescriptions({ panel, userId: user.id, mismatch: onIdentityMismatch, transport: transport.describe, visible, name: token => token.name, onOpen: () => { ++revision.current; setDialog(null); } });
  const retained = pending || dialog !== null || recovery !== null || createRecovery || descriptions.retained;
  useLayoutEffect(() => { onRetentionChange?.(retained); }, [retained, onRetentionChange]);
  const blocked = loading || pending || recovery !== null || error !== null;
  const open = (next: Dialog) => {
    if (panel.busy() || recovery !== null || error !== null || next.kind === "create" && createRecovery) return;
    descriptions.close(); ++revision.current; setDialog(next); setDialogError(null); setInvalid(false); setNotice(null);
    if (next.kind === "create") { setName(""); setDescription(""); setDescriptionProblem(null); setExpiry(tokenExpiryDraft(null)); setCreateObserved(false); }
    if (next.kind === "expiry") setExpiry(tokenExpiryDraft(next.token.expiresAt));
  };
  const close = () => { if (!pending) { ++revision.current; setDialog(null); } };
  const reconcileExpiry = (target: Recovery) => { void panel.read(items => {
    const actual = items.find(token => token.id === target.tokenId);
    setRecovery(null); setDialogError(null); setInvalid(false);
    if (actual === undefined) { setDialog(null); setNotice("expiryUnavailable"); }
    else if (actual.expiresAt !== null && Date.parse(actual.expiresAt) <= Date.now()) { setDialog(null); setNotice("expiryUnavailable"); }
    else { setDialog({ kind: "expiry", token: actual }); setExpiry(tokenExpiryDraft(actual.expiresAt)); setNotice(target.notice); }
  }); };
  const refresh = () => { if (recovery !== null) reconcileExpiry(recovery); else void panel.read(() => { if (createRecovery) { setCreateRecovery(false); setCreateObserved(true); } }); };
  const create = async (event: FormEvent) => {
    event.preventDefault(); if (panel.busy() || createRecovery || recovery !== null) return;
    const expiresAt = parseTokenExpiryDraft(expiry), problem = credentialDescriptionProblem(description);
    if (problem !== null || descriptionProblem !== null) { setDescriptionProblem(problem ?? descriptionProblem); return; }
    if (name.trim() === "" || !name.isWellFormed() || name.includes("\0") || Array.from(name).length > 100 || expiresAt === undefined) { setInvalid(true); return; }
    const instance = revision.current;
    await panel.write(async context => {
      setDialogError(null); setInvalid(false);
      try {
        const result = await transport.create({ name, expiresAt, description: normalizeCredentialDescription(description), expectedUserId: user.id }, context.signal, onIdentityMismatch, context.onDispatch);
        await waitForAuthRequests(context.signal);
        if (!context.current()) return;
        const { token, ...metadata } = result;
        panel.setItems(items => [metadata, ...items!.filter(item => item.id !== metadata.id)]);
        if (revision.current === instance) setDialog({ kind: "secret", secret: token });
        void panel.read();
      } catch (failure) {
        try { await waitForAuthRequests(context.signal); } catch { return; }
        if (!context.current()) return;
        if (credentialWriteRefused(failure) || (!context.dispatched() && isAbortError(failure))) setDialogError(isAbortError(failure) ? null : failure);
        else { setCreateRecovery(true); setDialogError(failure); }
      }
    });
  };
  const revoke = async (token: PersonalAccessToken) => {
    if (panel.busy() || recovery !== null || descriptions.unresolved(token.id)) return;
    await panel.write(async context => {
      setDialogError(null);
      try {
        await transport.revoke(token.id, context.signal);
        await waitForAuthRequests(context.signal); if (!context.current()) return;
        setDialog(null); void panel.read();
      } catch (failure) {
        try { await waitForAuthRequests(context.signal); } catch { return; }
        if (context.current() && !isAbortError(failure)) setDialogError(failure);
      }
    });
  };
  const saveExpiry = async (event: FormEvent, token: PersonalAccessToken) => {
    event.preventDefault(); if (panel.busy() || recovery !== null || descriptions.unresolved(token.id)) return;
    const expiresAt = parseTokenExpiryDraft(expiry);
    if (expiresAt === undefined) { setInvalid(true); return; }
    if (expiresAt === token.expiresAt) return;
    await panel.write(async context => {
      setDialogError(null); setNotice(null); setInvalid(false);
      try {
        const saved = await transport.update(token.id, { expiresAt, expectedExpiresAt: token.expiresAt, expectedUserId: user.id }, context.signal, onIdentityMismatch);
        await waitForAuthRequests(context.signal); if (!context.current()) return;
        panel.setItems(items => items!.map(item => item.id === saved.id ? { ...item, expiresAt: saved.expiresAt, lastUsedAt: latestCredentialUse(item.lastUsedAt, saved.lastUsedAt) } : item));
        setDialog(null); setNotice("expirySaved");
      } catch (failure) {
        try { await waitForAuthRequests(context.signal); } catch { return; }
        if (!context.current() || isAbortError(failure)) return;
        if (failure instanceof ApiError && failure.status !== 404 && credentialWriteRefused(failure)) setDialogError(failure);
        else { const target: Recovery = { tokenId: token.id, notice: failure instanceof ApiError && failure.status === 409 ? "expiryConflict" : "expiryReconciled" }; setRecovery(target); reconcileExpiry(target); }
      }
    });
  };
  const expiryField = <TokenExpiryField draft={expiry} onChange={next => { setExpiry(next); setInvalid(false); }} disabled={pending || recovery !== null || loading} invalid={invalid && parseTokenExpiryDraft(expiry) === undefined} />;
  const expiryNotice = notice === null ? null : <p className={`notice${notice === "expirySaved" ? " success" : ""}`} role="status">{m[notice]}</p>;
  return <>
    {error !== null && recovery === null && <ManagementError error={error} retry={refresh} />}{dialog?.kind !== "expiry" && expiryNotice}{descriptions.recovery}
    {createRecovery && <div className="notice warning" role="alert"><p>{d.createUnknown}</p><button className="button" type="button" disabled={loading || pending} onClick={refresh}>{d.read}</button></div>}{createObserved && <p className="notice" role="status">{d.createObserved}</p>}
    <section className="panel" aria-labelledby="tokens-title"><div className="panel-heading panel-heading-description"><div><h2 id="tokens-title">{m.tokensTitle}</h2><p>{m.tokensDescription}</p></div><button className="button primary" type="button" disabled={blocked || createRecovery || tokens === null} onClick={() => open({ kind: "create" })}>{m.createToken}</button></div>
      {tokens === null && loading && <div className="empty-inline" role="status">{m.loading}</div>}
      {tokens !== null && (tokens.length === 0 ? !loading && <div className="empty-inline">{m.empty}</div> : tokens.map(token => {
        const expired = token.expiresAt !== null && Date.parse(token.expiresAt) <= Date.now();
        return <div className={`row token-row${expired ? " revoked" : ""}`} key={token.id}><div>{descriptions.label(token)}<div className="person-meta">{common.createdAt} <DateLabel value={token.createdAt} /> {expired && <span className="badge warning">{common.expired}</span>}</div></div><div className="row-detail"><strong>{common.expiresAt} <TokenExpiration value={token.expiresAt} /></strong><CredentialLastUse value={token.lastUsedAt} /></div><div className="actions">{expired ? <span className="muted small">{common.unusable}</span> : <><button className="button quiet" type="button" disabled={blocked || descriptions.unresolved(token.id)} aria-label={m.editExpiryLabel({ name: token.name })} onClick={() => open({ kind: "expiry", token })}>{m.editExpiry}</button><button className="button quiet" type="button" disabled={blocked || descriptions.unresolved(token.id)} aria-label={m.revokeLabel({ name: token.name })} onClick={() => open({ kind: "revoke", token })}>{common.revoke}</button></>}</div></div>;
      }))}
    </section><div className="notice">{m.authorityNotice}</div><p className="muted small">{m.oneTimeNotice}</p>
    {descriptions.editor}
    {dialog?.kind === "secret" && <SecretDialog kind="token" secret={dialog.secret} suspended={!visible} onClose={close} />}
    {dialog?.kind === "create" && <ManagementDialog title={m.createTitle} busy={pending} suspended={!visible} preserveFocus onClose={close} footer={<><button className="button" type="button" disabled={pending} onClick={close}>{common.cancel}</button>{createRecovery ? <button className="button primary" type="button" disabled={pending || loading} onClick={refresh}>{d.read}</button> : <button className="button primary" type="submit" form="create-token-form" disabled={pending || loading}>{pending ? m.creating : m.createToken}</button>}</>}>
      <form id="create-token-form" onSubmit={event => { void create(event); }} noValidate><div className="field"><label htmlFor="token-name">{m.nameLabel} <span className="required">*</span></label><input id="token-name" value={name} onChange={event => setName(event.currentTarget.value)} required disabled={pending} autoComplete="off" placeholder={m.namePlaceholder} /><p className="hint">{m.nameHint}</p></div><DescriptionField id="token-create-description" value={description} onChange={setDescription} problem={descriptionProblem} onProblem={setDescriptionProblem} disabled={pending} optional />{expiryField}{invalid && <p className="notice error" role="alert">{m.validation}</p>}{dialogError !== null && <ManagementError error={dialogError} />}{createRecovery && <div className="notice warning" role="status">{d.createUnknown}</div>}{createRecovery && error !== null && <ManagementError error={error} />}<div className="notice">{m.createNotice}</div></form>
    </ManagementDialog>}
    {dialog?.kind === "revoke" && <ManagementDialog title={m.revokeTitle} initialFocus="cancel" busy={pending} suspended={!visible} onClose={close} footer={<><button className="button" type="button" data-dialog-cancel disabled={pending} onClick={close}>{common.cancel}</button><button className="button danger" type="button" disabled={pending} onClick={() => { void revoke(dialog.token); }}>{pending ? m.revoking : m.revokeConfirm}</button></>}><p>{m.revokeBody({ name: dialog.token.name })}</p>{dialogError !== null && <ManagementError error={dialogError} />}</ManagementDialog>}
    {dialog?.kind === "expiry" && <ManagementDialog title={m.editExpiryTitle} busy={pending || recovery !== null || loading} suspended={!visible} onClose={close} footer={<><button className="button" type="button" disabled={pending || recovery !== null || loading} onClick={close}>{common.cancel}</button><button className="button primary" type="submit" form="edit-token-expiry-form" disabled={blocked || parseTokenExpiryDraft(expiry) === dialog.token.expiresAt}>{pending ? m.savingExpiry : m.saveExpiry}</button></>}>
      <p>{m.editExpiryBody({ name: dialog.token.name })}</p><p className="token-current-expiry">{m.currentExpiry}：<strong><TokenExpiration value={dialog.token.expiresAt} /></strong></p>{expiryNotice}
      {recovery !== null && <div className="notice warning" role="alert"><p>{m.expiryUncertain}</p><button className="button" type="button" disabled={loading || pending} onClick={refresh}>{m.retryExpiryRead}</button></div>}{error !== null && <ManagementError error={error} />}
      <form id="edit-token-expiry-form" noValidate onSubmit={event => { void saveExpiry(event, dialog.token); }}>{expiryField}{dialogError !== null && <ManagementError error={dialogError} />}</form>
    </ManagementDialog>}
  </>;
};
