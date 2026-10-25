import { useEffect, useRef, useState, type FormEvent } from "react";
import { createToken, listTokens, revokeToken, updateTokenExpiry, type CurrentUser, type PersonalAccessToken } from "../../api/auth";
import { ApiError, isAbortError } from "../../api/client";
import { useI18n } from "../../i18n/LocaleProvider";
import { ManagementDialog } from "./ManagementDialog";
import { DateLabel, ManagementError, SecretDialog } from "./feedback";
import { parseTokenExpiryDraft, tokenExpiryDraft, TokenExpiryField } from "./TokenExpiryField";

export type TokenManagementApi = { readonly list: typeof listTokens; readonly create: typeof createToken; readonly revoke: typeof revokeToken; readonly update: typeof updateTokenExpiry };
const api: TokenManagementApi = { list: listTokens, create: createToken, revoke: revokeToken, update: updateTokenExpiry };
type Dialog = { readonly kind: "create" } | { readonly kind: "revoke" | "expiry"; readonly token: PersonalAccessToken } | { readonly kind: "secret"; readonly secret: string };
type Recovery = { readonly tokenId: string; readonly notice: "expiryConflict" | "expiryReconciled" };
type Notice = Recovery["notice"] | "expirySaved" | "expiryUnavailable";

const TokenExpiration = ({ value }: { readonly value: string | null }) => {
  const { messages: { auth: { management: { account: m } } } } = useI18n();
  return value === null ? <>{m.neverExpires}</> : <DateLabel value={value} />;
};

type TokensPanelProps = {
  readonly user: CurrentUser;
  readonly onIdentityMismatch: () => void;
  readonly transport?: TokenManagementApi;
};
export const TokensPanel = (props: TokensPanelProps) => <TokensContent key={props.user.id} {...props} />;

const TokensContent = ({ user, onIdentityMismatch, transport = api }: TokensPanelProps) => {
  const { messages: { auth: { management: { account: m, common } } } } = useI18n();
  const [tokens, setTokens] = useState<readonly PersonalAccessToken[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [pending, setPending] = useState(false);
  const [dialogError, setDialogError] = useState<unknown>(null);
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState(() => tokenExpiryDraft(null));
  const [invalid, setInvalid] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const submitting = useRef(false);

  const load = async (signal: AbortSignal, reconcile?: Recovery) => {
    const request = ++generation.current;
    setLoading(true); setError(null);
    try {
      const result = await transport.list(signal, user.id, onIdentityMismatch);
      if (signal.aborted || request !== generation.current) return;
      setTokens(result);
      if (reconcile !== undefined) {
        const actual = result.find((token) => token.id === reconcile.tokenId);
        setRecovery(null); setDialogError(null); setInvalid(false);
        if (actual === undefined) { setDialog(null); setNotice("expiryUnavailable"); }
        else { setDialog({ kind: "expiry", token: actual }); setExpiry(tokenExpiryDraft(actual.expiresAt)); setNotice(reconcile.notice); }
      }
    } catch (failure) {
      if (!signal.aborted && request === generation.current && !isAbortError(failure)) setError(failure);
    } finally { if (!signal.aborted && request === generation.current) setLoading(false); }
  };
  useEffect(() => {
    const active = new AbortController(); controller.current = active;
    void load(active.signal);
    return () => { active.abort(); ++generation.current; };
  }, [user.id, transport]);
  const blocked = loading || pending || recovery !== null || error !== null;
  const open = (next: Dialog) => {
    if (blocked) return;
    setDialog(next); setDialogError(null); setInvalid(false); setNotice(null);
    if (next.kind === "create") { setName(""); setExpiry(tokenExpiryDraft(null)); }
    if (next.kind === "expiry") setExpiry(tokenExpiryDraft(next.token.expiresAt));
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting.current || recovery !== null) return;
    const expiresAt = parseTokenExpiryDraft(expiry);
    if (name.trim() === "" || !name.isWellFormed() || name.includes("\0") || Array.from(name).length > 100 || expiresAt === undefined) { setInvalid(true); return; }
    submitting.current = true; setPending(true); setDialogError(null); setInvalid(false);
    const signal = controller.current!.signal;
    try {
      const result = await transport.create({ name, expiresAt }, signal);
      if (signal.aborted) return;
      const { token, ...metadata } = result;
      setTokens((items) => [metadata, ...items!]); setDialog({ kind: "secret", secret: token });
    } catch (failure) { if (!signal.aborted && !isAbortError(failure)) setDialogError(failure); }
    finally { if (!signal.aborted) { submitting.current = false; setPending(false); } }
  };
  const revoke = async (token: PersonalAccessToken) => {
    if (submitting.current || recovery !== null) return;
    submitting.current = true; setPending(true); setDialogError(null);
    const signal = controller.current!.signal;
    try {
      await transport.revoke(token.id, signal);
      if (signal.aborted) return;
      setDialog(null); await load(signal);
    } catch (failure) { if (!signal.aborted && !isAbortError(failure)) setDialogError(failure); }
    finally { if (!signal.aborted) { submitting.current = false; setPending(false); } }
  };
  const saveExpiry = async (event: FormEvent, token: PersonalAccessToken) => {
    event.preventDefault();
    if (submitting.current || blocked) return;
    const expiresAt = parseTokenExpiryDraft(expiry);
    if (expiresAt === undefined) { setInvalid(true); return; }
    if (expiresAt === token.expiresAt) return;
    submitting.current = true; setPending(true); setDialogError(null); setNotice(null); setInvalid(false);
    const signal = controller.current!.signal;
    try {
      const saved = await transport.update(token.id, { expiresAt, expectedExpiresAt: token.expiresAt, expectedUserId: user.id }, signal, onIdentityMismatch);
      if (signal.aborted) return;
      setTokens((items) => items!.map((item) => item.id === saved.id ? saved : item)); setDialog(null); setNotice("expirySaved");
    } catch (failure) {
      if (signal.aborted || isAbortError(failure)) return;
      if (failure instanceof ApiError && failure.kind === "server" && failure.status === 404) {
        setTokens((items) => items!.filter((item) => item.id !== token.id)); setDialog(null); setNotice("expiryUnavailable");
      } else if (failure instanceof ApiError && failure.kind === "server" && failure.status !== null && failure.status >= 400 && failure.status < 500 && failure.status !== 409) setDialogError(failure);
      else {
        const reconcile: Recovery = { tokenId: token.id, notice: failure instanceof ApiError && failure.status === 409 ? "expiryConflict" : "expiryReconciled" };
        setRecovery(reconcile); await load(signal, reconcile);
      }
    } finally { if (!signal.aborted) { submitting.current = false; setPending(false); } }
  };
  const refresh = () => { if (!submitting.current && !loading) void load(controller.current!.signal, recovery ?? undefined); };
  const expiryField = <TokenExpiryField draft={expiry} onChange={(next) => { setExpiry(next); setInvalid(false); }} disabled={pending || recovery !== null || loading} invalid={invalid && parseTokenExpiryDraft(expiry) === undefined} />;
  const expiryNotice = notice === null ? null : <p className={`notice${notice === "expirySaved" ? " success" : ""}`} role="status">{m[notice]}</p>;
  return <>
    {error !== null && recovery === null && <ManagementError error={error} retry={refresh} />}
    {dialog?.kind !== "expiry" && expiryNotice}
    <section className="panel" aria-labelledby="tokens-title"><div className="panel-heading"><div><h2 id="tokens-title">{m.tokensTitle}</h2><p>{m.tokensDescription}</p></div><button className="button primary" type="button" disabled={blocked || tokens === null} onClick={() => open({ kind: "create" })}>{m.createToken}</button></div>
      {loading && <div className="empty-inline" role="status">{m.loading}</div>}
      {tokens !== null && (tokens.length === 0 ? !loading && <div className="empty-inline">{m.empty}</div> : tokens.map((token) => {
        const expired = token.expiresAt !== null && Date.parse(token.expiresAt) <= Date.now();
        return <div className={`row token-row${expired ? " revoked" : ""}`} key={token.id}><div><div className="person-name">{token.name}</div><div className="person-meta">{common.createdAt} <DateLabel value={token.createdAt} /> {expired && <span className="badge warning">{common.expired}</span>}</div></div><div className="row-detail"><strong>{common.expiresAt} <TokenExpiration value={token.expiresAt} /></strong></div><div className="actions">{expired ? <span className="muted small">{common.unusable}</span> : <><button className="button quiet" type="button" disabled={blocked} aria-label={m.editExpiryLabel({ name: token.name })} onClick={() => open({ kind: "expiry", token })}>{m.editExpiry}</button><button className="button quiet" type="button" disabled={blocked} aria-label={m.revokeLabel({ name: token.name })} onClick={() => open({ kind: "revoke", token })}>{common.revoke}</button></>}</div></div>;
      }))}
    </section><div className="notice">{m.authorityNotice}</div><p className="muted small">{m.oneTimeNotice}</p>
    {dialog?.kind === "secret" && <SecretDialog kind="token" secret={dialog.secret} onClose={() => setDialog(null)} />}
    {dialog?.kind === "create" && <ManagementDialog title={m.createTitle} busy={pending} onClose={() => setDialog(null)} footer={<><button className="button" type="button" disabled={pending} onClick={() => setDialog(null)}>{common.cancel}</button><button className="button primary" type="submit" form="create-token-form" disabled={pending}>{pending ? m.creating : m.createToken}</button></>}>
      <form id="create-token-form" onSubmit={(event) => { void create(event); }} noValidate><div className="field"><label htmlFor="token-name">{m.nameLabel} <span className="required">*</span></label><input id="token-name" value={name} onChange={(event) => setName(event.currentTarget.value)} required disabled={pending} autoComplete="off" placeholder={m.namePlaceholder} /><p className="hint">{m.nameHint}</p></div>{expiryField}{invalid && <p className="notice error" role="alert">{m.validation}</p>}{dialogError !== null && <ManagementError error={dialogError} />}<div className="notice">{m.createNotice}</div></form>
    </ManagementDialog>}
    {dialog?.kind === "revoke" && <ManagementDialog title={m.revokeTitle} busy={pending} onClose={() => setDialog(null)} footer={<><button className="button" type="button" disabled={pending} onClick={() => setDialog(null)}>{common.cancel}</button><button className="button danger" type="button" disabled={pending} onClick={() => { void revoke(dialog.token); }}>{pending ? m.revoking : m.revokeConfirm}</button></>}><p>{m.revokeBody({ name: dialog.token.name })}</p>{dialogError !== null && <ManagementError error={dialogError} />}</ManagementDialog>}
    {dialog?.kind === "expiry" && <ManagementDialog title={m.editExpiryTitle} busy={pending || recovery !== null || loading} onClose={() => setDialog(null)} footer={<><button className="button" type="button" disabled={pending || recovery !== null || loading} onClick={() => setDialog(null)}>{common.cancel}</button><button className="button primary" type="submit" form="edit-token-expiry-form" disabled={blocked || parseTokenExpiryDraft(expiry) === dialog.token.expiresAt}>{pending ? m.savingExpiry : m.saveExpiry}</button></>}>
      <p>{m.editExpiryBody({ name: dialog.token.name })}</p><p className="token-current-expiry">{m.currentExpiry}：<strong><TokenExpiration value={dialog.token.expiresAt} /></strong></p>{expiryNotice}
      {recovery !== null && <div className="notice warning" role="alert"><p>{m.expiryUncertain}</p><button className="button" type="button" disabled={loading || pending} onClick={refresh}>{m.retryExpiryRead}</button></div>}{error !== null && <ManagementError error={error} />}
      <form id="edit-token-expiry-form" noValidate onSubmit={(event) => { void saveExpiry(event, dialog.token); }}>{expiryField}{dialogError !== null && <ManagementError error={dialogError} />}</form>
    </ManagementDialog>}
  </>;
};
