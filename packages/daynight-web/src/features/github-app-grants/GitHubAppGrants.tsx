import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { getProjectAccess } from '../../api/auth';
import { ImpactProjects } from '../github-app-impact/ImpactProjects';
import { verifyImpactProjects } from '../github-app-impact/verify-projects';
import { getGitHubApp } from '../../api/github-app-management';
import { canonicalId } from '../../api/validation';
import { createGitHubAppGrant, getGitHubAppGrant, getGitHubAppGrantImpact, listGitHubAppGrantImpactProjects, listGitHubAppGrants, previewGitHubAppGrant, revokeGitHubAppGrant, type GitHubGrantImpact, type GitHubGrantPreview, type GitHubGrantTeam, type GitHubTeamGrant } from '../../api/github-app-grants';
import type { GitHubImpactProjectPage } from '../../api/github-app-management';
import { useI18n } from '../../i18n/LocaleProvider';
import { ManagementDialog } from '../management/ManagementDialog';
import type { TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { OperationPublicationError, useOperation } from '../teams/TeamManagement';
import { useTeamForeground } from '../teams/useTeamForeground';
import './github-app-grants.css';

export type GitHubAppGrantPublicationError = { readonly confirmed: boolean; readonly unavailable: boolean; readonly retry: (() => void) | null };
export type GitHubAppGrantUnknownReview = { readonly state: 'unknown' | 'app-unavailable'; readonly check: () => void; readonly finish: (() => void) | null };
export type GitHubAppGrantsProps = { readonly appId: string; readonly active: boolean; readonly admission: TaskCacheScope; readonly admissionBlocked: boolean; readonly accessDenied: boolean; readonly onIdentityMismatch: () => void; readonly onUnavailable: () => void; readonly onUnknownReviewChange?: (review: GitHubAppGrantUnknownReview | null) => void; readonly onPublicationErrorChange?: (error: GitHubAppGrantPublicationError | null) => void; readonly receipt?: { readonly result: 'granted' | 'revoked'; readonly dismiss: () => void } | null; readonly onResult?: (result: 'granted' | 'revoked') => boolean | void };
type List = { readonly items: readonly GitHubTeamGrant[]; readonly cursor: string | null; readonly pages: number; readonly counts: ReadonlyMap<string, string | null> };
type Dialog = { readonly kind: 'grant' } | { readonly kind: 'revoke'; readonly grant: GitHubTeamGrant };
const teamLabel = (team: GitHubGrantTeam, zh: boolean): string => {
  if (team.kind === 'ordinary') return team.name!;
  const owner = team.personalOwner!;
  const name = owner.name !== null && /[^\p{White_Space}]/u.test(owner.name) ? owner.name : owner.userId;
  return zh ? `${name} 的个人 Team` : `${name}'s Personal Team`;
};
const TeamLabel = ({ team, zh }: { readonly team: GitHubGrantTeam; readonly zh: boolean }) => <span className={team.kind === 'personal' ? 'github-grants-personal-label' : undefined}>{teamLabel(team, zh)}</span>;

const denied = (e: unknown) => e instanceof ApiError && e.kind === 'server' && (e.status === 403 || e.status === 404);
const conflict = (e: unknown) => e instanceof ApiError && e.kind === 'server' && e.status === 409;
const auth = (admission: TaskCacheScope, mismatch: () => void, dispatched?: () => void) => ({ userId: admission.userId, onPrincipalMismatch: mismatch, ...(dispatched ? { onDispatch: dispatched } : {}) });
const messages = (zh: boolean) => zh ? {
  title: 'Team 使用授权', subtitle: '获授权 Team 的管理员可以为其项目建立连接。', grant: '授权 Team', empty: '尚未授权 Team', emptyHint: '输入 Team ID，核对目标后授予使用权。', loading: '正在读取…', failed: '无法读取当前内容。', retry: '重试', more: '加载更多', revoke: '撤销授权', personal: '个人 Team', ordinary: '普通 Team', connections: '个连接', countUnavailable: '连接数暂不可用', help: '项目内容仍按项目权限访问。',
  grantTitle: '授权 Team 使用 App', teamId: 'Team ID', verify: '核对 Team', verifying: '正在核对…', invalid: '请输入有效的 Team ID（UUID）。', grantConfirm: '授予使用权', grantHint: '使用权允许该 Team 的管理员为其项目建立连接，不授予 App 管理权限。', existing: '此 Team 已获得授权。', unavailable: '此 Team 或 App 不可用，请核对后重试。', cancel: '取消', close: '关闭', submitting: '正在提交…', granted: 'Team 已获 App 使用权。', revoked: 'Team 使用授权已撤销，相关连接已停止。已有 PR 保留。',
  revokeTitle: '撤销 Team 使用授权？', revokeHint: '此 Team 使用该 App 的连接将解除，同步关闭，已有 PR 保留。其他 Team 的授权保持不变。', impact: '受影响连接', revokeConfirm: '撤销授权并断开连接', hidden: '个项目的详情不可见', visible: '你有权查看的项目', projects: '查看可访问项目', projectChanged: '项目访问权限或影响范围已变化，请重新核对。',
  rejected: '操作被拒绝，请核对输入与当前权限。', conflict: '配置或授权已变化，输入保留，请重新核对。', review: '核对当前状态', unknown: '操作结果未知。请先核对当前状态，不要重复提交。', checked: '已读取当前状态；这不能确认原操作的结果。', observed: '当前可读取的授权', absent: '当前授权不可读取或不存在。', dismiss: '结束核对并重新决定', appUnavailable: '此 App 不可用或你没有访问权限。', unknownAppUnavailable: '此 App 当前不可访问；原操作结果仍未知。'
} : {
  title: 'Team access', subtitle: 'Administrators of authorized Teams can connect their Projects.', grant: 'Authorize Team', empty: 'No authorized Teams', emptyHint: 'Enter a Team ID, verify the target, then grant access.', loading: 'Loading…', failed: 'Unable to load current data.', retry: 'Retry', more: 'Load more', revoke: 'Revoke access', personal: 'Personal Team', ordinary: 'Ordinary Team', connections: 'connections', countUnavailable: 'Connection count unavailable', help: 'Project content remains governed by Project access.',
  grantTitle: 'Authorize Team to use App', teamId: 'Team ID', verify: 'Verify Team', verifying: 'Verifying…', invalid: 'Enter a valid Team ID (UUID).', grantConfirm: 'Grant access', grantHint: 'Access lets this Team’s administrators connect their Projects. It does not grant App administrator authority.', existing: 'This Team already has access.', unavailable: 'This Team or App is unavailable. Check the target and try again.', cancel: 'Cancel', close: 'Close', submitting: 'Submitting…', granted: 'Team access granted.', revoked: 'Team access revoked and affected connections stopped. Existing PRs are retained.',
  revokeTitle: 'Revoke Team access?', revokeHint: 'This Team’s connections using this App will be disconnected and sync stopped. Existing PRs are retained. Other Teams keep their access.', impact: 'Affected connections', revokeConfirm: 'Revoke access and disconnect', hidden: 'projects whose details are hidden', visible: 'Projects you can access', projects: 'View accessible projects', projectChanged: 'Project access or impact changed. Review the current state.',
  rejected: 'The operation was rejected. Check the input and current permission.', conflict: 'The configuration or grant changed. Your input is retained; review the current state.', review: 'Check current state', unknown: 'The outcome is unknown. Check the current state before another submission.', checked: 'The current state was loaded; it does not establish the original operation’s outcome.', observed: 'Currently accessible grant', absent: 'The original grant is currently unavailable or absent.', dismiss: 'Finish review and decide again', appUnavailable: 'This App is unavailable or you do not have access.', unknownAppUnavailable: 'This App is currently unavailable; the original outcome remains unknown.'
};

export const GitHubAppGrants = (props: GitHubAppGrantsProps) => {
  const owner = useRef({ admission: props.admission, appId: props.appId, revision: 0 });
  if (owner.current.admission !== props.admission || owner.current.appId !== props.appId) owner.current = { admission: props.admission, appId: props.appId, revision: owner.current.revision + 1 };
  return <GrantWorkspace key={owner.current.revision} {...props} />;
};

const GrantWorkspace = ({ appId, active, admission, admissionBlocked, accessDenied, onIdentityMismatch, onUnavailable, onUnknownReviewChange, onPublicationErrorChange, receipt, onResult }: GitHubAppGrantsProps) => {
  const { locale } = useI18n(), zh = locale === 'zh-CN', m = messages(zh);
  const [list, setList] = useState<List | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState<unknown>(null), [unavailable, setUnavailable] = useState(false), [notice, setNotice] = useState<'granted' | 'revoked' | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null), [typed, setTyped] = useState(''), [preview, setPreview] = useState<GitHubGrantPreview | null>(null), [previewing, setPreviewing] = useState(false), [dialogError, setDialogError] = useState<unknown>(null), [invalid, setInvalid] = useState(false), [changed, setChanged] = useState(false);
  const [impact, setImpact] = useState<GitHubGrantImpact | null>(null), [impactLoading, setImpactLoading] = useState(false), [projectCheckRevision, setProjectCheckRevision] = useState(0), [projects, setProjects] = useState<GitHubImpactProjectPage | null>(null), [projectError, setProjectError] = useState(false), [checked, setChecked] = useState(false), [appLostDuringCheck, setAppLostDuringCheck] = useState(false), [observed, setObserved] = useState<GitHubTeamGrant | null>(null);
  const listRef = useRef<List | null>(null), read = useRef<AbortController | null>(null), previewRead = useRef<AbortController | null>(null), impactRead = useRef<AbortController | null>(null), epoch = useRef(0), inputRevision = useRef(0), target = useRef<string | null>(null), entered = useRef(false), entryFresh = useRef(false), wasActive = useRef(false), activeRef = useRef(active), projectsFresh = useRef(false), projectCursor = useRef<string | null>(null), op = useOperation(admission);
  const unavailableCallback = useRef(onUnavailable), externallyDenied = useRef(false), projectRecheck = useRef(false), operationSequence = useRef(0), impactObservation = useRef(0), impactReadGeneration = useRef(0), checkRead = useRef<AbortController | null>(null), checkRevision = useRef(0);
  const impactView = useRef<{ dialog: Dialog | null; impact: GitHubGrantImpact | null }>({ dialog, impact });
  impactView.current = { dialog, impact }; unavailableCallback.current = onUnavailable;
  const observeCountImpact = (grantId: string, value: GitHubGrantImpact | null) => {
    const current = impactView.current;
    if (current.dialog?.kind !== 'revoke' || current.dialog.grant.id !== grantId || !current.impact) return;
    if (value && current.impact.version === value.version && current.impact.impactVersion === value.impactVersion && current.impact.hiddenProjects === value.hiddenProjects) return;
    impactObservation.current++; projectsFresh.current = false; projectRecheck.current = false; projectCursor.current = null;
    impactView.current = { dialog: current.dialog, impact: value };
    setProjects(null); setImpact(value); setChanged(true);
    if (value === null) setDialogError(new ApiError('server', 404, 'not_found'));
  };
  const invalidateCheck = () => { checkRevision.current++; checkRead.current?.abort(); checkRead.current = null; };
  activeRef.current = active;
  if (accessDenied && !externallyDenied.current) { externallyDenied.current = true; epoch.current++; impactReadGeneration.current++; checkRevision.current++; inputRevision.current++; entered.current = false; entryFresh.current = false; listRef.current = null; projectsFresh.current = false; projectRecheck.current = false; }
  if (!accessDenied) externallyDenied.current = false;
  if ((!active || admissionBlocked) && projects) projectRecheck.current = true;
  if (!active) { wasActive.current = false; entryFresh.current = false; }
  else if (!wasActive.current) { wasActive.current = true; entryFresh.current = false; }
  if (admissionBlocked) entryFresh.current = false;
  const loseAccess = useCallback(() => {
    epoch.current++; impactReadGeneration.current++; invalidateCheck(); inputRevision.current++; read.current?.abort(); previewRead.current?.abort(); impactRead.current?.abort(); listRef.current = null; entryFresh.current = false; projectRecheck.current = false;
    setList(null); setUnavailable(true); setDialog(null); setTyped(''); setPreview(null); setImpact(null); setProjects(null); setChecked(false); setObserved(null); unavailableCallback.current();
  }, []);
  useLayoutEffect(() => {
    if (!accessDenied) return;
    read.current?.abort(); previewRead.current?.abort(); impactRead.current?.abort(); checkRead.current?.abort(); checkRead.current = null;
    setList(null); setUnavailable(true); setDialog(null); setTyped(''); setPreview(null); setImpact(null); setProjects(null); if (!appLostDuringCheck) setChecked(false); setObserved(null);
  }, [accessDenied]);
  const confirmAppAccess = async (signal: AbortSignal, revision: number, onDenied?: () => void) => {
    try { await admission.ready(signal); await getGitHubApp(appId, signal, auth(admission, onIdentityMismatch)); await admission.ready(signal); return !signal.aborted && !admission.isInvalidated && revision === epoch.current; }
    catch (failure) { if (!signal.aborted && !admission.isInvalidated && revision === epoch.current && denied(failure)) { loseAccess(); onDenied?.(); return false; } throw failure; }
  };
  const load = useCallback(async (more: boolean) => {
    if (!active || admissionBlocked || accessDenied || admission.isInvalidated || more && !entryFresh.current) return;
    const prior = listRef.current; if (more && (!prior || prior.cursor === null)) return;
    read.current?.abort(); const controller = new AbortController(); read.current = controller;
    const signal = AbortSignal.any([controller.signal, admission.signal]);
    if (!prior || !entered.current || more) setLoading(true);
    try {
      let items: GitHubTeamGrant[] = [], cursor: string | null = null, pages = 0;
      const limit = more ? prior!.pages + 1 : Math.max(1, prior?.pages ?? 1);
      do {
        await admission.ready(signal); const page = await listGitHubAppGrants(appId, cursor, signal, auth(admission, onIdentityMismatch)); await admission.ready(signal);
        if (signal.aborted || admission.isInvalidated) return;
        items = [...items, ...page.items];
        if (new Set(items.map(item => item.id)).size !== items.length || new Set(items.map(item => item.team.id)).size !== items.length || page.nextCursor !== null && page.nextCursor === cursor) throw new ApiError('protocol');
        cursor = page.nextCursor; pages++;
      } while (pages < limit && cursor !== null);
      const counts = new Map<string, string | null>(); let next = 0, deniedCount = false;
      await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
        while (next < items.length) {
          const item = items[next++]!;
          try { await admission.ready(signal); const value = await getGitHubAppGrantImpact(appId, item.id, null, signal, auth(admission, onIdentityMismatch)); await admission.ready(signal); if (signal.aborted || admission.isInvalidated) return; const valid = value.teams.length === 1 && value.teams[0]!.team.id === item.team.id && value.nextCursor === null; if (valid) observeCountImpact(item.id, value); counts.set(item.id, valid ? value.totalProjects : null); }
          catch (failure) { if (!signal.aborted && !admission.isInvalidated) { try { await admission.ready(signal); } catch { return; } if (!signal.aborted && !admission.isInvalidated) { if (denied(failure)) { deniedCount = true; observeCountImpact(item.id, null); } counts.set(item.id, null); } } }
        }
      }));
      if (deniedCount) { await admission.ready(signal); await getGitHubApp(appId, signal, auth(admission, onIdentityMismatch)); }
      await admission.ready(signal);
      if (signal.aborted || admission.isInvalidated) return;
      const value = { items, cursor, pages, counts }; entered.current = true; entryFresh.current = true; listRef.current = value; setList(value); setError(null); setUnavailable(false);
    } catch (failure) { if (!signal.aborted && !admission.isInvalidated) { try { await admission.ready(signal); } catch { return; } if (!signal.aborted && !admission.isInvalidated) { if (denied(failure)) loseAccess(); setError(failure); } } }
    finally { if (read.current === controller) { read.current = null; if (!signal.aborted && !admission.isInvalidated) setLoading(false); } }
  }, [active, admissionBlocked, accessDenied, admission, appId, onIdentityMismatch, loseAccess]);
  useEffect(() => { if (!active || admissionBlocked || accessDenied) return; void load(false); return () => { read.current?.abort(); previewRead.current?.abort(); impactRead.current?.abort(); setPreviewing(false); setImpactLoading(false); }; }, [active, admissionBlocked, accessDenied, load]);
  useTeamForeground(active && !admissionBlocked && !accessDenied && !unavailable, () => { void load(false); if (dialog?.kind === 'revoke') void loadImpact(dialog.grant, true); });
  const close = () => { epoch.current++; impactReadGeneration.current++; invalidateCheck(); impactObservation.current++; impactView.current = { dialog: null, impact: null }; inputRevision.current++; previewRead.current?.abort(); impactRead.current?.abort(); setDialog(null); setTyped(''); setPreview(null); setImpact(null); setProjects(null); setDialogError(null); setInvalid(false); setChanged(false); projectCursor.current = null; projectsFresh.current = false; projectRecheck.current = false; if (op.result?.kind !== 'unknown') { op.clear(); target.current = null; setChecked(false); setAppLostDuringCheck(false); setObserved(null); } };
  const openGrant = () => { if (op.guarded() || op.publishing() || admissionBlocked || !entryFresh.current) return; op.clear(); target.current = null; setTyped(''); setPreview(null); setDialogError(null); setInvalid(false); setChanged(false); setNotice(null); setDialog({ kind: 'grant' }); };
  const changeInput = (value: string) => { inputRevision.current++; previewRead.current?.abort(); setPreviewing(false); setTyped(value); setPreview(null); setDialogError(null); setInvalid(false); setChanged(false); };
  const verify = () => {
    if (!active || admissionBlocked || accessDenied || unavailable || !entryFresh.current || dialog?.kind !== 'grant' || op.guarded()) return;
    const teamId = canonicalId(typed); if (teamId === null) { setInvalid(true); setPreview(null); return; }
    const revision = inputRevision.current, owner = epoch.current, controller = new AbortController(); previewRead.current?.abort(); previewRead.current = controller;
    const signal = AbortSignal.any([controller.signal, admission.signal]); setPreviewing(true); setPreview(null); setDialogError(null); setInvalid(false);
    void (async () => { try {
      await admission.ready(signal); const value = await previewGitHubAppGrant(appId, teamId, signal, auth(admission, onIdentityMismatch)); await admission.ready(signal);
      if (!signal.aborted && !admission.isInvalidated && epoch.current === owner && inputRevision.current === revision) { setPreview(value); setChanged(false); }
    } catch (failure) { if (!signal.aborted && !admission.isInvalidated && epoch.current === owner && inputRevision.current === revision) { try { if (denied(failure) && !await confirmAppAccess(signal, owner)) return; if (!signal.aborted && epoch.current === owner && inputRevision.current === revision) setDialogError(failure); } catch (recheckFailure) { if (!signal.aborted && epoch.current === owner && inputRevision.current === revision) setDialogError(recheckFailure); } } }
    finally { if (previewRead.current === controller) { previewRead.current = null; if (!signal.aborted) setPreviewing(false); } } })();
  };
  const submitGrant = () => {
    if (!active || admissionBlocked || accessDenied || unavailable || !entryFresh.current || dialog?.kind !== 'grant' || !preview || preview.grant !== null || canonicalId(typed) !== preview.targetTeam.id || op.guarded() || changed) return;
    const id = crypto.randomUUID(), revision = epoch.current, selected = preview; target.current = id; operationSequence.current++;
    void op.run((signal, dispatched) => createGitHubAppGrant(appId, { id, version: selected.version, teamId: selected.targetTeam.id, teamVersion: selected.targetTeam.version }, signal, auth(admission, onIdentityMismatch, dispatched)), () => {
      if (onResult?.('granted') ?? activeRef.current) setNotice('granted'); if (revision !== epoch.current) return; setDialog(null); setTyped(''); setPreview(null); target.current = null; if (activeRef.current) void load(false);
    }, failure => { if (revision !== epoch.current) return; if (conflict(failure)) { setChanged(true); setPreview(null); } else if (denied(failure)) void load(false); });
  };
  const loadImpact = async (item: GitHubTeamGrant, preserveVisible = false) => {
    if (!active || admissionBlocked || accessDenied || unavailable || !entryFresh.current) return;
    impactRead.current?.abort(); const controller = new AbortController(); impactRead.current = controller; impactReadGeneration.current++;
    const signal = AbortSignal.any([controller.signal, admission.signal]), revision = epoch.current, observation = impactObservation.current;
    setImpactLoading(true); setDialogError(null); if (preserveVisible && projects && projectsFresh.current) projectRecheck.current = true; else projectsFresh.current = false;
    try {
      await admission.ready(signal); const value = await getGitHubAppGrantImpact(appId, item.id, null, signal, auth(admission, onIdentityMismatch)); await admission.ready(signal);
      if (!signal.aborted && !admission.isInvalidated && epoch.current === revision && observation === impactObservation.current) {
        if (value.nextCursor !== null || value.teams.length !== 1 || value.teams[0]!.team.id !== item.team.id) throw new ApiError('protocol');
        const changedImpact = impact !== null && (impact.version !== value.version || impact.impactVersion !== value.impactVersion || impact.hiddenProjects !== value.hiddenProjects);
        if (changedImpact) { setProjects(null); projectsFresh.current = false; projectCursor.current = null; projectRecheck.current = false; }
        setImpact(value); setChanged(changedImpact); if (projectRecheck.current) setProjectCheckRevision(value => value + 1);
      }
    } catch (failure) { if (!signal.aborted && !admission.isInvalidated && epoch.current === revision) { projectRecheck.current = false; if (!preserveVisible || denied(failure) || conflict(failure) || failure instanceof ApiError && failure.kind === 'protocol') { setImpact(null); setProjects(null); projectsFresh.current = false; } try { if (denied(failure) && !await confirmAppAccess(signal, revision)) return; if (!signal.aborted && epoch.current === revision) { setDialogError(failure); setChanged(true); } } catch (recheckFailure) { if (!signal.aborted && epoch.current === revision) { setDialogError(recheckFailure); setChanged(true); } } } }
    finally { if (impactRead.current === controller) { impactRead.current = null; if (!signal.aborted) setImpactLoading(false); } }
  };
  useEffect(() => { if (active && !admissionBlocked && !accessDenied && entryFresh.current && dialog?.kind === 'revoke' && !impact && !changed && !op.pending && !op.result) void loadImpact(dialog.grant); }, [active, admissionBlocked, accessDenied, list]);
  const openRevoke = (item: GitHubTeamGrant) => { if (!active || admissionBlocked || op.guarded() || op.publishing() || !entryFresh.current) return; op.clear(); projectRecheck.current = false; setNotice(null); setDialogError(null); setChanged(false); setDialog({ kind: 'revoke', grant: item }); target.current = item.id; void loadImpact(item); };
  const loadProjects = async (more = false, preserveVisible = false) => {
    if (!active || admissionBlocked || accessDenied || unavailable || !entryFresh.current || dialog?.kind !== 'revoke' || !impact || more && (!projects || projects.nextCursor === null)) return;
    impactRead.current?.abort(); const controller = new AbortController(); impactRead.current = controller; const generation = ++impactReadGeneration.current;
    const signal = AbortSignal.any([controller.signal, admission.signal]), revision = epoch.current, observation = impactObservation.current, grant = dialog.grant;
    if (!preserveVisible) projectsFresh.current = false; setImpactLoading(true); setProjectError(false);
    try {
      const cursor = more ? projects!.nextCursor : projectCursor.current;
      await admission.ready(signal); const value = await listGitHubAppGrantImpactProjects(appId, grant.id, cursor, signal, auth(admission, onIdentityMismatch));
      await verifyImpactProjects(value.items, { signal, ready: next => admission.ready(next), read: (projectId, next) => getProjectAccess(projectId, next, auth(admission, onIdentityMismatch)), isDenied: denied, isCurrent: () => !admission.isInvalidated && epoch.current === revision && observation === impactObservation.current && generation === impactReadGeneration.current, onDenied: () => { setProjects(null); setImpact(null); setChanged(true); projectsFresh.current = false; projectCursor.current = null; setProjectError(true); } });
      const summary = await getGitHubAppGrantImpact(appId, grant.id, null, signal, auth(admission, onIdentityMismatch)); await admission.ready(signal);
      if (signal.aborted || admission.isInvalidated || epoch.current !== revision || observation !== impactObservation.current) return;
      if (value.nextCursor !== null && value.nextCursor === cursor || value.hiddenProjects !== summary.hiddenProjects || summary.version !== impact.version || summary.impactVersion !== impact.impactVersion || summary.nextCursor !== null || summary.teams.length !== 1 || summary.teams[0]!.team.id !== grant.team.id) { setProjects(null); setImpact(null); setChanged(true); setProjectError(true); return; }
      projectCursor.current = cursor; projectsFresh.current = true; setProjects(value);
    } catch (failure) { if (!signal.aborted && !admission.isInvalidated && epoch.current === revision) { if (!preserveVisible || denied(failure) || conflict(failure) || failure instanceof ApiError && failure.kind === 'protocol') { setProjects(null); setImpact(null); projectsFresh.current = false; projectCursor.current = null; } setChanged(true); setProjectError(true); try { if (denied(failure)) await confirmAppAccess(signal, revision); } catch (recheckFailure) { if (!signal.aborted && epoch.current === revision) setDialogError(recheckFailure); } } }
    finally { if (impactRead.current === controller) { impactRead.current = null; if (!signal.aborted) setImpactLoading(false); } }
  };
  useEffect(() => { if (active && !admissionBlocked && !accessDenied && !unavailable && entryFresh.current && dialog?.kind === 'revoke' && impact && projects && (!projectsFresh.current || projectRecheck.current) && !impactLoading && impactRead.current === null && !op.pending && !op.result) { const preserveVisible = projectsFresh.current; projectRecheck.current = false; void loadProjects(false, preserveVisible); } }, [active, admissionBlocked, accessDenied, unavailable, dialog, impact, projects, impactLoading, projectCheckRevision, op.pending, op.result, list]);
  const submitRevoke = () => {
    if (!active || admissionBlocked || accessDenied || unavailable || !entryFresh.current || dialog?.kind !== 'revoke' || !impact || impactLoading || projectRecheck.current || changed || op.guarded()) return;
    const item = dialog.grant, revision = epoch.current, snapshot = impact; target.current = item.id; operationSequence.current++;
    void op.run((signal, dispatched) => revokeGitHubAppGrant(appId, item.id, { version: snapshot.version, impactVersion: snapshot.impactVersion }, signal, auth(admission, onIdentityMismatch, dispatched)), () => {
      if (onResult?.('revoked') ?? activeRef.current) setNotice('revoked'); if (revision !== epoch.current) return; setDialog(null); setImpact(null); setProjects(null); target.current = null; if (activeRef.current) void load(false);
    }, failure => { if (revision !== epoch.current) return; if (conflict(failure) || denied(failure)) { setChanged(true); setImpact(null); setProjects(null); if (denied(failure) && activeRef.current) void load(false); } });
  };
  const check = () => {
    if (!target.current || admissionBlocked || admission.isInvalidated) return;
    if (accessDenied || unavailable) { setAppLostDuringCheck(true); setChecked(true); setObserved(null); setDialog(null); return; }
    if (!entryFresh.current) return;
    invalidateCheck(); const id = target.current, revision = epoch.current, sequence = operationSequence.current, checkOwner = checkRevision.current, controller = new AbortController(); checkRead.current = controller;
    const signal = AbortSignal.any([controller.signal, admission.signal]);
    const owns = () => !signal.aborted && !admission.isInvalidated && epoch.current === revision && operationSequence.current === sequence && target.current === id && checkRevision.current === checkOwner && checkRead.current === controller;
    void (async () => { try { await admission.ready(signal); const value = await getGitHubAppGrant(appId, id, signal, auth(admission, onIdentityMismatch)); await admission.ready(signal); if (owns()) { setAppLostDuringCheck(false); setObserved(value); setChecked(true); } }
    catch (failure) { if (owns()) { try { if (denied(failure)) { if (!await confirmAppAccess(signal, revision, () => { if (operationSequence.current === sequence && target.current === id && !admission.isInvalidated) { setAppLostDuringCheck(true); setObserved(null); setChecked(true); } })) return; if (owns()) { setAppLostDuringCheck(false); setObserved(null); setChecked(true); } } else setDialogError(failure); } catch (recheckFailure) { if (owns()) setDialogError(recheckFailure); } } }
    finally { if (checkRead.current === controller) checkRead.current = null; } })();
  };
  const review = () => { if (!active || admissionBlocked || accessDenied || unavailable || !entryFresh.current) return; if (op.result?.kind === 'unknown') { check(); return; } if (dialog?.kind === 'grant') { setChanged(false); setPreview(null); setDialogError(null); } else if (dialog?.kind === 'revoke') { void loadImpact(dialog.grant, true); } };
  const unknown = op.result?.kind === 'unknown';
  const reviewCallbacks = useRef({ onUnknownReviewChange, check, finish: () => {} });
  const reviewAlive = useRef(true);
  reviewCallbacks.current = { onUnknownReviewChange, check, finish: () => { if (!unknown || (!checked && !accessDenied && !unavailable)) return; invalidateCheck(); op.clear(); target.current = null; setChecked(false); setAppLostDuringCheck(false); setObserved(null); setDialog(null); } };
  useEffect(() => {
    if (!unknown) { reviewCallbacks.current.onUnknownReviewChange?.(null); return; }
    const sequence = operationSequence.current, id = target.current;
    const owned = () => reviewAlive.current && !admission.isInvalidated && !admission.signal.aborted && id !== null && target.current === id && operationSequence.current === sequence;
    const canFinish = checked || accessDenied || unavailable;
    reviewCallbacks.current.onUnknownReviewChange?.({ state: appLostDuringCheck || accessDenied || unavailable ? 'app-unavailable' : 'unknown', check: () => { if (owned()) reviewCallbacks.current.check(); }, finish: canFinish ? () => { if (owned()) reviewCallbacks.current.finish(); } : null });
  }, [unknown, checked, appLostDuringCheck, accessDenied, unavailable]);
  useEffect(() => { reviewAlive.current = true; return () => { reviewAlive.current = false; invalidateCheck(); reviewCallbacks.current.onUnknownReviewChange?.(null); }; }, []);
  const publicationCallbacks = useRef({ onPublicationErrorChange, retry: op.retryPublication });
  publicationCallbacks.current = { onPublicationErrorChange, retry: op.retryPublication };
  useEffect(() => {
    const error = op.publicationError;
    publicationCallbacks.current.onPublicationErrorChange?.(error ? { confirmed: op.outcome === 'confirmed', unavailable: accessDenied || unavailable, retry: error.retryable ? () => publicationCallbacks.current.retry() : null } : null);
  }, [op.publicationError, op.outcome, accessDenied, unavailable]);
  useEffect(() => () => publicationCallbacks.current.onPublicationErrorChange?.(null), []);
  const rendered = active && entered.current && !unavailable && !accessDenied;
  return <section className="panel github-grants">
    <header className="panel-heading"><div><h2>{m.title}</h2><p>{m.subtitle}</p></div><button className="button primary" type="button" disabled={!rendered || op.guarded() || op.publicationPending} aria-disabled={admissionBlocked || !entryFresh.current} onClick={openGrant}>{m.grant}</button></header>
    {receipt ? <div className="notice" role="status"><p>{m[receipt.result]}</p><button className="button" type="button" onClick={receipt.dismiss}>{zh ? '关闭' : 'Dismiss'}</button></div> : notice && <p className="notice" role="status">{m[notice]}</p>}
    {!dialog && <OperationPublicationError operation={op} zh={zh} />}
    {error !== null && <div className="notice error" role="alert">{unavailable ? m.appUnavailable : m.failed} <button type="button" className="button" onClick={() => void load(false)}>{m.retry}</button></div>}
    {loading && !rendered && <p className="empty-inline" role="status">{m.loading}</p>}
    {unknown && !dialog && <div className="notice warning" role="alert">{m.unknown} <button className="button" type="button" onClick={check}>{m.review}</button>{checked && <><p>{appLostDuringCheck ? m.unknownAppUnavailable : <>{m.checked} {observed ? <>{m.observed}: <TeamLabel team={observed.team} zh={zh} /> (<code>{observed.team.id}</code>)</> : m.absent}</>}</p><button className="button" type="button" onClick={() => { invalidateCheck(); op.clear(); target.current = null; setChecked(false); setAppLostDuringCheck(false); setObserved(null); }}>{m.dismiss}</button></>}</div>}
    {rendered && list && (list.items.length === 0 ? <div className="empty-inline"><strong>{m.empty}</strong><p>{m.emptyHint}</p></div> : <ul className="github-grants-list">{list.items.map(item => <li key={item.id}><div><strong className={item.team.kind === 'personal' ? 'github-grants-personal-label' : undefined}>{teamLabel(item.team, zh)}</strong><p><code>{item.team.id}</code></p></div><span>{list.counts.get(item.id) == null ? m.countUnavailable : `${list.counts.get(item.id)} ${m.connections}`}</span><button className="button danger" type="button" disabled={op.guarded() || op.publicationPending} aria-disabled={admissionBlocked || !entryFresh.current} onClick={() => openRevoke(item)}>{m.revoke}</button></li>)}</ul>)}
    {rendered && list?.cursor && <div className="github-grants-more"><button className="button" type="button" disabled={loading} aria-disabled={admissionBlocked || !entryFresh.current} onClick={() => void load(true)}>{m.more}</button></div>}<p className="github-grants-help">{m.help}</p>
    {dialog && <ManagementDialog preserveFocus title={dialog.kind === 'grant' ? m.grantTitle : m.revokeTitle} busy={op.pending} suspended={!rendered} onClose={close} initialFocus={dialog.kind === 'revoke' ? 'cancel' : 'input'} footer={<><button className="button" type="button" data-dialog-cancel disabled={op.pending} onClick={close}>{unknown ? m.close : m.cancel}</button>{unknown || changed ? <button className="button" type="button" aria-disabled={admissionBlocked || !entryFresh.current} onClick={review}>{m.review}</button> : dialog.kind === 'grant' ? <button className="button primary github-grant-action" type="button" disabled={op.pending || op.publicationPending || previewing || !preview || preview.grant !== null} aria-disabled={admissionBlocked || !entryFresh.current} onClick={submitGrant}>{op.pending ? m.submitting : m.grantConfirm}</button> : <button className="button danger github-grant-action" type="button" disabled={op.pending || op.publicationPending || !impact} aria-disabled={admissionBlocked || !entryFresh.current || impactLoading || projectRecheck.current} onClick={submitRevoke}>{op.pending ? m.submitting : m.revokeConfirm}</button>}</>}>
      {dialog.kind === 'grant' ? <><div className="field"><label htmlFor={`grant-team-${appId}`}>{m.teamId}</label><div className="github-grants-team-input"><input id={`grant-team-${appId}`} value={typed} disabled={op.pending || unknown} spellCheck={false} autoCapitalize="off" onChange={event => changeInput(event.target.value)} /><button className="button github-grant-action" type="button" disabled={op.pending || unknown || previewing} aria-disabled={admissionBlocked || !entryFresh.current} onClick={verify}>{previewing ? m.verifying : m.verify}</button></div></div>{invalid && <p className="notice error" role="alert">{m.invalid}</p>}{preview && <div className="github-grants-target"><strong className={preview.targetTeam.kind === 'personal' ? 'github-grants-personal-label' : undefined}>{teamLabel(preview.targetTeam, zh)}</strong><p>{preview.targetTeam.kind === 'personal' ? m.personal : m.ordinary}</p><code>{preview.targetTeam.id}</code>{preview.grant && <p>{m.existing}</p>}</div>}<p>{m.grantHint}</p></> : <><div className="github-grants-target"><strong className={dialog.grant.team.kind === 'personal' ? 'github-grants-personal-label' : undefined}>{teamLabel(dialog.grant.team, zh)}</strong><p><code>{dialog.grant.team.id}</code></p></div><p>{m.revokeHint}</p>{impactLoading && !impact && <p role="status">{m.loading}</p>}{impact && <><p><strong>{m.impact}: {impact.totalProjects}</strong></p><ImpactProjects hiddenProjects={impact.hiddenProjects} page={projectsFresh.current ? projects : null} blocked={impactLoading || admissionBlocked || !entryFresh.current || projectRecheck.current} labels={m} onRead={() => void loadProjects()} onMore={() => void loadProjects(true)} /></>}{projectError && <p className="notice error" role="alert">{m.projectChanged}</p>}</>}
      {dialogError !== null && <div className="notice error" role="alert">{denied(dialogError) ? m.unavailable : conflict(dialogError) ? m.conflict : m.rejected}</div>}{op.result && <div className="notice error" role="alert">{unknown ? m.unknown : conflict(op.result.error) ? m.conflict : m.rejected}</div>}{changed && <div className="notice warning" role="alert">{m.conflict}</div>}{checked && <><p className="github-grants-observed" role="status">{m.checked} {observed ? <>{m.observed}: <TeamLabel team={observed.team} zh={zh} /> (<code>{observed.team.id}</code>)</> : m.absent}</p>{unknown && <button className="button" type="button" onClick={() => { invalidateCheck(); op.clear(); target.current = null; setChecked(false); setAppLostDuringCheck(false); setObserved(null); close(); }}>{m.dismiss}</button>}</>}<OperationPublicationError operation={op} zh={zh} />
    </ManagementDialog>}
  </section>;
};
