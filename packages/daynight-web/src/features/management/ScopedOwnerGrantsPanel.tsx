import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CurrentUser } from "../../api/auth";
import { ApiError, isAbortError, waitForAuthRequests } from "../../api/client";
import { revokeOwnerGrant, updateOwnerGrantDescription } from "../../api/oauth-grants";
import { listScopedOwnerGrants, updateOwnerGrantScopes, type ScopedOwnerGrant } from "../../api/scoped-credential-management";
import { readCredentialScopeCatalog, type ScopeCatalog } from "../../api/credential-scope";
import { hasCredentialScopeLabels } from "../auth/CredentialScopeSelector";
import { CredentialScopeEditor } from "./CredentialScopeEditor";
import { useI18n } from "../../i18n/LocaleProvider";
import { ManagementDialog } from "./ManagementDialog";
import { DateLabel, Identity, ManagementError } from "./feedback";
import { CredentialLastUse, mergeScopedCredentialUses } from "./CredentialLastUse";
import { credentialWriteRefused, useCredentialDescriptions } from "./CredentialDescription";
import { useCredentialPanel } from "./useCredentialPanel";

export type ScopedGrantApi = { readonly list: typeof listScopedOwnerGrants; readonly catalog: typeof readCredentialScopeCatalog; readonly updateScopes: typeof updateOwnerGrantScopes; readonly revoke: typeof revokeOwnerGrant; readonly describe: typeof updateOwnerGrantDescription };
const api: ScopedGrantApi = { list: listScopedOwnerGrants, catalog: readCredentialScopeCatalog, updateScopes: updateOwnerGrantScopes, revoke: revokeOwnerGrant, describe: updateOwnerGrantDescription };
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
type Props = { readonly user: CurrentUser; readonly onIdentityMismatch: () => void; readonly transport?: ScopedGrantApi; readonly visible?: boolean; readonly onRetentionChange?: (retain: boolean) => void };
export const ScopedOwnerGrantsPanel = (props: Props) => <ScopedOwnerGrantsContent key={props.user.id} {...props} />;
const ScopedOwnerGrantsContent = ({ user, onIdentityMismatch, transport = api, visible = true, onRetentionChange }: Props) => {
  const { locale, messages: { auth: { management: { account: m, common } } } } = useI18n();
  const copy = locale === "zh-CN" ? {
    edit: "编辑权限", save: "保存权限", saving: "正在保存…", read: "读取当前权限", saved: "权限已更新。", unavailable: "此授权已不可编辑。", unknown: "保存结果未知，请读取当前权限后核对。", conflict: "权限或目录已变化，请读取当前权限后核对。", observed: "当前权限已读取，草稿已保留。请核对后继续。", review: "已核对权限", catalogError: "无法读取权限目录，请重试。", labels: "权限说明已更新，请刷新页面。", empty: "请至少选择一项权限。", storage: "无法保存待核对状态，请检查浏览器存储。", fixed: "固定权限，无法编辑", current: "当前权限", retry: "重试读取目录", resume: "继续核对权限",
  } : {
    edit: "Edit permissions", save: "Save permissions", saving: "Saving…", read: "Read current permissions", saved: "Permissions updated.", unavailable: "This authorization can no longer be edited.", unknown: "The save result is unknown. Read the current permissions and review them.", conflict: "Permissions or the catalog changed. Read the current permissions and review them.", observed: "Current permissions are shown and your draft is preserved. Review before continuing.", review: "I reviewed the permissions", catalogError: "Unable to read the permissions catalog. Try again.", labels: "Permission descriptions have changed. Refresh this page.", empty: "Select at least one permission.", storage: "Unable to retain the pending recovery. Check browser storage.", fixed: "Fixed permissions; editing unavailable", current: "Current permissions", retry: "Retry catalog", resume: "Resume permission review",
  };
  const [initialMarker] = useState(() => readMarker(user.id));
  const panel = useCredentialPanel(user.id, transport.list, onIdentityMismatch, initialMarker.available && initialMarker.grantId === null, mergeScopedCredentialUses);
  const { items: grants, loading, pending, error } = panel;
  type ScopeDraft = { id: string; name: string; version: string; original: readonly string[]; selected: readonly string[]; review: boolean };
  const scopeMarkerKey = `daynight.oauthGrantScopeRecovery.${user.id}`;
  const scopeMarker = (value?: ScopeDraft | null): ScopeDraft | null => {
    if (value !== undefined) { if (value === null) sessionStorage.removeItem(scopeMarkerKey); else sessionStorage.setItem(scopeMarkerKey, JSON.stringify(value)); return value; }
    const raw = sessionStorage.getItem(scopeMarkerKey); if (raw === null) return null;
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object") throw new Error("Invalid scope recovery");
    const draft = data as Partial<ScopeDraft>;
    const validScopes = (items: unknown): items is string[] => Array.isArray(items) && items.every(id => typeof id === "string" && /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/.test(id)) && new Set(items).size === items.length;
    if (typeof draft.id !== "string" || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(draft.id) || typeof draft.name !== "string" || typeof draft.version !== "string" || !/^[1-9][0-9]*$/.test(draft.version) || BigInt(draft.version) > 9223372036854775807n || !validScopes(draft.original) || draft.original.length === 0 || !validScopes(draft.selected)) throw new Error("Invalid scope recovery");
    return { id: draft.id, name: draft.name, version: draft.version, original: draft.original, selected: draft.selected, review: false };
  };
  const [initialScopeMarker] = useState(() => { try { return { draft: scopeMarker(), error: false }; } catch { return { draft: null, error: true }; } });
  const [scopeRecovery, setScopeRecovery] = useState<{ id: string; kind: "unknown" | "conflict" } | null>(() => initialScopeMarker.draft === null ? null : { id: initialScopeMarker.draft.id, kind: "unknown" });
  const [scopeStorageError, setScopeStorageError] = useState(initialScopeMarker.error);
  const [catalog, setCatalog] = useState<ScopeCatalog | null>(null), [catalogError, setCatalogError] = useState(false), [catalogLoading, setCatalogLoading] = useState(true);
  const catalogLifetime = useRef<AbortController | null>(null), catalogRead = useRef<AbortController | null>(null);
  const catalogCallbacks = useRef({ transport, onIdentityMismatch }); catalogCallbacks.current = { transport, onIdentityMismatch };
  const loadCatalog = () => {
    const life = catalogLifetime.current; if (!life || life.signal.aborted) return;
    catalogRead.current?.abort(); const owner = new AbortController(); catalogRead.current = owner; setCatalogLoading(true); setCatalogError(false);
    const signal = AbortSignal.any([life.signal, owner.signal]);
    void catalogCallbacks.current.transport.catalog(user.id, signal, catalogCallbacks.current.onIdentityMismatch).then(result => {
      if (!signal.aborted && catalogRead.current === owner) { setCatalog(result.mcp); setCatalogError(false); }
    }).catch(failure => { if (!signal.aborted && !isAbortError(failure)) setCatalogError(true); }).finally(() => { if (!signal.aborted && catalogRead.current === owner) setCatalogLoading(false); });
  };
  const loadCatalogRef = useRef(loadCatalog); loadCatalogRef.current = loadCatalog;
  useEffect(() => { const life = new AbortController(); catalogLifetime.current = life; loadCatalogRef.current(); return () => { life.abort(); catalogRead.current?.abort(); }; }, [user.id, transport.catalog]);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [scopeDraft, setScopeDraft] = useState<ScopeDraft | null>(initialScopeMarker.draft), [scopeNotice, setScopeNotice] = useState<"saved" | "unavailable" | null>(null), [scopeError, setScopeError] = useState<unknown>(null);
  const scopeRevision = useRef(0);
  const resumeButton = useRef<HTMLButtonElement>(null), recoveryButton = useRef<HTMLButtonElement>(null), focusResume = useRef(false), focusAfterClose = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (focusResume.current && scopeDraft?.review && !scopeOpen && visible && resumeButton.current) {
      focusResume.current = false; resumeButton.current.focus();
    }
  }, [scopeDraft, scopeOpen, visible]);
  useLayoutEffect(() => {
    if (scopeOpen || !visible || focusAfterClose.current === null) return;
    const id = focusAfterClose.current;
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-scope-grant-edit]")).find(item => item.dataset.scopeGrantEdit === id && !item.disabled);
    const target = scopeRecovery !== null ? recoveryButton.current : button;
    if (target) { focusAfterClose.current = null; target.focus(); }
  }, [scopeOpen, scopeRecovery, visible, grants]);
  const scopePending = scopeRecovery !== null || scopeStorageError;
  const scopeClose = () => {
    if (pending || loading) return;
    if (scopeRecovery === null && scopeDraft?.review) {
      try { scopeMarker(null); setScopeStorageError(false); } catch { setScopeStorageError(true); return; }
    }
    focusAfterClose.current = scopeDraft?.id ?? null; ++scopeRevision.current; setScopeOpen(false); if (scopeRecovery === null) setScopeDraft(null); setScopeError(null);
  };
  const openScope = (grant: ScopedOwnerGrant) => {
    if (panel.busy() || scopePending || recovery !== null || error !== null || !grant.scopePolicy || grant.status !== "active" || scopeDraft?.review && scopeDraft.id !== grant.id) return;
    descriptions.close(); setSelected(null); ++scopeRevision.current; setScopeNotice(null); setScopeError(null);
    setScopeDraft(previous => previous?.id === grant.id ? previous : { id: grant.id, name: grant.clientName || grant.clientId, version: grant.scopePolicy!.scopeVersion, original: grant.scopePolicy!.scopes, selected: grant.scopePolicy!.scopes, review: false }); setScopeOpen(true);
  };
  const readScope = () => {
    if (scopeRecovery === null || panel.busy()) return;
    const target = scopeRecovery.id, instance = scopeRevision.current, previouslyObserved = grants, draftVersion = scopeDraft?.id === scopeRecovery.id ? scopeDraft.version : null;
    loadCatalog();
    void panel.read((items, raw) => {
      const incoming = raw.find(item => item.id === target), prior = previouslyObserved?.find(item => item.id === target);
      if (incoming?.scopePolicy && (prior?.scopePolicy && BigInt(incoming.scopePolicy.scopeVersion) < BigInt(prior.scopePolicy.scopeVersion) || draftVersion !== null && BigInt(incoming.scopePolicy.scopeVersion) < BigInt(draftVersion))) { setScopeError(new ApiError("protocol")); return; }
      const grant = mergeScopedCredentialUses(previouslyObserved, items).find(item => item.id === target);
      const draft = grant && grant.status === "active" && grant.scopePolicy !== null && scopeDraft?.id === target ? { ...scopeDraft, original: grant.scopePolicy.scopes, version: grant.scopePolicy.scopeVersion, review: true } : null;
      try { scopeMarker(draft); setScopeStorageError(false); } catch { setScopeStorageError(true); return; }
      setScopeRecovery(null); setScopeError(null);
      if (!grant || grant.status !== "active" || grant.scopePolicy === null) { if (scopeRevision.current === instance) { setScopeDraft(null); setScopeOpen(false); } setScopeNotice("unavailable"); return; }
      if (scopeRevision.current === instance && draft !== null) { if (!scopeOpen) focusResume.current = true; setScopeDraft(draft); }
    });
  };
  const retryScopeStorage = () => {
    try { const draft = scopeMarker(); setScopeStorageError(false); if (draft !== null) { setScopeDraft(before => before ?? draft); setScopeRecovery(before => before ?? { id: draft.id, kind: "unknown" }); } } catch { setScopeStorageError(true); }
  };
  const saveScope = async () => {
    const draft = scopeDraft, target = grants?.find(item => item.id === draft?.id);
    if (!draft || !target || target.status !== "active" || !target.scopePolicy || !catalog || catalogError || catalogLoading || !hasCredentialScopeLabels(catalog, locale) || draft.review || draft.selected.length === 0 || draft.selected.some(id => !draft.original.includes(id) && !catalog.groups.some(group => group.scopeIds.includes(id))) || scopePending || panel.busy()) return;
    if (draft.selected.length === draft.original.length && draft.selected.every(id => draft.original.includes(id))) return;
    try { scopeMarker(draft); setScopeStorageError(false); } catch { setScopeStorageError(true); return; }
    const instance = scopeRevision.current;
    await panel.write(async context => {
      setScopeError(null);
      try {
        const saved = await transport.updateScopes(draft.id, { expectedUserId: user.id, expectedScopeVersion: draft.version, catalogRevision: catalog.catalogRevision, scopes: draft.selected }, context.signal, onIdentityMismatch, () => { context.onDispatch(); setScopeRecovery({ id: draft.id, kind: "unknown" }); });
        await waitForAuthRequests(context.signal); if (!context.current()) return;
        try { scopeMarker(null); } catch { setScopeStorageError(true); setScopeRecovery({ id: draft.id, kind: "unknown" }); return; }
        setScopeRecovery(null);
        panel.setItems(items => items?.map(item => item.id === saved.id && saved.scopePolicy !== null && (item.scopePolicy === null || BigInt(item.scopePolicy.scopeVersion) <= BigInt(saved.scopePolicy.scopeVersion)) ? { ...item, scopePolicy: saved.scopePolicy } : item) ?? null);
        if (scopeRevision.current === instance) { setScopeDraft(null); setScopeOpen(false); }
        setScopeNotice("saved");
      } catch (failure) {
        try { await waitForAuthRequests(context.signal); } catch { return; }
        if (!context.current()) return;
        if (credentialWriteRefused(failure) && !(failure instanceof ApiError && (failure.status === 409 || failure.status === 404)) || !context.dispatched()) {
          try { scopeMarker(null); } catch { setScopeStorageError(true); setScopeRecovery({ id: draft.id, kind: "unknown" }); return; }
          setScopeRecovery(null); if (!isAbortError(failure)) setScopeError(failure);
        } else setScopeRecovery({ id: draft.id, kind: failure instanceof ApiError && (failure.status === 409 || failure.status === 404) ? "conflict" : "unknown" });
      }
    }, dispatched => { if (dispatched) setScopeRecovery({ id: draft.id, kind: "unknown" }); });
  };
  const [dialogError, setDialogError] = useState<unknown>(null), [selected, setSelected] = useState<ScopedOwnerGrant | null>(null);
  const [storageError, setStorageError] = useState(!initialMarker.available);
  const [recovery, setRecovery] = useState<Recovery | null>(() => initialMarker.grantId === null ? null : { grantId: initialMarker.grantId, name: initialMarker.grantId, kind: "unknown" });
  const [notice, setNotice] = useState<{ readonly name: string; readonly kind: "observed" | "saved" } | null>(null);
  const dialogRevision = useRef(0), priorVisible = useRef(visible);
  if (priorVisible.current !== visible) { priorVisible.current = visible; ++dialogRevision.current; }
  const heading = useRef<HTMLHeadingElement>(null), restoreFocus = useRef(false);
  const descriptions = useCredentialDescriptions({ panel, userId: user.id, mismatch: onIdentityMismatch, transport: transport.describe, visible, name: grant => grant.clientName || grant.clientId, onOpen: () => { ++dialogRevision.current; setSelected(null); } });
  const retained = pending || selected !== null || recovery !== null || descriptions.retained || scopeDraft !== null || scopePending;
  useLayoutEffect(() => { onRetentionChange?.(retained); }, [retained, onRetentionChange]);
  useLayoutEffect(() => { if (selected === null && restoreFocus.current && visible) { restoreFocus.current = false; heading.current?.focus(); } }, [selected, notice, scopeNotice, visible]);
  useEffect(() => {
    if (!scopeDraft?.review || scopeRecovery !== null || scopeStorageError || loading || grants === null) return;
    const target = grants.find(item => item.id === scopeDraft.id);
    if (target?.status === "active" && target.scopePolicy !== null) return;
    try { scopeMarker(null); } catch { setScopeStorageError(true); return; }
    ++scopeRevision.current; setScopeDraft(null); setScopeOpen(false); setScopeError(null); setScopeNotice("unavailable"); restoreFocus.current = true;
  }, [scopeDraft, scopeRecovery, scopeStorageError, loading, grants]);
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
  const revoke = async (grant: ScopedOwnerGrant) => {
    if (panel.busy() || recovery !== null || scopeDraft?.review || descriptions.unresolved(grant.id) || !grants?.some(item => item.id === grant.id && item.status === "active")) return;
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
  const blocked = loading || pending || recovery !== null || error !== null || storageError || scopePending;
  const uncertain = recovery?.kind === "unknown";
  return <>
    {descriptions.recovery}
    {scopeNotice !== null && <p className="notice" role="status">{copy[scopeNotice]}</p>}
    {scopeStorageError && <div className="notice error" role="alert"><p>{copy.storage}</p><button className="button" type="button" onClick={retryScopeStorage}>{copy.read}</button></div>}
    {scopeRecovery !== null && !scopeOpen && <div className="notice warning" role="alert"><p>{scopeRecovery.kind === "conflict" ? copy.conflict : copy.unknown}</p>{scopeError !== null && <ManagementError error={scopeError} />}<button className="button" type="button" ref={recoveryButton} disabled={loading || pending} onClick={readScope}>{copy.read}</button></div>}
    {scopeDraft?.review && !scopeOpen && <div className="notice warning" role="status"><p>{copy.observed} · {scopeDraft.name}</p><button className="button" type="button" ref={resumeButton} disabled={loading || pending || error !== null || scopeStorageError} aria-label={`${copy.resume}${locale === "zh-CN" ? "：" : ": "}${scopeDraft.name}`} onClick={() => { const grant = grants?.find(item => item.id === scopeDraft.id); if (grant) openScope(grant); }}>{copy.resume}</button></div>}
    <section className="panel" aria-labelledby="grants-title"><div className="panel-heading panel-heading-description"><div><h2 id="grants-title" ref={heading} tabIndex={-1}>{m.grantsTitle}</h2><p>{m.grantsDescription}</p></div><button className="button" type="button" disabled={loading || pending} aria-busy={loading} onClick={refresh}>{m.grantsRefresh}</button></div>
      {grants === null && loading && <div className="empty-inline" role="status">{m.grantsLoading}</div>}{error !== null && selected === null && <div className="grant-status-notice"><ManagementError error={error} retry={scopeRecovery !== null ? readScope : refresh} /></div>}{storageError && <div className="notice error grant-status-notice" role="alert">{m.grantStorage}</div>}
      {notice !== null && <p className="notice grant-status-notice" role="status"><strong>{notice.name}</strong> · {notice.kind === "observed" ? m.grantObserved : m.grantSaved}</p>}
      {grants !== null && (grants.length === 0 ? <div className="empty-inline">{m.grantsEmpty}</div> : grants.map(grant => {
        const name = grant.clientName || grant.clientId;
        return <div className={`row grant-row owner-grant-row${grant.status === "active" ? "" : " revoked"}`} key={grant.id}>
          <div className="grant-main"><div className="grant-meta-line"><div>{descriptions.label(grant)}</div><span className={`badge${grant.status === "active" ? "" : " warning"}`}>{grant.status === "active" ? m.grantActive : grant.status === "expired" ? m.grantExpired : m.grantRevoked}</span></div><div className="grant-origin">{m.grantClient}: {grant.clientId}</div><div className="grant-scope">{m.grantScope}: {grant.scope}</div>{grant.scopePolicy && <div className="grant-scope">{copy.current}: {grant.scopePolicy.scopes.join(", ")}</div>}</div>
          <div className="grant-facts"><p>{m.grantResource}: <strong>{grant.resource}</strong></p><p>{common.createdAt}: <DateLabel value={grant.createdAt} /></p><p>{common.expiresAt}: <DateLabel value={grant.expiresAt} /></p><CredentialLastUse value={grant.lastUsedAt} />{grant.revokedAt !== null && <p>{m.grantRevoked}: <DateLabel value={grant.revokedAt} /></p>}</div>
          <div className="actions">{grant.status === "active" && grant.scopePolicy !== null && <button className="button quiet" type="button" data-scope-grant-edit={grant.id} disabled={blocked || descriptions.unresolved(grant.id) || Boolean(scopeDraft?.review && scopeDraft.id !== grant.id)} aria-label={`${copy.edit}${locale === "zh-CN" ? "：" : ": "}${name}`} onClick={() => openScope(grant)}>{copy.edit}</button>}{grant.status === "active" && grant.scopePolicy === null && <span className="muted small">{copy.fixed}</span>}{grant.status === "active" ? <button className="button quiet" type="button" disabled={blocked || Boolean(scopeDraft?.review) || descriptions.unresolved(grant.id)} aria-label={m.grantRevoke({ name })} onClick={() => { descriptions.close(); ++dialogRevision.current; setSelected(grant); setDialogError(null); setNotice(null); }}>{common.revoke}</button> : <span className="muted small">{common.unusable}</span>}</div>
        </div>;
      }))}
      {recovery !== null && selected === null && <div className="notice warning grant-status-notice" role="alert"><p>{uncertain ? m.grantUnknown : m.grantReadCurrent} · {recovery.name}</p><button className="button" type="button" disabled={loading || pending} onClick={refresh}>{m.grantReadCurrent}</button></div>}
    </section><div className="notice">{m.grantsNotice}</div>{descriptions.editor}
    {scopeDraft !== null && scopeOpen && <ManagementDialog title={copy.edit} busy={pending || loading} suspended={!visible} preserveFocus onClose={scopeClose} footer={<><button className="button" type="button" disabled={pending || loading} onClick={scopeClose}>{common.cancel}</button>{scopeRecovery !== null ? <button className="button primary" type="button" disabled={loading || pending} onClick={readScope}>{copy.read}</button> : <button className="button primary" type="button" disabled={blocked || catalogLoading || catalogError || !catalog || !hasCredentialScopeLabels(catalog, locale) || scopeDraft.review || scopeDraft.selected.length === 0 || scopeDraft.selected.some(id => !scopeDraft.original.includes(id) && !catalog.groups.some(group => group.scopeIds.includes(id))) || scopeDraft.selected.length === scopeDraft.original.length && scopeDraft.selected.every(id => scopeDraft.original.includes(id))} onClick={() => { void saveScope(); }}>{pending ? copy.saving : copy.save}</button>}</>}>
      <p>{scopeDraft.name}</p>
      {catalog && <CredentialScopeEditor catalog={catalog} original={scopeDraft.original} selected={scopeDraft.selected} disabled={pending || scopeRecovery !== null} onChange={selected => {
        const draft = { ...scopeDraft, selected };
        if (scopeDraft.review) { try { scopeMarker(draft); setScopeStorageError(false); } catch { setScopeStorageError(true); return; } }
        setScopeDraft(draft);
      }} />}
      {scopeDraft.selected.length === 0 && <p className="notice warning" role="status">{copy.empty}</p>}
      {scopeRecovery !== null && <p className="notice warning" role="alert">{scopeRecovery.kind === "conflict" ? copy.conflict : copy.unknown}</p>}
      {scopeDraft.review && <div className="notice warning" role="status"><p>{copy.observed}</p><p>{copy.current}: {scopeDraft.original.join(", ")}</p><button className="button" type="button" disabled={catalogLoading || catalogError} onClick={() => {
        try { scopeMarker(null); setScopeStorageError(false); } catch { setScopeStorageError(true); return; }
        setScopeDraft(before => before === null ? null : { ...before, review: false });
      }}>{copy.review}</button></div>}
      {(catalogError || !catalog && !catalogLoading) && <div className="notice warning" role="alert"><p>{copy.catalogError}</p><button className="button" type="button" onClick={loadCatalog}>{copy.retry}</button></div>}
      {catalog && !hasCredentialScopeLabels(catalog, locale) && <p className="notice warning" role="alert">{copy.labels}</p>}
      {scopeStorageError && <div className="notice error" role="alert"><p>{copy.storage}</p><button className="button" type="button" onClick={retryScopeStorage}>{copy.read}</button></div>}{scopeError !== null && <ManagementError error={scopeError} />}{error !== null && <ManagementError error={error} retry={scopeRecovery !== null ? readScope : refresh} />}
    </ManagementDialog>}
    {selected !== null && <ManagementDialog title={m.grantRevokeTitle} busy={pending || loading} suspended={!visible} onClose={closeDialog} footer={<><button className="button" type="button" disabled={pending || loading} onClick={closeDialog}>{common.cancel}</button>{recovery !== null ? <button className="button primary" type="button" disabled={pending || loading} onClick={refresh}>{m.grantReadCurrent}</button> : <button className="button danger" type="button" disabled={loading || pending || recovery !== null || error !== null || !grants?.some(item => item.id === selected.id && item.status === "active")} onClick={() => { void revoke(selected); }}>{pending ? m.revoking : m.grantRevokeConfirm}</button>}</>}>
      <div className="grant-dialog-client"><strong>{selected.clientName || selected.clientId}</strong><p>{m.grantClient}: {selected.clientId}</p><p>{m.grantResource}: {selected.resource}</p><p>{m.grantScope}: {selected.scope}</p></div><p>{m.grantRevokeEffect}</p><div className="grant-dialog-account"><Identity user={user} /></div>
      {dialogError !== null && <ManagementError error={dialogError} />}{recovery !== null && <div className="notice warning" role="alert">{uncertain ? m.grantUnknown : m.grantReadCurrent}</div>}{error !== null && <ManagementError error={error} />}{storageError && <div className="notice error" role="alert">{m.grantStorage}</div>}
    </ManagementDialog>}
  </>;
};
