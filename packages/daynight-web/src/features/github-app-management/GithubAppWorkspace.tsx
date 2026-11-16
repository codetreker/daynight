import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { getProjectAccess } from '../../api/auth';
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

type Props = { readonly appId: string | null; readonly active: boolean; readonly admission: TaskCacheScope; readonly admissionBlocked: boolean; readonly onIdentityMismatch: () => void };
type Shared = Omit<Props, 'appId'>;
type AccessState = { revision: number; denied: Set<string> };
type AppPage = { readonly items: readonly GitHubApp[]; readonly nextCursor: string | null; readonly pages: number };
const denied = (error: unknown) => error instanceof ApiError && error.kind === 'server' && (error.status === 403 || error.status === 404);
const conflict = (error: unknown) => error instanceof ApiError && error.kind === 'server' && error.status === 409;
// These GitHub failures occur during credential proof, before the transaction.
const proofRefused = (error: unknown) => error instanceof ApiError && error.kind === 'server' && error.status === 502 && (error.code === 'github_rate_limited' || error.code === 'github_unavailable');
class ProjectVisibilityChanged extends Error {}
const verifyProjects = async (items: GitHubImpactProjectPage['items'], signal: AbortSignal, admission: TaskCacheScope, mismatch: () => void, onDenied: () => void) => {
  let next = 0, failed = false, failure: unknown;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (!failed && next < items.length) {
      const item = items[next++]!;
      try { await admission.ready(signal); await getProjectAccess(item.id, signal, auth(admission, mismatch)); await admission.ready(signal); }
      catch (error) { failed = true; if (denied(error)) { onDenied(); failure = new ProjectVisibilityChanged(); } else failure = error; }
    }
  }));
  if (failed) throw failure;
};
const validName = (s: string) => s.isWellFormed() && !s.includes('\0') && /[^\p{White_Space}]/u.test(s) && [...s].length <= 256 && new TextEncoder().encode(s).length <= 1024;
const validAppId = (s: string) => /^[1-9][0-9]*$/.test(s) && s.length <= 19 && BigInt(s) <= 9223372036854775807n;
const auth = (admission: TaskCacheScope, mismatch: () => void, dispatched?: () => void) => ({ userId: admission.userId, onPrincipalMismatch: mismatch, ...(dispatched ? { onDispatch: dispatched } : {}) });

// Identity changes discard every retained owner, including drafts and pending presentation.
export const GithubAppWorkspace = (props: Props) => {
  const owner = useRef({ admission: props.admission, revision: 0 });
  if (owner.current.admission !== props.admission) owner.current = { admission: props.admission, revision: owner.current.revision + 1 };
  return <Workspace key={owner.current.revision} {...props} />;
};

const Workspace = ({ appId, active, ...shared }: Props) => {
  const owners = useRef<string[]>([]), access = useRef<AccessState>({ revision: 0, denied: new Set() });
  const [, refreshAccess] = useState(0), [result, setResult] = useState<'saved' | 'removed' | null>(null);
  const { locale } = useI18n();
  const onUnavailable = useCallback((id: string) => { access.current.denied.add(id); access.current.revision++; refreshAccess(value => value + 1); }, []);
  const onListRead = useCallback((revision: number) => { if (access.current.revision !== revision) return false; access.current.denied.clear(); return true; }, []);
  if (appId !== null && !owners.current.includes(appId)) owners.current.push(appId);
  return <div className="github-app-workspace">
    {result && <p role="status">{appMessages(locale === 'zh-CN')[result]}</p>}
    <div hidden={!active || appId !== null} inert={!active || appId !== null}><AppList {...shared} active={active && appId === null} access={access} onListRead={onListRead} /></div>
    {owners.current.map(id => <div key={id} hidden={!active || appId !== id} inert={!active || appId !== id}><AppDetail {...shared} id={id} active={active && appId === id} onUnavailable={onUnavailable} onDeleted={() => setResult('removed')} onSaved={() => setResult('saved')} /></div>)}
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
    <section className="panel"><header className="panel-heading"><h2>{m.list}</h2></header>
      {(!page || !entryVerified.current) && loading && <p className="empty-inline" role="status">{m.loading}</p>}
      {page && entryVerified.current && (visibleItems.length === 0 ? <div className="empty-inline"><strong>{m.empty}</strong><p>{m.emptyHint}</p></div> : <ul className="github-app-list">{visibleItems.map(app => <li key={app.id}><div><h3>{app.name}</h3><p>App ID {app.githubAppId} · {app.githubSlug}</p><div className="github-app-summary"><span>{app.administrators} {m.administrators}</span><span>{app.authorizedTeams} {m.teams}</span></div></div><button className="button" type="button" onClick={() => navigate(`/github-apps/${app.id}`)}>{m.manage}</button></li>)}</ul>)}
      {entryVerified.current && page?.nextCursor && <div className="github-app-more"><button type="button" className="button" aria-disabled={loading || admissionBlocked} onClick={() => { if (!loading && !admissionBlocked) void load(true); }}>{m.more}</button></div>}
    </section>
    {open && <ManagementDialog preserveFocus title={m.create} busy={op.pending} suspended={!active || !entryVerified.current} onClose={close} footer={<><button className="button" type="button" disabled={op.pending} onClick={close}>{unknown ? m.close : m.cancel}</button>{unknown ? <button className="button" type="button" onClick={check} aria-disabled={admissionBlocked}>{m.check}</button> : <button className="button primary" type="submit" form="github-app-create" disabled={op.pending || op.publicationPending} aria-disabled={admissionBlocked}>{op.pending ? m.submitting : m.register}</button>}</>}>
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

type DetailProps = Shared & { readonly id: string; readonly onUnavailable: (id: string) => void; readonly onDeleted: () => void; readonly onSaved: () => void };
const AppDetail = ({ id, active, admission, admissionBlocked, onIdentityMismatch, onUnavailable, onDeleted, onSaved }: DetailProps) => {
  const { locale } = useI18n(), zh = locale === 'zh-CN', m = appMessages(zh);
  const [app, setApp] = useState<GitHubApp | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState<unknown>(null), [unavailable, setUnavailable] = useState(false), [notice, setNotice] = useState('');
  const [modal, setModal] = useState<'edit' | 'delete' | null>(null), [name, setName] = useState(''), [key, setKey] = useState(''), [secret, setSecret] = useState(''), [invalid, setInvalid] = useState(false), [changed, setChanged] = useState(false), [checked, setChecked] = useState(false);
  const [impact, setImpact] = useState<GitHubAppImpact | null>(null), [projects, setProjects] = useState<GitHubImpactProjectPage | null>(null), [impactError, setImpactError] = useState<unknown>(null), [impactLoading, setImpactLoading] = useState(false);
  const current = useRef<GitHubApp | null>(null), read = useRef<AbortController | null>(null), impactRead = useRef<AbortController | null>(null), epoch = useRef(0), accessEpoch = useRef(0), projectCursor = useRef<string | null>(null), impactPages = useRef(0), impactFresh = useRef(false), projectsFresh = useRef(false), deniedRef = useRef(false), entryVerified = useRef(false), fresh = useRef(false), activeRef = useRef(active), op = useOperation(admission);
  activeRef.current = active;
  if (!active || admissionBlocked) { fresh.current = false; impactFresh.current = false; }
  const loseAccess = () => { onUnavailable(id); deniedRef.current = true; epoch.current++; accessEpoch.current++; read.current?.abort(); read.current = null; setLoading(false); fresh.current = false; current.current = null; setApp(null); setUnavailable(true); setModal(null); setName(''); setKey(''); setSecret(''); setImpact(null); setProjects(null); impactRead.current?.abort(); };
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
    if (!active || admissionBlocked || unavailable || more && (!impact || !impact.nextCursor)) return;
    impactRead.current?.abort(); const controller = new AbortController(); impactRead.current = controller;
    const signal = AbortSignal.any([controller.signal, admission.signal]), revision = epoch.current;
    impactFresh.current = false; setImpactLoading(true); setImpactError(null);
    try {
      let cursor = more ? impact!.nextCursor : null;
      let rows = more ? [...impact!.teams] : [], pages = more ? impactPages.current : 0;
      const target = more ? pages + 1 : Math.max(1, impactPages.current);
      let value: GitHubAppImpact | null = more ? impact : null;
      do {
        await admission.ready(signal); const page = await getGitHubAppRemovalImpact(id, cursor, signal, auth(admission, onIdentityMismatch)); await admission.ready(signal);
        if (signal.aborted || admission.isInvalidated || epoch.current !== revision) return;
        if (projects && (projects.hiddenProjects !== page.hiddenProjects || impact && (impact.version !== page.version || impact.impactVersion !== page.impactVersion))) { projectsFresh.current = false; setProjects(null); projectCursor.current = null; }
        if (value && (value.version !== page.version || value.impactVersion !== page.impactVersion)) throw new ApiError('protocol');
        if (page.nextCursor !== null && page.nextCursor === cursor) throw new ApiError('protocol');
        rows = [...rows, ...page.teams]; if (new Set(rows.map(row => row.team.id)).size !== rows.length) throw new ApiError('protocol');
        cursor = page.nextCursor; pages++; value = page;
      } while (pages < target && cursor !== null);
      if (impact && (impact.version !== value!.version || impact.impactVersion !== value!.impactVersion)) { setProjects(null); projectsFresh.current = false; projectCursor.current = null; setChanged(true); }
      else if (projects && projects.hiddenProjects !== value!.hiddenProjects) { setProjects(null); projectsFresh.current = false; projectCursor.current = null; }
      impactPages.current = pages; impactFresh.current = true; setImpact({ ...value!, teams: rows });
    } catch (failure) { if (!signal.aborted && !admission.isInvalidated && epoch.current === revision) { if (denied(failure)) loseAccess(); else if (conflict(failure)) { setImpact(null); setProjects(null); setChanged(true); } setImpactError(failure); } }
    finally { if (impactRead.current === controller) { impactRead.current = null; if (!signal.aborted && !admission.isInvalidated && epoch.current === revision) setImpactLoading(false); } }
  };
  const loadProjects = async (more = false) => {
    if (!active || admissionBlocked || !impact || more && (!projects || !projects.nextCursor)) return;
    impactRead.current?.abort(); const controller = new AbortController(); impactRead.current = controller;
    const signal = AbortSignal.any([controller.signal, admission.signal]), revision = epoch.current;
    setImpactLoading(true); setImpactError(null);
    try {
      const cursor = more ? projects!.nextCursor : projectCursor.current;
      await admission.ready(signal);
      const value = await listGitHubAppRemovalProjects(id, cursor, signal, auth(admission, onIdentityMismatch));
      await verifyProjects(value.items, signal, admission, onIdentityMismatch, () => { if (!signal.aborted && !admission.isInvalidated && epoch.current === revision) { projectsFresh.current = false; setProjects(null); projectCursor.current = null; } });
      const checkedImpact = await getGitHubAppRemovalImpact(id, null, signal, auth(admission, onIdentityMismatch)); await admission.ready(signal);
      if (signal.aborted || admission.isInvalidated || epoch.current !== revision) return;
      if (value.nextCursor !== null && value.nextCursor === cursor) throw new ApiError('protocol');
      if (value.hiddenProjects !== checkedImpact.hiddenProjects) throw new ProjectVisibilityChanged();
      if (checkedImpact.version !== impact.version || checkedImpact.impactVersion !== impact.impactVersion) { setImpact(null); setProjects(null); projectCursor.current = null; setChanged(true); return; }
      projectCursor.current = cursor; projectsFresh.current = true; setProjects(value);
    } catch (failure) { if (!signal.aborted && !admission.isInvalidated && epoch.current === revision) { if (failure instanceof ProjectVisibilityChanged || denied(failure) || conflict(failure)) { projectsFresh.current = false; setProjects(null); projectCursor.current = null; } if (denied(failure)) loseAccess(); else if (conflict(failure)) { setImpact(null); setChanged(true); } setImpactError(failure); } }
    finally { if (impactRead.current === controller) { impactRead.current = null; if (!signal.aborted && !admission.isInvalidated && epoch.current === revision) setImpactLoading(false); } }
  };
  const refreshImpact = async () => { const revision = epoch.current; await loadImpact(); if (epoch.current === revision && projects) await loadProjects(); };
  useEffect(() => { if (active && !admissionBlocked && modal === 'delete' && !op.pending && !op.result) void refreshImpact(); }, [active, admissionBlocked]);
  const close = () => { epoch.current++; impactRead.current?.abort(); setImpactLoading(false); setModal(null); setName(''); setKey(''); setSecret(''); setImpact(null); setProjects(null); impactPages.current = 0; projectCursor.current = null; impactFresh.current = false; projectsFresh.current = false; setInvalid(false); if (op.result?.kind !== 'unknown') { op.clear(); setChecked(false); } };
  const edit = () => { if (!app || op.guarded()) return; op.clear(); setChanged(false); setInvalid(false); setName(app.name); setKey(''); setSecret(''); setNotice(''); setModal('edit'); };
  const openDelete = () => { if (!app || !fresh.current || op.guarded() || admissionBlocked) return; op.clear(); setChanged(false); setNotice(''); setModal('delete'); void loadImpact(); };
  const save = (event: FormEvent) => {
    event.preventDefault(); if (!active || admissionBlocked || !app || !fresh.current || op.guarded() || changed) return;
    if (!validName(name) || name === app.name && !key && !secret) { setInvalid(true); return; }
    const revision = epoch.current;
    const input = { version: app.version, ...(name !== app.name ? { name } : {}), ...(key ? { privateKeyPem: key } : {}), ...(secret ? { webhookSecret: secret } : {}) };
    void op.run((signal, dispatched) => updateGitHubApp(id, input, signal, auth(admission, onIdentityMismatch, dispatched)), value => {
      onSaved(); if (revision !== epoch.current) return; current.current = value; setApp(value); setModal(null); setName(''); setKey(''); setSecret('');
    }, failure => { if (revision !== epoch.current) return; if (denied(failure)) loseAccess(); else if (conflict(failure)) { setChanged(true); fresh.current = false; } }, proofRefused);
  };
  const remove = () => {
    if (!active || admissionBlocked || !app || !impact || impact.nextCursor !== null || !fresh.current || !impactFresh.current || op.guarded() || changed) return;
    const revision = epoch.current;
    void op.run((signal, dispatched) => removeGitHubApp(id, { version: impact.version, impactVersion: impact.impactVersion }, signal, auth(admission, onIdentityMismatch, dispatched)), () => {
      onDeleted(); onUnavailable(id); if (revision !== epoch.current) return; setModal(null); setName(''); setKey(''); setSecret(''); current.current = null; setApp(null); if (activeRef.current) navigate('/github-apps');
    }, failure => { if (revision !== epoch.current) return; if (denied(failure)) loseAccess(); else if (conflict(failure)) { setChanged(true); setImpact(null); setProjects(null); fresh.current = false; } });
  };
  const review = () => { void (async () => { const next = await load(); if (next || deniedRef.current) { setChecked(true); if (next && op.result?.kind !== 'unknown') { op.clear(); setChanged(false); if (modal === 'delete') void loadImpact(); } } })(); };
  const unknown = op.result?.kind === 'unknown';
  const [copyStatus, setCopyStatus] = useState('');
  const copy = () => { if (!app || !active || admissionBlocked) return; const revision = epoch.current; void navigator.clipboard.writeText(app.webhookUrl).then(() => { if (revision === epoch.current && activeRef.current && !admission.isInvalidated) setCopyStatus(m.copied); }, () => { if (revision === epoch.current && activeRef.current && !admission.isInvalidated) setCopyStatus(m.copyFailed); }); };
  return <>
    <button className="button" type="button" onClick={() => navigate('/github-apps')}>← {m.back}</button>
    {loading && (!app || !entryVerified.current) && <p role="status">{m.loading}</p>}
    {(error !== null || unavailable) && <div className="notice error" role="alert">{unavailable ? m.unavailable : m.failed} <button type="button" className="button" disabled={admissionBlocked} onClick={() => void load()}>{m.retry}</button></div>}
    {notice && <p role="status">{notice}</p>}
    {unknown && !modal && <div className="notice warning" role="alert">{m.unknown} <button className="button" type="button" onClick={review}>{m.check}</button>{checked && <><p>{m.checked}</p><button className="button" type="button" onClick={() => { op.clear(); setChecked(false); }}>{m.dismiss}</button></>}</div>}
    {app && !unavailable && entryVerified.current && <>
      <div className="page-heading"><div><div className="eyebrow">GITHUB APP</div><h1>{app.name}</h1><p>App ID {app.githubAppId} · {app.githubSlug}</p></div></div>
      <nav className="project-management-nav" aria-label={m.configuration}><span className="button" aria-current="page">{m.configuration}</span></nav>
      <section className="panel github-app-details"><header className="panel-heading"><div><h2>{m.configTitle}</h2><p>{m.configHint}</p></div><button className="button" type="button" disabled={op.guarded()} onClick={edit}>{m.edit}</button></header>
        <div className="panel-body"><dl><div><dt>{m.name}</dt><dd>{app.name}</dd></div><div><dt>GitHub App</dt><dd>{app.githubName} · {app.githubSlug}<p>App ID {app.githubAppId}</p></dd></div><div><dt>{m.privateKey}</dt><dd>{m.configured}</dd></div><div><dt>Webhook secret</dt><dd>{m.configured}</dd></div></dl>
          <div className="github-app-webhook"><h3>Webhook URL</h3><code>{app.webhookUrl}</code> <CopyButton label={m.copy} aria-disabled={admissionBlocked} onClick={copy}>{m.copy}</CopyButton>{copyStatus && <span role="status">{copyStatus}</span>}<p>{m.webhookHint}</p></div></div></section>
      <section className="panel danger-zone"><header className="panel-heading"><div><h2>{m.delete}</h2><p>{m.deleteHint}</p></div><button className="button danger" type="button" aria-disabled={!fresh.current || admissionBlocked || op.guarded()} onClick={openDelete}>{m.delete}</button></header></section>
    </>}
    {modal && app && !unavailable && <ManagementDialog preserveFocus title={modal === 'edit' ? m.edit : m.deleteTitle} busy={op.pending} suspended={!active || !entryVerified.current} onClose={close} footer={<><button type="button" className="button" disabled={op.pending} onClick={close}>{unknown ? m.close : m.cancel}</button>{unknown || changed ? <button type="button" className="button github-app-action" aria-disabled={admissionBlocked} onClick={review}>{m.review}</button> : modal === 'edit' ? <button type="submit" form={`github-edit-${id}`} className="button primary github-app-action" disabled={op.pending || op.publicationPending} aria-disabled={admissionBlocked || !fresh.current}>{op.pending ? m.submitting : m.save}</button> : <button type="button" className="button danger github-app-action" disabled={op.pending || op.publicationPending} aria-disabled={admissionBlocked || impactLoading || impact === null || impact.nextCursor !== null || !fresh.current || !impactFresh.current} onClick={remove}>{op.pending ? m.submitting : m.confirmDelete}</button>}</>}>
      {modal === 'edit' ? <><p>{m.registerHint}</p><form id={`github-edit-${id}`} className="github-app-modal-form" onSubmit={save}>
        <div className="field"><label htmlFor={`app-id-${id}`}>App ID</label><input id={`app-id-${id}`} value={app.githubAppId} disabled /></div>
        <div className="field"><label htmlFor={`app-name-${id}`}>{m.name}</label><input id={`app-name-${id}`} value={name} disabled={op.pending || unknown} onChange={e => setName(e.target.value)} /></div>
        <div className="field"><label htmlFor={`app-key-${id}`}>{m.privateKey}</label><textarea id={`app-key-${id}`} value={key} disabled={op.pending || unknown} onChange={e => setKey(e.target.value)} /><p>{m.secretHint}</p></div>
        <div className="field"><label htmlFor={`app-secret-${id}`}>Webhook secret</label><input id={`app-secret-${id}`} type="password" autoComplete="off" value={secret} disabled={op.pending || unknown} onChange={e => setSecret(e.target.value)} /><p>{m.secretHint}</p></div>
        <p>Webhook URL: <code>{app.webhookUrl}</code></p><p>{m.webhookHint}</p></form>{invalid && <div className="notice error" role="alert">{m.invalid}</div>}</> : <div className="github-app-impact"><p><strong>{app.name}</strong> · App ID {app.githubAppId}</p><p>{m.deleteBody}</p><h3>{m.impact}</h3>{impactLoading && !impact && <p role="status">{m.loading}</p>}
        {impact && <><ul>{impact.teams.map(row => <li key={row.team.id}><strong>{row.team.kind === 'personal' ? m.personal : row.team.name}</strong><p><code>{row.team.id}</code></p><p>{row.projects} {m.connections}</p></li>)}</ul>{impact.nextCursor && <button className="button" type="button" aria-disabled={impactLoading || admissionBlocked} onClick={() => { if (!impactLoading && !admissionBlocked) void loadImpact(true); }}>{m.more}</button>}<p><strong>{m.total}: {impact.totalProjects}</strong></p><p>{projectsFresh.current && projects ? projects.hiddenProjects : impact.hiddenProjects} {m.hidden}</p><h3>{m.visible}</h3>{projects && projectsFresh.current ? <><ul>{projects.items.map(project => <li key={project.id}>{project.name} · {project.repoUrl}</li>)}</ul>{projects.nextCursor && <button className="button" type="button" aria-disabled={impactLoading || admissionBlocked} onClick={() => { if (!impactLoading && !admissionBlocked) void loadProjects(true); }}>{m.more}</button>}</> : <button className="button" type="button" aria-disabled={impactLoading || admissionBlocked} onClick={() => { if (!impactLoading && !admissionBlocked) void loadProjects(); }}>{m.projects}</button>}</>}
        {impactError !== null && <div className="notice error" role="alert">{impactError instanceof ProjectVisibilityChanged ? m.projectChanged : conflict(impactError) ? m.conflict : m.failed} <button className="button" type="button" onClick={review}>{m.retry}</button></div>}<p>{m.deleteFooter}</p></div>}
      {op.result && <div className="notice error" role="alert">{unknown ? m.unknown : conflict(op.result.error) ? m.conflict : m.rejected}</div>}{changed && <div className="notice warning" role="alert">{m.conflict}</div>}{checked && <><p role="status">{m.checked}</p>{unknown && <button className="button" type="button" onClick={() => { op.clear(); close(); setChecked(false); }}>{m.dismiss}</button>}</>}<OperationPublicationError operation={op} zh={zh} />
    </ManagementDialog>}
  </>;
};
