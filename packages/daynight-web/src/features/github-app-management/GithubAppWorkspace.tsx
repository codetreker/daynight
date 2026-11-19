import { GitHubAppAdministration, type GitHubAppAdminConfirmedResult, type GitHubAppAdminUnknownReview } from "../github-app-administration/GitHubAppAdministration";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { getProjectAccess } from '../../api/auth';
import { ImpactProjects } from '../github-app-impact/ImpactProjects';
import { verifyImpactProjects } from '../github-app-impact/verify-projects';
import { GitHubAppGrants, type GitHubAppGrantUnknownReview, type GitHubAppGrantPublicationError } from '../github-app-grants/GitHubAppGrants';
import { createGitHubApp, getGitHubApp, getGitHubAppRemovalImpact, listGitHubAppRemovalProjects, listGitHubApps, removeGitHubApp, updateGitHubApp, type GitHubApp, type GitHubAppImpact, type GitHubImpactProjectPage } from '../../api/github-app-management';
import { navigate } from '../../app/router';
import { useI18n } from '../../i18n/LocaleProvider';
import { CopyButton } from '../../ui/copy-button/CopyButton';
import { ManagementDialog } from '../management/ManagementDialog';
import type { TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { OperationPublicationError, useOperation } from '../teams/TeamManagement';
import { useTeamForeground } from '../teams/useTeamForeground';
import { appMessages } from './messages';
import './github-app-management.css';

type Props = { readonly appId: string | null; readonly section?: 'configuration' | 'admins' | 'teams'; readonly active: boolean; readonly admission: TaskCacheScope; readonly admissionBlocked: boolean; readonly onIdentityMismatch: () => void };
type Shared = Omit<Props, 'appId' | 'section'>;
type AccessState = { revision: number; denied: Set<string> };
type EditPurpose = 'name' | 'privateKey' | 'webhookSecret';
type AppPage = { readonly items: readonly GitHubApp[]; readonly nextCursor: string | null; readonly pages: number };
const denied = (error: unknown) => error instanceof ApiError && error.kind === 'server' && (error.status === 403 || error.status === 404);
const conflict = (error: unknown) => error instanceof ApiError && error.kind === 'server' && error.status === 409;
// These GitHub failures occur during credential proof, before the transaction.
const proofRefused = (error: unknown) => error instanceof ApiError && error.kind === 'server' && error.status === 502 && (error.code === 'github_rate_limited' || error.code === 'github_unavailable');
class ProjectVisibilityChanged extends Error {}
const validName = (s: string) => s.isWellFormed() && !s.includes('\0') && /[^\p{White_Space}]/u.test(s) && [...s].length <= 256 && new TextEncoder().encode(s).length <= 1024;
const validCredential = (s: string, maxBytes: number) => s.isWellFormed() && s.length > 0 && new TextEncoder().encode(s).length <= maxBytes;
const validAppId = (s: string) => /^[1-9][0-9]*$/.test(s) && s.length <= 19 && BigInt(s) <= 9223372036854775807n;
const auth = (admission: TaskCacheScope, mismatch: () => void, dispatched?: () => void) => ({ userId: admission.userId, onPrincipalMismatch: mismatch, ...(dispatched ? { onDispatch: dispatched } : {}) });

// Identity changes discard every retained owner, including drafts and pending presentation.
export const GithubAppWorkspace = (props: Props) => {
  const owner = useRef({ admission: props.admission, revision: 0 });
  if (owner.current.admission !== props.admission) owner.current = { admission: props.admission, revision: owner.current.revision + 1 };
  return <Workspace key={owner.current.revision} {...props} />;
};

const Workspace = ({ appId, section = 'configuration', active, ...shared }: Props) => {
  const owners = useRef<string[]>([]), access = useRef<AccessState>({ revision: 0, denied: new Set() });
  const [grantReviews, setGrantReviews] = useState<ReadonlyMap<string, GitHubAppGrantUnknownReview>>(() => new Map());
  const [grantPublications, setGrantPublications] = useState<ReadonlyMap<string, GitHubAppGrantPublicationError>>(() => new Map());
  const [grantVisibility, setGrantVisibility] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [grantResults, setGrantResults] = useState<readonly { id: string; result: 'granted' | 'revoked'; sequence: number }[]>([]);
  const [adminReviews, setAdminReviews] = useState<ReadonlyMap<string, GitHubAppAdminUnknownReview>>(() => new Map());
  const [adminResults, setAdminResults] = useState<readonly { id: string; result: GitHubAppAdminConfirmedResult; sequence: number }[]>([]);
  const resultSequence = useRef(0);
  const onGrantPublication = useCallback((id: string, error: GitHubAppGrantPublicationError | null) => setGrantPublications(previous => { if (error === null && !previous.has(id)) return previous; const next = new Map(previous); if (error === null) next.delete(id); else next.set(id, error); return next; }), []);
  const onGrantVisibility = useCallback((id: string, visible: boolean) => setGrantVisibility(previous => { if ((previous.get(id) ?? false) === visible) return previous; const next = new Map(previous); next.set(id, visible); return next; }), []);
  const onGrantResult = useCallback((id: string, result: 'granted' | 'revoked') => { const sequence = ++resultSequence.current; setGrantResults(previous => [...previous, { id, result, sequence }]); }, []);
  const onGrantReview = useCallback((id: string, review: GitHubAppGrantUnknownReview | null) => setGrantReviews(previous => { if (review === null && !previous.has(id)) return previous; const next = new Map(previous); if (review === null) next.delete(id); else next.set(id, review); return next; }), []);
  const onAdminResult = useCallback((id: string, result: GitHubAppAdminConfirmedResult) => { const sequence = ++resultSequence.current; setAdminResults(previous => [...previous, { id, result, sequence }]); }, []);
  const onAdminReview = useCallback((id: string, review: GitHubAppAdminUnknownReview | null) => setAdminReviews(previous => { if (review === null && !previous.has(id)) return previous; const next = new Map(previous); if (review === null) next.delete(id); else next.set(id, review); return next; }), []);
  const [, refreshAccess] = useState(0), [result, setResult] = useState<'nameSaved' | 'privateKeySaved' | 'webhookSecretSaved' | 'removed' | 'left' | null>(null);
  const { locale } = useI18n();
  const onUnavailable = useCallback((id: string) => { access.current.denied.add(id); access.current.revision++; refreshAccess(value => value + 1); }, []);
  const onListRead = useCallback((revision: number) => { if (access.current.revision !== revision) return false; access.current.denied.clear(); return true; }, []);
  if (appId !== null && !owners.current.includes(appId)) owners.current.push(appId);
  return <div className="github-app-workspace">
    {[...grantPublications].filter(([id, error]) => error.unavailable || !(active && appId === id && section === 'teams' && !access.current.denied.has(id))).map(([id, error]) => <div className="notice error" role="alert" key={id}><p>{locale === 'zh-CN' ? 'App 资源 ID' : 'App resource ID'}: <code>{id}</code></p><p>{error.confirmed ? (locale === 'zh-CN' ? '操作已成功，但无法显示其结果。' : 'The operation succeeded, but its result could not be displayed.') : (locale === 'zh-CN' ? '无法显示操作结果。' : "The operation's result could not be displayed.")}</p>{error.retry && <button className="button" type="button" onClick={error.retry}>{locale === 'zh-CN' ? '重试显示结果' : 'Retry showing result'}</button>}</div>)}
    {grantResults.filter(item => !(active && appId === item.id && section === 'teams' && grantVisibility.get(item.id) && !access.current.denied.has(item.id) && grantResults.filter(result => result.id === item.id).at(-1)?.sequence === item.sequence)).map(item => <div className="notice" role="status" key={item.sequence}><p>{locale === 'zh-CN' ? 'App 资源 ID' : 'App resource ID'}: <code>{item.id}</code></p><p>{item.result === 'granted' ? (locale === 'zh-CN' ? 'Team 已获 App 使用权。' : 'Team access granted.') : (locale === 'zh-CN' ? 'Team 使用授权已撤销，相关连接已停止。已有 PR 保留。' : 'Team access revoked and affected connections stopped. Existing PRs are retained.')}</p><button className="button" type="button" onClick={() => setGrantResults(previous => previous.filter(result => result.sequence !== item.sequence))}>{locale === 'zh-CN' ? '关闭' : 'Dismiss'}</button></div>)}
    {[...grantReviews].filter(([id, review]) => review.state === 'app-unavailable' || !(active && appId === id && section === 'teams' && !access.current.denied.has(id))).map(([id, review]) => <div className="notice warning" role="alert" key={id}><p>{locale === 'zh-CN' ? 'App 资源 ID' : 'App resource ID'}: <code>{id}</code></p><p>{locale === 'zh-CN' ? 'Team 授权操作结果未知。当前状态不能证明原操作的结果。' : 'The Team access operation outcome is unknown. Current state cannot establish the original result.'}</p>{review.state === 'app-unavailable' ? <p>{locale === 'zh-CN' ? '此 App 当前不可访问。' : 'This App is currently unavailable.'}</p> : <button className="button" type="button" onClick={() => navigate(`/github-apps/${id}/teams`)}>{locale === 'zh-CN' ? '核对当前状态' : 'Check current state'}</button>}{review.finish && <button className="button" type="button" onClick={review.finish}>{locale === 'zh-CN' ? '结束核对' : 'Finish review'}</button>}</div>)}
    {adminResults.map(item => <div className="notice" role="status" key={item.sequence}><p>{locale === 'zh-CN' ? 'App 资源 ID' : 'App resource ID'}: <code>{item.id}</code></p><p>{item.result === 'invite' ? (locale === 'zh-CN' ? '邀请已创建，但链接无法在此显示。' : 'Invitation created, but its link cannot be shown here.') : item.result === 'remove' ? (locale === 'zh-CN' ? '管理员已移除。' : 'Administrator removed.') : (locale === 'zh-CN' ? '邀请已撤销。' : 'Invitation revoked.')}</p><button className="button" type="button" onClick={() => setAdminResults(previous => previous.filter(result => result.sequence !== item.sequence))}>{locale === 'zh-CN' ? '关闭' : 'Dismiss'}</button></div>)}
    {[...adminReviews].filter(([id, review]) => review.state === 'app-unavailable' || !(active && appId === id && section === 'admins' && !access.current.denied.has(id))).map(([id, review]) => <div className="notice warning" role="alert" key={id}><p>{locale === 'zh-CN' ? 'App 资源 ID' : 'App resource ID'}: <code>{id}</code></p><p>{locale === 'zh-CN' ? '管理员操作结果未知。当前状态不能证明原操作的结果。' : 'The administrator operation outcome is unknown. Current state cannot establish the original result.'}</p>{review.state === 'app-unavailable' ? <p>{locale === 'zh-CN' ? '此 App 当前不可访问。' : 'This App is currently unavailable.'}</p> : <button className="button" type="button" onClick={() => navigate(`/github-apps/${id}/admins`)}>{locale === 'zh-CN' ? '核对当前状态' : 'Check current state'}</button>}{review.finish && <button className="button" type="button" onClick={review.finish}>{locale === 'zh-CN' ? '结束核对' : 'Finish review'}</button>}</div>)}
    {result && <p role="status">{result === 'left' ? (locale === 'zh-CN' ? '已移除你的 App 管理员身份。' : 'Your App administrator access was removed.') : appMessages(locale === 'zh-CN')[result]}</p>}
    <div hidden={!active || appId !== null} inert={!active || appId !== null}><AppList {...shared} active={active && appId === null} access={access} onListRead={onListRead} /></div>
    {owners.current.map(id => <div key={id} hidden={!active || appId !== id} inert={!active || appId !== id}><AppDetail {...shared} id={id} section={section} active={active && appId === id} onUnavailable={onUnavailable} onDeleted={() => setResult('removed')} onSaved={purpose => setResult(purpose === 'name' ? 'nameSaved' : purpose === 'privateKey' ? 'privateKeySaved' : 'webhookSecretSaved')} onLeft={() => setResult('left')} onAdminReview={onAdminReview} onAdminResult={onAdminResult} onGrantReview={onGrantReview} onGrantPublication={onGrantPublication} onGrantResult={onGrantResult} onGrantVisibility={onGrantVisibility} grantReceipt={(() => { const receipt = grantResults.filter(result => result.id === id).at(-1); return receipt ? { result: receipt.result, dismiss: () => setGrantResults(previous => previous.filter(result => result.sequence !== receipt.sequence)) } : null; })()} /></div>)}
  </div>;
};

const AppList = ({ active, admission, admissionBlocked, onIdentityMismatch, access, onListRead }: Shared & { readonly access: React.RefObject<AccessState>; readonly onListRead: (revision: number) => boolean }) => {
  const { locale } = useI18n(), zh = locale === 'zh-CN', m = appMessages(zh);
  const [page, setPage] = useState<AppPage | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState<unknown>(null);
  const current = useRef<AppPage | null>(null), read = useRef<AbortController | null>(null), op = useOperation(admission);
  const [open, setOpen] = useState(false), [name, setName] = useState(''), [githubAppId, setGithubAppId] = useState(''), [key, setKey] = useState(''), [secret, setSecret] = useState(''), [invalid, setInvalid] = useState(false), [observed, setObserved] = useState<GitHubApp | null>(null), [checked, setChecked] = useState(false), [created, setCreated] = useState(false);
  const target = useRef<string | null>(null), checkRead = useRef<AbortController | null>(null), checkRevision = useRef(0), activeRef = useRef(active), entryVerified = useRef(false); activeRef.current = active;
  const load = useCallback(async (more: boolean) => {
    if (!active || admissionBlocked || admission.isInvalidated) return;
    const prior = current.current;
    if (more && (!prior || prior.nextCursor === null)) return;
    read.current?.abort(); const controller = new AbortController(); read.current = controller;
    const signal = AbortSignal.any([controller.signal, admission.signal]), revision = access.current.revision;
    if (more || !prior || !entryVerified.current) setLoading(true);
    try {
      let items: readonly GitHubApp[] = [], cursor: string | null = null, pages = 0;
      const limit = more ? prior!.pages + 1 : Math.max(1, prior?.pages ?? 1);
      do {
        await admission.ready(signal); const result = await listGitHubApps(cursor, signal, auth(admission, onIdentityMismatch)); await admission.ready(signal);
        if (signal.aborted || admission.isInvalidated) return;
        items = [...items, ...result.items];
        if (new Set(items.map(item => item.id)).size !== items.length || result.nextCursor !== null && result.nextCursor === cursor) throw new ApiError('protocol');
        cursor = result.nextCursor; pages++;
      } while (pages < limit && cursor !== null);
      if (!onListRead(revision)) return;
      entryVerified.current = true; current.current = { items, nextCursor: cursor, pages }; setPage(current.current); setError(null);
    } catch (failure) { if (!signal.aborted && !admission.isInvalidated) { try { await admission.ready(signal); } catch { return; } if (!signal.aborted && !admission.isInvalidated) setError(failure); } }
    finally { if (read.current === controller) { read.current = null; if (!signal.aborted && !admission.isInvalidated) setLoading(false); } }
  }, [active, admissionBlocked, admission, onIdentityMismatch, access, onListRead]);
  useEffect(() => { if (!active || admissionBlocked) return; void load(false); return () => { read.current?.abort(); read.current = null; }; }, [active, admissionBlocked, load]);
  useTeamForeground(active && !admissionBlocked, () => { void load(false); });
  useEffect(() => () => { checkRevision.current++; checkRead.current?.abort(); }, []);
  const cancelCheck = () => { checkRevision.current++; checkRead.current?.abort(); checkRead.current = null; };
  const clearDraft = () => { setName(''); setGithubAppId(''); setKey(''); setSecret(''); setInvalid(false); };
  const close = () => { cancelCheck(); setOpen(false); clearDraft(); if (op.result?.kind !== 'unknown') { op.clear(); target.current = null; setObserved(null); setChecked(false); } };
  const start = () => { if (op.guarded() || admissionBlocked) return; cancelCheck(); op.clear(); target.current = crypto.randomUUID(); clearDraft(); setObserved(null); setChecked(false); setCreated(false); setOpen(true); };
  const submit = (event: FormEvent) => {
    event.preventDefault(); if (!active || admissionBlocked || op.guarded() || !target.current) return;
    if (!validName(name) || !validAppId(githubAppId) || !key || !secret) { setInvalid(true); return; }
    const id = target.current;
    void op.run((signal, dispatched) => createGitHubApp({ id, name, githubAppId, privateKeyPem: key, webhookSecret: secret }, signal, auth(admission, onIdentityMismatch, dispatched)), value => {
      clearDraft(); setCreated(true); setOpen(false); setObserved(value); current.current = null;
      if (activeRef.current) navigate(`/github-apps/${value.id}`);
    }, undefined, proofRefused);
  };
  const check = () => { if (!target.current || admissionBlocked) return; cancelCheck(); const id = target.current, revision = checkRevision.current, controller = new AbortController(); checkRead.current = controller; const signal = AbortSignal.any([controller.signal, admission.signal]); const currentCheck = () => !signal.aborted && !admission.isInvalidated && target.current === id && checkRevision.current === revision; void (async () => { try { await admission.ready(signal); const value = await getGitHubApp(id, signal, auth(admission, onIdentityMismatch)); await admission.ready(signal); if (currentCheck()) { setObserved(value); setChecked(true); } } catch (failure) { if (currentCheck()) { if (denied(failure)) { setObserved(null); setChecked(true); } else setError(failure); } } finally { if (checkRead.current === controller) checkRead.current = null; } })(); };
  const unknown = op.result?.kind === 'unknown';
  const visibleItems = page?.items.filter(item => !access.current.denied.has(item.id)) ?? [];
  return <>
    <div className="page-heading"><div><div className="eyebrow">INTEGRATIONS</div><h1>{m.title}</h1><p>{m.subtitle}</p></div><button className="button primary" type="button" aria-disabled={admissionBlocked || op.guarded()} onClick={start}>{m.create}</button></div>
    {error !== null && <div className="notice error" role="alert">{m.failed} <button type="button" className="button" onClick={() => void load(false)}>{m.retry}</button></div>}
    {created && <p role="status">{m.created}</p>}
    {unknown && !open && <div className="notice warning" role="alert">{m.unknown} <button type="button" className="button" onClick={() => setOpen(true)}>{m.check}</button></div>}
    <section className="panel github-app-list-panel"><header className="panel-heading"><h2>{m.list}</h2></header>
      {(!page || !entryVerified.current) && loading && <p className="empty-inline" role="status">{m.loading}</p>}
      {page && entryVerified.current && (visibleItems.length === 0 ? <div className="empty-inline"><strong>{m.empty}</strong><p>{m.emptyHint}</p></div> : <ul className="github-app-list">{visibleItems.map(app => <li key={app.id}><div><h3>{app.name}</h3><p>App ID {app.githubAppId} · {app.githubSlug}</p><div className="github-app-summary"><span>{app.administrators} {m.administrators}</span><span>{app.authorizedTeams} {m.teams}</span></div></div><button className="button" type="button" onClick={() => navigate(`/github-apps/${app.id}`)}>{m.manage}</button></li>)}</ul>)}
      {entryVerified.current && page?.nextCursor && <div className="github-app-more"><button type="button" className="button" aria-disabled={loading || admissionBlocked} onClick={() => { if (!loading && !admissionBlocked) void load(true); }}>{m.more}</button></div>}
    </section>
    {open && <ManagementDialog typography preserveFocus title={m.create} busy={op.pending} suspended={!active || !entryVerified.current} onClose={close} footer={<><button className="button" type="button" disabled={op.pending} onClick={close}>{unknown ? m.close : m.cancel}</button>{unknown ? <button className="button" type="button" onClick={check} aria-disabled={admissionBlocked}>{m.check}</button> : <button className="button primary" type="submit" form="github-app-create" disabled={op.pending || op.publicationPending} aria-disabled={admissionBlocked}>{op.pending ? m.submitting : m.register}</button>}</>}>
      <p>{m.registerHint}</p><form id="github-app-create" className="github-app-modal-form" onSubmit={submit}>
        <div className="field"><label htmlFor="github-app-id">App ID</label><input id="github-app-id" inputMode="numeric" value={githubAppId} disabled={op.pending || unknown} onChange={e => setGithubAppId(e.target.value)} /></div>
        <div className="field"><label htmlFor="github-app-name">{m.name}</label><input id="github-app-name" value={name} disabled={op.pending || unknown} onChange={e => setName(e.target.value)} /></div>
        <div className="field"><label htmlFor="github-app-key">{m.privateKey}</label><textarea id="github-app-key" value={key} disabled={op.pending || unknown} onChange={e => setKey(e.target.value)} /></div>
        <div className="field"><label htmlFor="github-app-secret">Webhook secret</label><input id="github-app-secret" type="password" autoComplete="off" value={secret} disabled={op.pending || unknown} onChange={e => setSecret(e.target.value)} /></div><p>{m.webhookCreate}</p>
      </form>
      {invalid && <div className="notice error" role="alert">{m.invalid}</div>}{op.result && <div className="notice error" role="alert">{unknown ? m.unknown : op.result.error instanceof ApiError && op.result.error.code === 'github_app_already_registered' ? m.duplicate : m.rejected}</div>}
      {checked && <><p role="status">{m.checked}{observed && <> <strong>{observed.name}</strong> · {observed.githubAppId}</>}</p><button className="button" type="button" onClick={() => { cancelCheck(); op.clear(); target.current = null; setOpen(false); clearDraft(); setChecked(false); }}>{m.dismiss}</button></>}<OperationPublicationError operation={op} zh={zh} />
    </ManagementDialog>}
  </>;
};

type DetailProps = Shared & { readonly section: 'configuration' | 'admins' | 'teams'; readonly onLeft: () => void; readonly onAdminReview: (id: string, review: GitHubAppAdminUnknownReview | null) => void; readonly onAdminResult: (id: string, result: GitHubAppAdminConfirmedResult) => void; readonly onGrantReview: (id: string, review: GitHubAppGrantUnknownReview | null) => void; readonly onGrantPublication: (id: string, error: GitHubAppGrantPublicationError | null) => void; readonly onGrantResult: (id: string, result: 'granted' | 'revoked') => void; readonly onGrantVisibility: (id: string, visible: boolean) => void; readonly grantReceipt: { readonly result: 'granted' | 'revoked'; readonly dismiss: () => void } | null; readonly id: string; readonly onUnavailable: (id: string) => void; readonly onDeleted: () => void; readonly onSaved: (purpose: EditPurpose) => void };
const AppDetail = ({ id, section, active, admission, admissionBlocked, onIdentityMismatch, onUnavailable, onDeleted, onSaved, onLeft, onAdminReview, onAdminResult, onGrantReview, onGrantPublication, onGrantResult, onGrantVisibility, grantReceipt }: DetailProps) => {
  const { locale } = useI18n(), zh = locale === 'zh-CN', m = appMessages(zh);
  const [app, setApp] = useState<GitHubApp | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState<unknown>(null), [unavailable, setUnavailable] = useState(false), [notice, setNotice] = useState('');
  const [modal, setModal] = useState<EditPurpose | 'delete' | null>(null), [name, setName] = useState(''), [key, setKey] = useState(''), [secret, setSecret] = useState(''), [invalid, setInvalid] = useState(false), [changed, setChanged] = useState(false), [checked, setChecked] = useState(false);
  const [impact, setImpact] = useState<GitHubAppImpact | null>(null), [projects, setProjects] = useState<GitHubImpactProjectPage | null>(null), [impactError, setImpactError] = useState<unknown>(null), [impactLoading, setImpactLoading] = useState(false);
  const adminsOpened = useRef(false), grantsOpened = useRef(false), grantVisible = useRef(false); if (section === 'admins') adminsOpened.current = true; if (section === 'teams') grantsOpened.current = true;
  const current = useRef<GitHubApp | null>(null), read = useRef<AbortController | null>(null), impactRead = useRef<AbortController | null>(null), impactReadGeneration = useRef(0), epoch = useRef(0), accessEpoch = useRef(0), projectCursor = useRef<string | null>(null), impactPages = useRef(0), impactFresh = useRef(false), projectsFresh = useRef(false), deniedRef = useRef(false), entryVerified = useRef(false), fresh = useRef(false), activeRef = useRef(active), op = useOperation(admission);
  activeRef.current = active; grantVisible.current = active && section === 'teams' && entryVerified.current && !unavailable;
  const grantIsVisible = grantVisible.current;
  useLayoutEffect(() => { onGrantVisibility(id, grantIsVisible); }, [id, grantIsVisible, onGrantVisibility]);
  if (!active || admissionBlocked) { fresh.current = false; impactFresh.current = false; }
  const loseAccess = () => { grantVisible.current = false; onUnavailable(id); deniedRef.current = true; epoch.current++; impactReadGeneration.current++; accessEpoch.current++; read.current?.abort(); read.current = null; setLoading(false); fresh.current = false; current.current = null; setApp(null); setUnavailable(true); setModal(null); setName(''); setKey(''); setSecret(''); setImpact(null); setProjects(null); impactRead.current?.abort(); };
  const load = useCallback(async () => {
    if (!active || admissionBlocked || admission.isInvalidated) return null;
    fresh.current = false; read.current?.abort(); const controller = new AbortController(); read.current = controller;
    const signal = AbortSignal.any([controller.signal, admission.signal]), revision = accessEpoch.current; if (!current.current || !entryVerified.current) setLoading(true);
    try {
      await admission.ready(signal); const value = await getGitHubApp(id, signal, auth(admission, onIdentityMismatch)); await admission.ready(signal);
      if (signal.aborted || admission.isInvalidated || accessEpoch.current !== revision) return null;
      const prior = current.current;
      if (prior && BigInt(prior.version) > BigInt(value.version)) { entryVerified.current = true; fresh.current = true; setApp({ ...prior }); return prior; }
      if (prior && prior.version !== value.version) setChanged(true);
      entryVerified.current = true; deniedRef.current = false; current.current = value; setApp(value); setUnavailable(false); setError(null); fresh.current = true; return value;
    } catch (failure) {
      if (!signal.aborted && !admission.isInvalidated && accessEpoch.current === revision) { try { await admission.ready(signal); } catch { return null; } if (!signal.aborted && !admission.isInvalidated && accessEpoch.current === revision) { if (denied(failure)) loseAccess(); setError(failure); } }
      return null;
    } finally { if (read.current === controller) { read.current = null; if (!signal.aborted && !admission.isInvalidated) setLoading(false); } }
  }, [active, admissionBlocked, admission, id, onIdentityMismatch, onUnavailable]);
  useEffect(() => { if (!active || admissionBlocked) return; void load(); return () => { read.current?.abort(); read.current = null; impactRead.current?.abort(); setImpactLoading(false); }; }, [active, admissionBlocked, load]);
  useTeamForeground(active && !admissionBlocked, () => { void load(); if (modal === 'delete') void refreshImpact(); });
  const loadImpact = async (more = false) => {
    if (!active || admissionBlocked || unavailable || more && (!impact || !impact.nextCursor)) return false;
    impactRead.current?.abort(); const controller = new AbortController(); impactRead.current = controller; impactReadGeneration.current++;
    const signal = AbortSignal.any([controller.signal, admission.signal]), revision = epoch.current;
    impactFresh.current = false; setImpactLoading(true); setImpactError(null);
    try {
      let cursor = more ? impact!.nextCursor : null;
      let rows = more ? [...impact!.teams] : [], pages = more ? impactPages.current : 0;
      const target = more ? pages + 1 : Math.max(1, impactPages.current);
      let value: GitHubAppImpact | null = more ? impact : null;
      do {
        await admission.ready(signal); const page = await getGitHubAppRemovalImpact(id, cursor, signal, auth(admission, onIdentityMismatch)); await admission.ready(signal);
        if (signal.aborted || admission.isInvalidated || epoch.current !== revision) return false;
        if (projects && (projects.hiddenProjects !== page.hiddenProjects || impact && (impact.version !== page.version || impact.impactVersion !== page.impactVersion))) { projectsFresh.current = false; setProjects(null); projectCursor.current = null; }
        if (value && (value.version !== page.version || value.impactVersion !== page.impactVersion)) throw new ApiError('protocol');
        if (page.nextCursor !== null && page.nextCursor === cursor) throw new ApiError('protocol');
        rows = [...rows, ...page.teams]; if (new Set(rows.map(row => row.team.id)).size !== rows.length) throw new ApiError('protocol');
        cursor = page.nextCursor; pages++; value = page;
      } while (pages < target && cursor !== null);
      if (impact && (impact.version !== value!.version || impact.impactVersion !== value!.impactVersion)) { setProjects(null); projectsFresh.current = false; projectCursor.current = null; setChanged(true); }
      else if (projects && projects.hiddenProjects !== value!.hiddenProjects) { setProjects(null); projectsFresh.current = false; projectCursor.current = null; }
      impactPages.current = pages; impactFresh.current = true; setImpact({ ...value!, teams: rows }); return true;
    } catch (failure) { if (!signal.aborted && !admission.isInvalidated && epoch.current === revision) { if (denied(failure)) loseAccess(); else if (conflict(failure)) { setImpact(null); setProjects(null); setChanged(true); } setImpactError(failure); } return false; }
    finally { if (impactRead.current === controller) { impactRead.current = null; if (!signal.aborted && !admission.isInvalidated && epoch.current === revision) setImpactLoading(false); } }
  };
  const loadProjects = async (more = false) => {
    if (!active || admissionBlocked || !impact || !impactFresh.current || more && (!projects || !projects.nextCursor)) return;
    impactRead.current?.abort(); const controller = new AbortController(); impactRead.current = controller; const generation = ++impactReadGeneration.current;
    const signal = AbortSignal.any([controller.signal, admission.signal]), revision = epoch.current;
    setImpactLoading(true); setImpactError(null);
    try {
      const cursor = more ? projects!.nextCursor : projectCursor.current;
      await admission.ready(signal);
      const value = await listGitHubAppRemovalProjects(id, cursor, signal, auth(admission, onIdentityMismatch));
      await verifyImpactProjects(value.items, { signal, ready: next => admission.ready(next), read: (projectId, next) => getProjectAccess(projectId, next, auth(admission, onIdentityMismatch)), isDenied: denied, isCurrent: () => !admission.isInvalidated && epoch.current === revision && generation === impactReadGeneration.current, onDenied: () => { projectsFresh.current = false; setProjects(null); projectCursor.current = null; }, mapDenied: () => new ProjectVisibilityChanged() });
      const checkedImpact = await getGitHubAppRemovalImpact(id, null, signal, auth(admission, onIdentityMismatch)); await admission.ready(signal);
      if (signal.aborted || admission.isInvalidated || epoch.current !== revision) return;
      if (value.nextCursor !== null && value.nextCursor === cursor) throw new ApiError('protocol');
      if (value.hiddenProjects !== checkedImpact.hiddenProjects) throw new ProjectVisibilityChanged();
      if (checkedImpact.version !== impact.version || checkedImpact.impactVersion !== impact.impactVersion) { setImpact(null); setProjects(null); projectCursor.current = null; setChanged(true); return; }
      projectCursor.current = cursor; projectsFresh.current = true; setProjects(value);
    } catch (failure) { if (!signal.aborted && !admission.isInvalidated && epoch.current === revision) { if (failure instanceof ProjectVisibilityChanged || denied(failure) || conflict(failure)) { projectsFresh.current = false; setProjects(null); projectCursor.current = null; } if (denied(failure)) loseAccess(); else if (conflict(failure)) { setImpact(null); setChanged(true); } setImpactError(failure); } }
    finally { if (impactRead.current === controller) { impactRead.current = null; if (!signal.aborted && !admission.isInvalidated && epoch.current === revision) setImpactLoading(false); } }
  };
  const refreshImpact = async () => { const revision = epoch.current; if (await loadImpact() && epoch.current === revision && projects) await loadProjects(); };
  useEffect(() => { if (active && !admissionBlocked && modal === 'delete' && !op.pending && !op.result) void refreshImpact(); }, [active, admissionBlocked]);
  const close = () => { epoch.current++; impactReadGeneration.current++; impactRead.current?.abort(); setImpactLoading(false); setModal(null); setName(''); setKey(''); setSecret(''); setImpact(null); setProjects(null); impactPages.current = 0; projectCursor.current = null; impactFresh.current = false; projectsFresh.current = false; setInvalid(false); if (op.result?.kind !== 'unknown') { op.clear(); setChecked(false); } };
  const edit = (purpose: EditPurpose) => { if (!app || !fresh.current || admissionBlocked || op.guarded() || op.publishing()) return; op.clear(); setChanged(false); setInvalid(false); setName(purpose === 'name' ? app.name : ''); setKey(''); setSecret(''); setNotice(''); setModal(purpose); };
  const openDelete = () => { if (!app || !fresh.current || op.guarded() || op.publishing() || admissionBlocked) return; op.clear(); setChanged(false); setNotice(''); setModal('delete'); void loadImpact(); };
  const save = (event: FormEvent) => {
    event.preventDefault(); if (!active || admissionBlocked || !app || !fresh.current || op.guarded() || op.publishing() || changed || !modal || modal === 'delete') return;
    if (modal === 'name' ? !validName(name) || name === app.name : modal === 'privateKey' ? !validCredential(key, 65536) : !validCredential(secret, 4096)) { setInvalid(true); return; }
    const revision = epoch.current, accessRevision = accessEpoch.current, purpose = modal;
    const input = { version: app.version, ...(purpose === 'name' ? { name } : purpose === 'privateKey' ? { privateKeyPem: key } : { webhookSecret: secret }) };
    void op.run((signal, dispatched) => updateGitHubApp(id, input, signal, auth(admission, onIdentityMismatch, dispatched)), value => {
      if (accessRevision !== accessEpoch.current) return; onSaved(purpose);
      if (current.current && BigInt(current.current.version) <= BigInt(value.version)) { current.current = value; setApp(value); }
      if (revision !== epoch.current) return; setModal(null); setName(''); setKey(''); setSecret('');
    }, failure => { if (revision !== epoch.current) return; if (denied(failure)) loseAccess(); else if (conflict(failure)) { setChanged(true); fresh.current = false; } }, proofRefused);
  };
  const remove = () => {
    if (!active || admissionBlocked || !app || !impact || impact.nextCursor !== null || !fresh.current || !impactFresh.current || op.guarded() || op.publishing() || changed) return;
    const revision = epoch.current;
    void op.run((signal, dispatched) => removeGitHubApp(id, { version: impact.version, impactVersion: impact.impactVersion }, signal, auth(admission, onIdentityMismatch, dispatched)), () => {
      onDeleted(); onUnavailable(id); if (revision !== epoch.current) return; setModal(null); setName(''); setKey(''); setSecret(''); current.current = null; setApp(null); if (activeRef.current) navigate('/github-apps');
    }, failure => { if (revision !== epoch.current) return; if (denied(failure)) loseAccess(); else if (conflict(failure)) { setChanged(true); setImpact(null); setProjects(null); fresh.current = false; } });
  };
  const review = () => { void (async () => { const next = await load(); if (next || deniedRef.current) { setChecked(true); if (next && op.result?.kind !== 'unknown') { op.clear(); setChanged(false); if (modal === 'delete') void refreshImpact(); } } })(); };
  const unknown = op.result?.kind === 'unknown';
  const [copyStatus, setCopyStatus] = useState('');
  const copy = () => { if (!app || !active || admissionBlocked) return; const revision = epoch.current; void navigator.clipboard.writeText(app.webhookUrl).then(() => { if (revision === epoch.current && activeRef.current && !admission.isInvalidated) setCopyStatus(m.copied); }, () => { if (revision === epoch.current && activeRef.current && !admission.isInvalidated) setCopyStatus(m.copyFailed); }); };
  return <>
    <button className="button" type="button" onClick={() => navigate('/github-apps')}>← {m.back}</button>
    {loading && (!app || !entryVerified.current) && <p role="status">{m.loading}</p>}
    {(error !== null || unavailable) && <div className="notice error" role="alert">{unavailable ? m.unavailable : m.failed} <button type="button" className="button" disabled={admissionBlocked} onClick={() => void load()}>{m.retry}</button></div>}
    {notice && <p role="status">{notice}</p>}
    {!modal && <OperationPublicationError operation={op} zh={zh} />}
    {unknown && !modal && <div className="notice warning" role="alert">{m.unknown} <button className="button" type="button" onClick={review}>{m.check}</button>{checked && <><p>{m.checked}</p><button className="button" type="button" onClick={() => { op.clear(); setChecked(false); }}>{m.dismiss}</button></>}</div>}
    {app && !unavailable && entryVerified.current && <>
      <div className="page-heading"><div><div className="eyebrow">GITHUB APP</div><h1>{app.name}</h1><p>App ID {app.githubAppId} · {app.githubSlug}</p></div></div>
      <nav className="project-management-nav" aria-label={m.configuration}><a className="button" href={`/github-apps/${id}`} aria-current={section === 'configuration' ? 'page' : undefined} onClick={event => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigate(event.currentTarget.pathname); } }}>{m.configuration}</a><a className="button" href={`/github-apps/${id}/admins`} aria-current={section === 'admins' ? 'page' : undefined} onClick={event => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigate(event.currentTarget.pathname); } }}>{zh ? '管理员' : 'Administrators'}</a><a className="button" href={`/github-apps/${id}/teams`} aria-current={section === 'teams' ? 'page' : undefined} onClick={event => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigate(event.currentTarget.pathname); } }}>{zh ? 'Team 使用授权' : 'Team access'}</a></nav>
      <div hidden={section !== 'configuration'} inert={section !== 'configuration'}>
      <section className="panel github-app-details"><header className="panel-heading"><div><h2>{m.configTitle}</h2><p>{m.configHint}</p></div><button className="button" type="button" aria-disabled={admissionBlocked || !fresh.current || op.guarded() || op.publishing()} onClick={() => edit('name')}>{m.editName}</button></header>
        <div className="panel-body"><dl><div><dt>{m.name}</dt><dd>{app.name}</dd></div><div><dt>GitHub App</dt><dd>{app.githubName} · {app.githubSlug}<p>App ID {app.githubAppId}</p></dd></div><div><dt>{m.privateKey}</dt><dd className="github-app-credential"><span>{m.configured}</span><button className="button" type="button" aria-disabled={admissionBlocked || !fresh.current || op.guarded() || op.publishing()} onClick={() => edit('privateKey')}>{m.editPrivateKey}</button></dd></div><div><dt>Webhook secret</dt><dd className="github-app-credential"><span>{m.configured}</span><button className="button" type="button" aria-disabled={admissionBlocked || !fresh.current || op.guarded() || op.publishing()} onClick={() => edit('webhookSecret')}>{m.editWebhookSecret}</button></dd></div></dl>
          <div className="github-app-webhook"><h3>Webhook URL</h3><code>{app.webhookUrl}</code> <CopyButton label={m.copy} aria-disabled={admissionBlocked} onClick={copy}>{m.copy}</CopyButton>{copyStatus && <span role="status">{copyStatus}</span>}<p>{m.webhookHint}</p></div></div></section>
      <section className="panel danger-zone"><header className="panel-heading"><div><h2>{m.delete}</h2><p>{m.deleteHint}</p></div><button className="button danger" type="button" aria-disabled={!fresh.current || admissionBlocked || op.guarded() || op.publishing()} onClick={openDelete}>{m.delete}</button></header></section></div>
    </>}
    {adminsOpened.current && <div hidden={!active || section !== 'admins' || !entryVerified.current || unavailable} inert={!active || section !== 'admins' || !entryVerified.current || unavailable}><GitHubAppAdministration appId={id} active={active && section === 'admins' && entryVerified.current && !unavailable} admission={admission} admissionBlocked={admissionBlocked} onIdentityMismatch={onIdentityMismatch} accessDenied={unavailable} onUnknownReviewChange={review => onAdminReview(id, review)} onConfirmedResult={result => onAdminResult(id, result)} onAccessLost={loseAccess} onSelfRemoved={() => { loseAccess(); onLeft(); if (activeRef.current) navigate('/github-apps'); }} /></div>}
    {grantsOpened.current && <div hidden={!active || section !== 'teams' || !entryVerified.current || unavailable} inert={!active || section !== 'teams' || !entryVerified.current || unavailable}><GitHubAppGrants appId={id} active={active && section === 'teams' && entryVerified.current && !unavailable} admission={admission} admissionBlocked={admissionBlocked} onIdentityMismatch={onIdentityMismatch} accessDenied={unavailable} onUnknownReviewChange={review => onGrantReview(id, review)} onPublicationErrorChange={error => onGrantPublication(id, error)} receipt={grantReceipt} onResult={result => { onGrantResult(id, result); return false; }} onUnavailable={loseAccess} /></div>}
    {modal && app && !unavailable && <ManagementDialog typography preserveFocus title={modal === 'name' ? m.editName : modal === 'privateKey' ? m.editPrivateKey : modal === 'webhookSecret' ? m.editWebhookSecret : m.deleteTitle} busy={op.pending} suspended={!active || section !== 'configuration' || !entryVerified.current} onClose={close} footer={<><button type="button" className="button" disabled={op.pending} onClick={close}>{unknown ? m.close : m.cancel}</button>{unknown || changed ? <button type="button" className="button github-app-action" aria-disabled={admissionBlocked} onClick={review}>{m.review}</button> : modal !== 'delete' ? <button type="submit" form={`github-edit-${id}`} className="button primary github-app-action" disabled={op.pending || op.publicationPending} aria-disabled={admissionBlocked || !fresh.current}>{op.pending ? m.submitting : modal === 'name' ? m.saveName : modal === 'privateKey' ? m.savePrivateKey : m.saveWebhookSecret}</button> : <button type="button" className="button danger github-app-action" disabled={op.pending || op.publicationPending} aria-disabled={admissionBlocked || impactLoading || impact === null || impact.nextCursor !== null || !fresh.current || !impactFresh.current} onClick={remove}>{op.pending ? m.submitting : m.confirmDelete}</button>}</>}>
      {modal !== 'delete' ? <><form id={`github-edit-${id}`} className="github-app-modal-form" onSubmit={save}>
        {modal === 'name' && <div className="field"><label htmlFor={`app-name-${id}`}>{m.name}</label><input id={`app-name-${id}`} value={name} disabled={op.pending || unknown} onChange={e => setName(e.target.value)} /></div>}
        {modal === 'privateKey' && <div className="field"><label htmlFor={`app-key-${id}`}>{m.privateKey}</label><textarea id={`app-key-${id}`} value={key} disabled={op.pending || unknown} onChange={e => setKey(e.target.value)} /><p>{m.privateKeyHint}</p></div>}
        {modal === 'webhookSecret' && <><div className="field"><label htmlFor={`app-secret-${id}`}>Webhook secret</label><input id={`app-secret-${id}`} type="password" autoComplete="off" value={secret} disabled={op.pending || unknown} onChange={e => setSecret(e.target.value)} /><p>{m.webhookSecretHint}</p></div><p>Webhook URL: <code>{app.webhookUrl}</code></p><p>{m.webhookHint}</p></>}</form>{invalid && <div className="notice error" role="alert">{modal === 'name' ? m.invalidName : m.invalidCredential}</div>}</> : <div className="github-app-impact"><p><strong>{app.name}</strong> · App ID {app.githubAppId}</p><p>{m.deleteBody}</p><h3>{m.impact}</h3>{impactLoading && !impact && <p role="status">{m.loading}</p>}
        {impact && <><ul>{impact.teams.map(row => <li key={row.team.id}><strong>{row.team.kind === 'personal' ? m.personal : row.team.name}</strong><p><code>{row.team.id}</code></p><p>{row.projects} {m.connections}</p></li>)}</ul>{impact.nextCursor && <button className="button" type="button" aria-disabled={impactLoading || admissionBlocked} onClick={() => { if (!impactLoading && !admissionBlocked) void loadImpact(true); }}>{m.more}</button>}<p><strong>{m.total}: {impact.totalProjects}</strong></p><ImpactProjects hiddenProjects={impact.hiddenProjects} page={projectsFresh.current ? projects : null} blocked={impactLoading || admissionBlocked || !impactFresh.current} labels={m} onRead={() => void loadProjects()} onMore={() => void loadProjects(true)} /></>}
        {impactError !== null && <div className="notice error" role="alert">{impactError instanceof ProjectVisibilityChanged ? m.projectChanged : conflict(impactError) ? m.conflict : m.failed} <button className="button" type="button" onClick={review}>{m.retry}</button></div>}<p>{m.deleteFooter}</p></div>}
      {op.result && <div className="notice error" role="alert">{unknown ? m.unknown : conflict(op.result.error) ? m.conflict : m.rejected}</div>}{changed && <div className="notice warning" role="alert">{m.conflict}</div>}{checked && <><p role="status">{m.checked}</p>{unknown && <button className="button" type="button" onClick={() => { op.clear(); close(); setChecked(false); }}>{m.dismiss}</button>}</>}<OperationPublicationError operation={op} zh={zh} />
    </ManagementDialog>}
  </>;
};
