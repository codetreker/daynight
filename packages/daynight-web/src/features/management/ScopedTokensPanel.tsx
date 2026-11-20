import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { revokeToken, updateTokenDescription, updateTokenExpiry, type CurrentUser } from "../../api/auth";
import { createScopedToken, listScopedTokens, updateTokenScopes, type ScopedToken } from "../../api/scoped-credential-management";
import { readCredentialScopeCatalog, type ScopeCatalog } from "../../api/credential-scope";
import { CredentialScopeSelector, credentialScopeLabel, hasCredentialScopeLabels } from "../auth/CredentialScopeSelector";
import { CredentialScopeEditor } from "./CredentialScopeEditor";
import { ApiError, isAbortError, waitForAuthRequests } from "../../api/client";
import { credentialDescriptionProblem, normalizeCredentialDescription } from "../../api/credential-description";
import { useI18n } from "../../i18n/LocaleProvider";
import { ManagementDialog } from "./ManagementDialog";
import { DateLabel, ManagementError, SecretDialog } from "./feedback";
import { parseTokenExpiryDraft, tokenExpiryDraft, TokenExpiryField } from "./TokenExpiryField";
import { CredentialLastUse, latestCredentialUse, mergeScopedCredentialUses } from "./CredentialLastUse";
import { credentialWriteRefused, DescriptionField, descriptionMessages, useCredentialDescriptions } from "./CredentialDescription";
import { useCredentialPanel } from "./useCredentialPanel";

export type ScopedTokenManagementApi = { readonly list: typeof listScopedTokens; readonly create: typeof createScopedToken; readonly revoke: typeof revokeToken; readonly update: typeof updateTokenExpiry; readonly describe: typeof updateTokenDescription; readonly scopes: typeof updateTokenScopes; readonly catalog: typeof readCredentialScopeCatalog };
const api: ScopedTokenManagementApi = { list: listScopedTokens, create: createScopedToken, revoke: revokeToken, update: updateTokenExpiry, describe: updateTokenDescription, scopes: updateTokenScopes, catalog: readCredentialScopeCatalog };
type Dialog = { readonly kind: "create" } | { readonly kind: "revoke" | "expiry" | "scope"; readonly token: ScopedToken } | { readonly kind: "secret"; readonly secret: string };
type Recovery = { readonly tokenId: string; readonly notice: "expiryConflict" | "expiryReconciled" };
type Notice = Recovery["notice"] | "expirySaved" | "expiryUnavailable";
const TokenExpiration = ({ value }: { readonly value: string | null }) => { const { messages: { auth: { management: { account: m } } } } = useI18n(); return value === null ? <>{m.neverExpires}</> : <DateLabel value={value} />; };
const recoveryKey = (userId: string, kind: "create" | "scope") => `daynight.tokenScopeRecovery.${kind}.${userId}`;
const readRecovery = (userId: string, kind: "create" | "scope") => sessionStorage.getItem(recoveryKey(userId, kind));
const writeRecovery = (userId: string, kind: "create" | "scope", value: string | null) => {
  if (value === null) sessionStorage.removeItem(recoveryKey(userId, kind));
  else sessionStorage.setItem(recoveryKey(userId, kind), value);
};
type ScopeMarker = { readonly tokenId: string; readonly version: string; readonly original: readonly string[]; readonly selected: readonly string[] };
const parseScopeMarker = (value: string | null): ScopeMarker | null => {
  if (value === null) return null;
  const marker: unknown = JSON.parse(value);
  if (typeof marker !== "object" || marker === null || !("tokenId" in marker) || typeof marker.tokenId !== "string" || !("version" in marker) || typeof marker.version !== "string" || !/^[1-9][0-9]*$/.test(marker.version) || !("original" in marker) || !Array.isArray(marker.original) || !("selected" in marker) || !Array.isArray(marker.selected) || !marker.original.every(id => typeof id === "string") || !marker.selected.every(id => typeof id === "string")) throw new Error("Invalid scope recovery marker");
  return { tokenId: marker.tokenId, version: marker.version, original: marker.original, selected: marker.selected };
};
type ScopedTokensPanelProps = { readonly user: CurrentUser; readonly onIdentityMismatch: () => void; readonly transport?: ScopedTokenManagementApi; readonly visible?: boolean; readonly onRetentionChange?: (retain: boolean) => void };
export const ScopedTokensPanel = (props: ScopedTokensPanelProps) => <ScopedTokensContent key={props.user.id} {...props} />;
const ScopedTokensContent = ({ user, onIdentityMismatch, transport = api, visible = true, onRetentionChange }: ScopedTokensPanelProps) => {
  const { locale, messages: { auth: { management: { account: m, common } } } } = useI18n(), d = descriptionMessages(locale);
  const panel = useCredentialPanel(user.id, transport.list, onIdentityMismatch, true, mergeScopedCredentialUses), { items: tokens, loading, pending, error } = panel;
  const [dialog, setDialog] = useState<Dialog | null>(null), [dialogError, setDialogError] = useState<unknown>(null);
  const [name, setName] = useState(""), [description, setDescription] = useState(""), [descriptionProblem, setDescriptionProblem] = useState<ReturnType<typeof credentialDescriptionProblem>>(null);
  const [expiry, setExpiry] = useState(() => tokenExpiryDraft(null)), [invalid, setInvalid] = useState(false);
  const [initialRecovery] = useState(() => { try { return { create: readRecovery(user.id, "create") !== null, scope: parseScopeMarker(readRecovery(user.id, "scope")), error: false }; } catch { return { create: false, scope: null, error: true }; } });
  const [storageError, setStorageError] = useState(initialRecovery.error);
  const [notice, setNotice] = useState<Notice | null>(null), [recovery, setRecovery] = useState<Recovery | null>(null), [createRecovery, setCreateRecovery] = useState(initialRecovery.create), [createObserved, setCreateObserved] = useState(false);
  const [catalog, setCatalog] = useState<ScopeCatalog | null>(null), [catalogError, setCatalogError] = useState(false);
  const [scopeVersionFloor, setScopeVersionFloor] = useState(initialRecovery.scope?.version ?? "1");
  const [scopeDraft, setScopeDraft] = useState<readonly string[]>(() => initialRecovery.scope?.selected ?? []), [scopeOriginal, setScopeOriginal] = useState<readonly string[]>(() => initialRecovery.scope?.original ?? []);
  const [scopeRecovery, setScopeRecovery] = useState<{ tokenId: string; kind: "conflict" | "unknown" | "review" } | null>(() => initialRecovery.scope === null ? null : { tokenId: initialRecovery.scope.tokenId, kind: "unknown" });
  const [catalogAttempt, setCatalogAttempt] = useState(0), [createReview, setCreateReview] = useState(false);
  const createDefaultsLoaded = useRef(false);
  const revision = useRef(0);
  const scopeText = locale === "zh-CN" ? { edit: "编辑权限", save: "保存", cancel: "取消", loading: "正在读取权限目录…", catalog: "无法读取权限目录，请重试。", retry: "重试", labels: "权限说明已更新，请刷新页面。", conflict: "权限或目录已变更，请读取当前状态并核对草稿。", unknown: "保存结果未知，请读取当前状态后核对。", read: "读取当前状态", review: "当前权限已读取，草稿已保留。请核对后继续。", checked: "已核对权限", saved: "权限已更新。", unavailable: "此凭据已不可用。" } : { edit: "Edit permissions", save: "Save", cancel: "Cancel", loading: "Reading permissions catalog…", catalog: "Unable to read the permissions catalog. Try again.", retry: "Retry", labels: "Permission descriptions have changed. Refresh this page.", conflict: "Permissions or the catalog changed. Read the current state and review your draft.", unknown: "The save result is unknown. Read the current state and review it.", read: "Read current state", review: "Current permissions are shown and your draft is preserved. Review them before continuing.", checked: "I reviewed the permissions", saved: "Permissions updated.", unavailable: "This credential is no longer available." };
  const [scopeNotice, setScopeNotice] = useState<string | null>(null);
  const catalogNeeded = dialog?.kind === "scope" || dialog?.kind === "create";
  useEffect(() => {
    if (!catalogNeeded) return;
    const controller = new AbortController(); setCatalog(null); setCatalogError(false);
    void transport.catalog(user.id, controller.signal, onIdentityMismatch).then(result => { if (!controller.signal.aborted) { setCatalog(result.pat); if (dialog?.kind === "create" && !createDefaultsLoaded.current) { createDefaultsLoaded.current = true; setScopeDraft(result.pat.defaultScopes); } } }).catch(() => { if (!controller.signal.aborted) setCatalogError(true); });
    return () => controller.abort();
  }, [catalogNeeded, catalogAttempt, transport.catalog, user.id, onIdentityMismatch]);
  const descriptions = useCredentialDescriptions({ panel, userId: user.id, mismatch: onIdentityMismatch, transport: transport.describe, visible, name: token => token.name, onOpen: () => { ++revision.current; setDialog(null); } });
  useEffect(() => {
    if (scopeRecovery?.kind !== "review" || tokens === null) return;
    const actual = tokens.find(item => item.id === scopeRecovery.tokenId);
    if (actual && (actual.expiresAt === null || Date.parse(actual.expiresAt) > Date.now())) return;
    try { writeRecovery(user.id, "scope", null); setStorageError(false); } catch { setStorageError(true); return; }
    setScopeRecovery(null); setScopeNotice(scopeText.unavailable);
    setDialog(current => current?.kind === "scope" && current.token.id === scopeRecovery.tokenId ? null : current);
  }, [scopeRecovery, tokens, user.id, scopeText.unavailable]);
  const retained = pending || dialog !== null || recovery !== null || createRecovery || scopeRecovery !== null || storageError || descriptions.retained;
  useLayoutEffect(() => { onRetentionChange?.(retained); }, [retained, onRetentionChange]);
  const blocked = loading || pending || recovery !== null || error !== null || storageError;
  const open = (next: Dialog) => {
    if (panel.busy() || recovery !== null || error !== null || next.kind === "create" && (createRecovery || scopeRecovery !== null)) return;
    descriptions.close(); ++revision.current; setDialog(next); setDialogError(null); setInvalid(false); setNotice(null);
    if (next.kind === "create") { setName(""); setDescription(""); setDescriptionProblem(null); setExpiry(tokenExpiryDraft(null)); setCreateObserved(false); createDefaultsLoaded.current = false; setCreateReview(false); }
    if (next.kind === "expiry") setExpiry(tokenExpiryDraft(next.token.expiresAt));
    if (next.kind === "scope") { if (scopeRecovery?.tokenId !== next.token.id || scopeOriginal.length === 0) { setScopeDraft(next.token.scopePolicy.scopes); setScopeOriginal(next.token.scopePolicy.scopes); setScopeVersionFloor(next.token.scopePolicy.scopeVersion); } setScopeNotice(null); }
  };
  const close = () => { if (!pending) { if (dialog?.kind === "scope" && scopeRecovery?.kind === "review") { try { writeRecovery(user.id, "scope", null); setStorageError(false); setScopeRecovery(null); } catch { setStorageError(true); return; } } ++revision.current; setDialog(null); } };
  const reconcileExpiry = (target: Recovery) => { void panel.read(items => {
    const actual = items.find(token => token.id === target.tokenId);
    setRecovery(null); setDialogError(null); setInvalid(false);
    if (actual === undefined) { setDialog(null); setNotice("expiryUnavailable"); }
    else if (actual.expiresAt !== null && Date.parse(actual.expiresAt) <= Date.now()) { setDialog(null); setNotice("expiryUnavailable"); }
    else { setDialog({ kind: "expiry", token: actual }); setExpiry(tokenExpiryDraft(actual.expiresAt)); setNotice(target.notice); }
  }); };
  const refresh = () => {
    if (storageError) { try { const create = readRecovery(user.id, "create"), scope = parseScopeMarker(readRecovery(user.id, "scope")); setStorageError(false); if (create !== null) setCreateRecovery(true); if (scope !== null) { setScopeDraft(scope.selected); setScopeOriginal(scope.original); setScopeVersionFloor(scope.version); setScopeRecovery({ tokenId: scope.tokenId, kind: "unknown" }); } } catch { return; } }
    if (recovery !== null) reconcileExpiry(recovery); else void panel.read(() => { if (createRecovery) { try { writeRecovery(user.id, "create", null); setStorageError(false); setCreateRecovery(false); setCreateObserved(true); } catch { setStorageError(true); } } });
  };
  const create = async (event: FormEvent) => {
    event.preventDefault(); if (panel.busy() || createRecovery || recovery !== null || catalog === null || !hasCredentialScopeLabels(catalog, locale) || scopeDraft.length === 0 || createReview || scopeDraft.some(id => !catalog.groups.some(group => group.scopeIds.includes(id)))) return;
    const expiresAt = parseTokenExpiryDraft(expiry), problem = credentialDescriptionProblem(description);
    if (problem !== null || descriptionProblem !== null) { setDescriptionProblem(problem ?? descriptionProblem); return; }
    if (name.trim() === "" || !name.isWellFormed() || name.includes("\0") || Array.from(name).length > 100 || expiresAt === undefined) { setInvalid(true); return; }
    try { writeRecovery(user.id, "create", "pending"); setStorageError(false); } catch { setStorageError(true); return; }
    const instance = revision.current;
    await panel.write(async context => {
      setDialogError(null); setInvalid(false);
      try {
        const result = await transport.create({ name, expiresAt, description: normalizeCredentialDescription(description), expectedUserId: user.id, catalogRevision: catalog.catalogRevision, scopes: scopeDraft }, context.signal, onIdentityMismatch, context.onDispatch);
        await waitForAuthRequests(context.signal);
        if (!context.current()) return;
        try { writeRecovery(user.id, "create", null); } catch { setStorageError(true); setCreateRecovery(true); }
        const { token, ...metadata } = result;
        panel.setItems(items => [metadata, ...items!.filter(item => item.id !== metadata.id)]);
        if (revision.current === instance) setDialog({ kind: "secret", secret: token });
        void panel.read();
      } catch (failure) {
        try { await waitForAuthRequests(context.signal); } catch { return; }
        if (!context.current()) return;
        if (failure instanceof ApiError && failure.status === 409 || credentialWriteRefused(failure) || !context.dispatched()) {
          try { writeRecovery(user.id, "create", null); } catch { setStorageError(true); setCreateRecovery(true); return; }
        }
        if (failure instanceof ApiError && failure.status === 409) { setCreateReview(true); setCatalogAttempt(value => value + 1); setDialogError(null); }
        else if (credentialWriteRefused(failure) || (!context.dispatched() && isAbortError(failure))) setDialogError(isAbortError(failure) ? null : failure);
        else { setCreateRecovery(true); setDialogError(failure); }
      }
    }, dispatched => { if (dispatched) setCreateRecovery(true); else { try { writeRecovery(user.id, "create", null); } catch { setStorageError(true); } } });
  };
  const revoke = async (token: ScopedToken) => {
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
  const saveExpiry = async (event: FormEvent, token: ScopedToken) => {
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
  const reconcileScope = (target: { tokenId: string; kind: "conflict" | "unknown" | "review" }) => {
    void panel.read((items, raw) => {
      const actual = items.find(item => item.id === target.tokenId), rawItem = raw.find(item => item.id === target.tokenId);
      if (actual && rawItem && (BigInt(rawItem.scopePolicy.scopeVersion) < BigInt(actual.scopePolicy.scopeVersion) || BigInt(rawItem.scopePolicy.scopeVersion) < BigInt(scopeVersionFloor))) { setDialogError(new ApiError("protocol")); return; }
      if (!actual || actual.expiresAt !== null && Date.parse(actual.expiresAt) <= Date.now()) { try { writeRecovery(user.id, "scope", null); setStorageError(false); } catch { setStorageError(true); return; } setScopeRecovery(null); setDialog(null); setScopeNotice(scopeText.unavailable); return; }
      try { writeRecovery(user.id, "scope", JSON.stringify({ tokenId: target.tokenId, version: actual.scopePolicy.scopeVersion, original: actual.scopePolicy.scopes, selected: scopeDraft })); setStorageError(false); } catch { setStorageError(true); return; }
      setScopeVersionFloor(actual.scopePolicy.scopeVersion);
      if (scopeOriginal.length === 0) setScopeDraft(actual.scopePolicy.scopes);
      setScopeOriginal(actual.scopePolicy.scopes);
      setDialog(current => current?.kind === "scope" && current.token.id === target.tokenId ? { kind: "scope", token: actual } : current);
      setScopeRecovery({ tokenId: target.tokenId, kind: "review" }); setCatalogAttempt(value => value + 1);
    });
  };
  const saveScope = async (token: ScopedToken) => {
    if (panel.busy() || scopeRecovery !== null || catalog === null || !hasCredentialScopeLabels(catalog, locale) || scopeDraft.length === 0 || scopeDraft.some(id => !scopeOriginal.includes(id) && !catalog.groups.some(group => group.scopeIds.includes(id)))) return;
    try { writeRecovery(user.id, "scope", JSON.stringify({ tokenId: token.id, version: scopeVersionFloor, original: scopeOriginal, selected: scopeDraft })); setStorageError(false); } catch { setStorageError(true); return; }
    const instance = revision.current;
    await panel.write(async context => {
      setDialogError(null);
      try {
        const saved = await transport.scopes(token.id, { expectedUserId: user.id, expectedScopeVersion: scopeVersionFloor, catalogRevision: catalog.catalogRevision, scopes: scopeDraft }, context.signal, onIdentityMismatch, context.onDispatch);
        await waitForAuthRequests(context.signal); if (!context.current()) return;
        try { writeRecovery(user.id, "scope", null); } catch { setStorageError(true); setScopeRecovery({ tokenId: token.id, kind: "unknown" }); return; }
        panel.setItems(items => items?.map(item => item.id === saved.id && BigInt(saved.scopePolicy.scopeVersion) >= BigInt(item.scopePolicy.scopeVersion) ? { ...item, scopePolicy: saved.scopePolicy } : item) ?? null);
        setScopeRecovery(null); setScopeNotice(scopeText.saved);
        if (revision.current === instance) setDialog(null);
      } catch (failure) {
        try { await waitForAuthRequests(context.signal); } catch { return; }
        if (!context.current()) return;
        if (!(failure instanceof ApiError && (failure.status === 409 || failure.status === 404)) && (credentialWriteRefused(failure) || !context.dispatched())) {
          try { writeRecovery(user.id, "scope", null); } catch { setStorageError(true); setScopeRecovery({ tokenId: token.id, kind: "unknown" }); return; }
          setDialogError(isAbortError(failure) ? null : failure);
        }
        else setScopeRecovery({ tokenId: token.id, kind: failure instanceof ApiError && (failure.status === 409 || failure.status === 404) ? "conflict" : "unknown" });
      }
    }, dispatched => { if (dispatched) setScopeRecovery({ tokenId: token.id, kind: "unknown" }); else { try { writeRecovery(user.id, "scope", null); } catch { setStorageError(true); } } });
  };
  const expiryField = <TokenExpiryField draft={expiry} onChange={next => { setExpiry(next); setInvalid(false); }} disabled={pending || recovery !== null || loading} invalid={invalid && parseTokenExpiryDraft(expiry) === undefined} />;
  const expiryNotice = notice === null ? null : <p className={`notice${notice === "expirySaved" ? " success" : ""}`} role="status">{m[notice]}</p>;
  return <>
    {error !== null && recovery === null && <ManagementError error={error} retry={refresh} />}{dialog?.kind !== "expiry" && expiryNotice}{descriptions.recovery}{storageError && <div className="notice error" role="alert"><p>{locale === "zh-CN" ? "无法保存待核对状态，请检查浏览器存储。" : "Unable to retain the pending recovery. Check browser storage."}</p><button className="button" type="button" onClick={refresh}>{scopeText.retry}</button></div>}{scopeNotice !== null && <p className="notice" role="status">{scopeNotice}</p>}
    {scopeRecovery !== null && dialog?.kind !== "scope" && <div className="notice warning" role="alert"><p>{scopeRecovery.kind === "conflict" ? scopeText.conflict : scopeRecovery.kind === "unknown" ? scopeText.unknown : scopeText.review}</p><button className="button" type="button" disabled={loading || pending} onClick={() => { const token = tokens?.find(item => item.id === scopeRecovery.tokenId); if (token) open({ kind: "scope", token }); }}>{scopeText.edit}</button>{scopeRecovery.kind !== "review" && <button className="button" type="button" disabled={loading || pending} onClick={() => reconcileScope(scopeRecovery)}>{scopeText.read}</button>}</div>}
    {createRecovery && <div className="notice warning" role="alert"><p>{d.createUnknown}</p><button className="button" type="button" disabled={loading || pending} onClick={refresh}>{d.read}</button></div>}{createObserved && <p className="notice" role="status">{d.createObserved}</p>}
    <section className="panel" aria-labelledby="tokens-title"><div className="panel-heading panel-heading-description"><div><h2 id="tokens-title">{m.tokensTitle}</h2><p>{m.tokensDescription}</p></div><button className="button primary" type="button" disabled={blocked || createRecovery || scopeRecovery !== null || tokens === null} onClick={() => open({ kind: "create" })}>{m.createToken}</button></div>
      {tokens === null && loading && <div className="empty-inline" role="status">{m.loading}</div>}
      {tokens !== null && (tokens.length === 0 ? !loading && <div className="empty-inline">{m.empty}</div> : tokens.map(token => {
        const expired = token.expiresAt !== null && Date.parse(token.expiresAt) <= Date.now();
        return <div className={`row token-row${expired ? " revoked" : ""}`} key={token.id}><div>{descriptions.label(token)}<div className="person-meta">{common.createdAt} <DateLabel value={token.createdAt} /> {expired && <span className="badge warning">{common.expired}</span>}</div></div><div className="row-detail"><p>{token.scopePolicy.scopes.slice(0, 3).join(", ")}{token.scopePolicy.scopes.length > 3 ? ` +${token.scopePolicy.scopes.length - 3}` : ""} · {token.scopePolicy.scopes.length}</p><strong>{common.expiresAt} <TokenExpiration value={token.expiresAt} /></strong><CredentialLastUse value={token.lastUsedAt} /></div><div className="actions">{expired ? <span className="muted small">{common.unusable}</span> : <><button className="button quiet" type="button" disabled={blocked || descriptions.unresolved(token.id) || scopeRecovery !== null} aria-label={`${scopeText.edit}: ${token.name}`} onClick={() => open({ kind: "scope", token })}>{scopeText.edit}</button><button className="button quiet" type="button" disabled={blocked || descriptions.unresolved(token.id) || scopeRecovery?.tokenId === token.id} aria-label={m.editExpiryLabel({ name: token.name })} onClick={() => open({ kind: "expiry", token })}>{m.editExpiry}</button><button className="button quiet" type="button" disabled={blocked || descriptions.unresolved(token.id)} aria-label={m.revokeLabel({ name: token.name })} onClick={() => open({ kind: "revoke", token })}>{common.revoke}</button></>}</div></div>;
      }))}
    </section><div className="notice">{m.authorityNotice}</div><p className="muted small">{m.oneTimeNotice}</p>
    {descriptions.editor}
    {dialog?.kind === "secret" && <SecretDialog kind="token" secret={dialog.secret} suspended={!visible} onClose={close} />}
    {dialog?.kind === "create" && <ManagementDialog title={m.createTitle} busy={pending} suspended={!visible} preserveFocus onClose={close} footer={<><button className="button" type="button" disabled={pending} onClick={close}>{common.cancel}</button>{createRecovery ? <button className="button primary" type="button" disabled={pending || loading} onClick={refresh}>{d.read}</button> : <button className="button primary" type="submit" form="create-token-form" disabled={pending || loading || catalog === null || !hasCredentialScopeLabels(catalog, locale) || scopeDraft.length === 0 || createReview || scopeDraft.some(id => !catalog.groups.some(group => group.scopeIds.includes(id)))}>{pending ? m.creating : m.createToken}</button>}</>}>
      <form id="create-token-form" onSubmit={event => { void create(event); }} noValidate><div className="field"><label htmlFor="token-name">{m.nameLabel} <span className="required">*</span></label><input id="token-name" value={name} onChange={event => setName(event.currentTarget.value)} required disabled={pending} autoComplete="off" placeholder={m.namePlaceholder} /><p className="hint">{m.nameHint}</p></div><DescriptionField id="token-create-description" value={description} onChange={setDescription} problem={descriptionProblem} onProblem={setDescriptionProblem} disabled={pending} optional />{expiryField}{createReview && <div className="notice warning" role="status">{scopeText.review}<button type="button" className="button" disabled={!catalog || catalogError} onClick={() => setCreateReview(false)}>{scopeText.checked}</button></div>}{catalog && scopeDraft.some(id => !catalog.groups.some(group => group.scopeIds.includes(id))) && <div className="notice warning" role="alert"><p>{locale === "zh-CN" ? "已选权限目前不可用：" : "Selected permissions are unavailable:"} {scopeDraft.filter(id => !catalog.groups.some(group => group.scopeIds.includes(id))).join(", ")}</p><button type="button" className="button" onClick={() => setScopeDraft(scopeDraft.filter(id => catalog.groups.some(group => group.scopeIds.includes(id))))}>{locale === "zh-CN" ? "移除不可用权限" : "Remove unavailable permissions"}</button></div>}{catalog && <CredentialScopeSelector catalog={catalog} selected={scopeDraft} onChange={setScopeDraft} disabled={pending} />}{catalogError && <div className="notice warning" role="alert">{scopeText.catalog}<button type="button" className="button" onClick={() => setCatalogAttempt(value => value + 1)}>{scopeText.retry}</button></div>}{!catalog && !catalogError && <p role="status">{scopeText.loading}</p>}{catalog && !hasCredentialScopeLabels(catalog, locale) && <p className="notice warning" role="alert">{scopeText.labels}</p>}{invalid && <p className="notice error" role="alert">{m.validation}</p>}{dialogError !== null && <ManagementError error={dialogError} />}{createRecovery && <div className="notice warning" role="status">{d.createUnknown}</div>}{createRecovery && error !== null && <ManagementError error={error} />}<div className="notice">{m.createNotice}</div></form>
    </ManagementDialog>}
    {dialog?.kind === "scope" && <ManagementDialog title={scopeText.edit} busy={pending} suspended={!visible} preserveFocus onClose={close} footer={<><button className="button" type="button" disabled={pending} onClick={close}>{scopeText.cancel}</button>{scopeRecovery?.kind === "unknown" || scopeRecovery?.kind === "conflict" ? <button className="button primary" type="button" disabled={loading || pending} onClick={() => reconcileScope(scopeRecovery)}>{scopeText.read}</button> : <button className="button primary" type="button" disabled={blocked || catalog === null || !hasCredentialScopeLabels(catalog, locale) || scopeDraft.length === 0 || scopeRecovery !== null || scopeDraft.some(id => !scopeOriginal.includes(id) && !catalog.groups.some(group => group.scopeIds.includes(id))) || scopeDraft.length === scopeOriginal.length && scopeDraft.every(id => scopeOriginal.includes(id))} onClick={() => { void saveScope(dialog.token); }}>{scopeText.save}</button>}</>}>
      <p>{dialog.token.name}</p>{scopeRecovery !== null && <div className="notice warning" role="status">{scopeRecovery.kind === "conflict" ? scopeText.conflict : scopeRecovery.kind === "unknown" ? scopeText.unknown : scopeText.review}{scopeRecovery.kind === "review" && <p>{locale === "zh-CN" ? "当前权限：" : "Current permissions: "}{scopeOriginal.map((id, index) => <span key={id}>{index > 0 && ", "}{credentialScopeLabel(id, locale)} <code>{id}</code></span>)}</p>}{scopeRecovery.kind === "review" && <button className="button" type="button" disabled={catalog === null || catalogError} onClick={() => { try { writeRecovery(user.id, "scope", null); setStorageError(false); setScopeRecovery(null); } catch { setStorageError(true); } }}>{scopeText.checked}</button>}</div>}{catalog && <CredentialScopeEditor catalog={catalog} original={scopeOriginal} selected={scopeDraft} onChange={setScopeDraft} disabled={pending || scopeRecovery !== null} />}{catalogError && <div className="notice warning" role="alert">{scopeText.catalog}<button className="button" type="button" onClick={() => setCatalogAttempt(value => value + 1)}>{scopeText.retry}</button></div>}{!catalog && !catalogError && <p role="status">{scopeText.loading}</p>}{catalog && !hasCredentialScopeLabels(catalog, locale) && <p className="notice warning" role="alert">{scopeText.labels}</p>}{dialogError !== null && <ManagementError error={dialogError} />}{error !== null && <ManagementError error={error} retry={() => { if (scopeRecovery && scopeRecovery.kind !== "review") reconcileScope(scopeRecovery); }} />}
    </ManagementDialog>}
    {dialog?.kind === "revoke" && <ManagementDialog title={m.revokeTitle} initialFocus="cancel" busy={pending} suspended={!visible} onClose={close} footer={<><button className="button" type="button" data-dialog-cancel disabled={pending} onClick={close}>{common.cancel}</button><button className="button danger" type="button" disabled={pending} onClick={() => { void revoke(dialog.token); }}>{pending ? m.revoking : m.revokeConfirm}</button></>}><p>{m.revokeBody({ name: dialog.token.name })}</p>{dialogError !== null && <ManagementError error={dialogError} />}</ManagementDialog>}
    {dialog?.kind === "expiry" && <ManagementDialog title={m.editExpiryTitle} busy={pending || recovery !== null || loading} suspended={!visible} onClose={close} footer={<><button className="button" type="button" disabled={pending || recovery !== null || loading} onClick={close}>{common.cancel}</button><button className="button primary" type="submit" form="edit-token-expiry-form" disabled={blocked || parseTokenExpiryDraft(expiry) === dialog.token.expiresAt}>{pending ? m.savingExpiry : m.saveExpiry}</button></>}>
      <p>{m.editExpiryBody({ name: dialog.token.name })}</p><p className="token-current-expiry">{m.currentExpiry}：<strong><TokenExpiration value={dialog.token.expiresAt} /></strong></p>{expiryNotice}
      {recovery !== null && <div className="notice warning" role="alert"><p>{m.expiryUncertain}</p><button className="button" type="button" disabled={loading || pending} onClick={refresh}>{m.retryExpiryRead}</button></div>}{error !== null && <ManagementError error={error} />}
      <form id="edit-token-expiry-form" noValidate onSubmit={event => { void saveExpiry(event, dialog.token); }}>{expiryField}{dialogError !== null && <ManagementError error={dialogError} />}</form>
    </ManagementDialog>}
  </>;
};
