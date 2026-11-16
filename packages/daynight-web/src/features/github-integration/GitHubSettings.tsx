import { NativeSelect } from '../../ui/native-select/NativeSelect';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, isAbortError } from '../../api/client';
import { connectGitHub, disconnectGitHub, discoverGitHubInstallation, getGitHubStatus, getGitHubPullRequestCounts, saveGitHubSettings, updateGitHubSync, type GitHubInstallationCandidate, type GitHubPullRequestCounts, type GitHubStatus } from '../../api/github-integration';
import { useI18n } from '../../i18n/LocaleProvider';
import { ManagementDialog } from '../management/ManagementDialog';
import type { ProjectManagementGuard } from '../management/ProjectManagementGuard';
import { useProjectAccess } from '../projects/ProjectAccess';
import './github-settings.css';

const copy = {
  'zh-CN': {
    syncLabel: 'PR 同步', syncDescription: '周期轮询与 Webhook 更新', syncEnabledLabel: '已启用', syncDisabledLabel: '已关闭', syncOff: '同步已关闭', syncOffDetail: '已保存的数据仍可读取，暂不会更新。', connectRequired: '连接仓库后可启用同步。', serviceRequired: '服务配置 GitHub App 后可启用同步。', accessRequired: '恢复仓库授权后可启用同步。', historicalPollError: '最近一次轮询尝试失败', historicalHookError: '最近一次 Webhook 更新失败',
    title: 'GitHub PR 同步', subtitle: '同步此仓库的 PR 基本信息与 description。', repo: '项目仓库', private: '私有', public: '公开', unknown: '未知', connected: '已连接', not_connected: '未连接', unavailable: '授权不可用', disconnected: '已断开', initial: '首次同步', unconfigured: '服务尚未配置 GitHub App。', member: '你可以查看同步状态。连接、同步开关和间隔配置由项目管理员维护。', connect: '连接 GitHub App', reconnect: '重新连接', disconnect: '断开连接', emptyTitle: '连接仓库', emptyBody: '通过 GitHub App 连接此仓库，随后可手动开启 PR 同步。', syncing: '正在同步', healthy: '同步正常', stopped: '同步已停止', retained: '已有数据仍保留。', noComplete: '首次完整同步完成后才能确认活跃 PR 集合。', poll: '周期轮询', complete: '完整核对', webhook: 'GitHub Webhook', events: '事件更新', running: '进行中', stoppedChannel: '已停止', ready: '已就绪', lastReceived: '最近接收', channelAttempt: '最近尝试', channelSuccess: '最近成功', next: '下次尝试', never: '尚无', lastSuccess: '最近完整同步成功', lastAttempt: '最近一次轮询尝试', installation: '连接的 App 安装', interval: '轮询间隔', minutes: '分钟', hint: '默认 5 分钟。Webhook 事件到达后触发更新，不受此间隔影响。', invalid: '请输入 1 至 2147483647 之间的整数分钟。', save: '保存间隔', saving: '保存中…', cancel: '取消', unsaved: '有未保存的更改。', saved: '轮询间隔已保存。', connectionSaved: '连接设置已更新。', close: '关闭', scope: '同步范围', open: '全部 open PR，包含 Draft', fields: '基本信息与 description', keep: '关闭、合并后保留已有记录', shared: '同步的 PR 数据将按此 Project 的权限共享，有权访问项目的成员均可读取。', target: '项目仓库', candidate: '可用的 App 安装', candidateHint: '选择能够读取此仓库 PR 的安装。', discovering: '正在查找可用安装…', connectBusy: '连接中…', disconnectTitle: '断开 GitHub 连接？', disconnectBody: '此项目将停止接收 PR 更新。已同步的数据会保留，之后可以重新连接并继续同步。', disconnectDetail: '不会卸载 GitHub App，也不会影响其他项目。', disconnectBusy: '断开中…', retry: '重试', readError: '无法读取 GitHub 同步状态。', discoverError: '无法查找可用的 App 安装。', writeError: '操作未完成，请检查错误后重试。', conflict: '配置已更改。请核对重新读取的状态；未保存的输入仍保留。', uncertain: '写入结果未知。请检查重新读取的状态后再决定是否重试。', current: '当前已保存', pollError: '轮询暂时失败', hookError: 'Webhook 更新暂时失败', permission: 'GitHub App 无法读取此仓库。请恢复授权或重新连接。', noData: '尚未连接', loading: '正在读取 GitHub 同步状态…', accessChanged: '权限已变更，请重新检查。', errorCode: '原因', activeCount: '活跃 PR', retainedCount: '保留记录', countError: '无法读取已保存 PR 的数量。', emptySuccess: '最近一次完整同步确认没有 open PR。', draftConflict: '配置在编辑期间已更改。请核对当前值后再采用最新版本。', acceptVersion: '采用最新版本并保留输入',
  },
  en: {
    syncLabel: 'PR sync', syncDescription: 'Periodic polling and Webhook updates', syncEnabledLabel: 'Enabled', syncDisabledLabel: 'Disabled', syncOff: 'Sync off', syncOffDetail: 'Saved data remains readable and will not be updated.', connectRequired: 'Connect a repository to enable sync.', serviceRequired: 'Configure the GitHub App on this service to enable sync.', accessRequired: 'Restore repository access to enable sync.', historicalPollError: 'Last polling attempt failed', historicalHookError: 'Last webhook update failed',
    title: 'GitHub PR sync', subtitle: 'Sync PR information and descriptions for this repository.', repo: 'Project repository', private: 'Private', public: 'Public', unknown: 'Unknown', connected: 'Connected', not_connected: 'Not connected', unavailable: 'Access unavailable', disconnected: 'Disconnected', initial: 'First sync', unconfigured: 'GitHub App is not configured on this service.', member: 'You can view sync status. Project administrators manage the connection, sync switch and interval.', connect: 'Connect GitHub App', reconnect: 'Reconnect', disconnect: 'Disconnect', emptyTitle: 'Connect a repository', emptyBody: 'Connect this repository with a GitHub App, then enable PR sync when ready.', syncing: 'Syncing', healthy: 'Sync healthy', stopped: 'Sync stopped', retained: 'Previously saved data is retained.', noComplete: 'The active PR collection is unknown until a full sync completes.', poll: 'Periodic polling', complete: 'Full reconciliation', webhook: 'GitHub Webhook', events: 'Event updates', running: 'Running', stoppedChannel: 'Stopped', ready: 'Ready', lastReceived: 'Last received', channelAttempt: 'Last attempt', channelSuccess: 'Last success', next: 'Next attempt', never: 'None yet', lastSuccess: 'Last complete sync', lastAttempt: 'Last poll attempt', installation: 'Connected App installation', interval: 'Poll interval', minutes: 'minutes', hint: 'Defaults to 5 minutes. Webhook events trigger updates independently of this interval.', invalid: 'Enter a whole number from 1 to 2147483647 minutes.', save: 'Save interval', saving: 'Saving…', cancel: 'Cancel', unsaved: 'You have unsaved changes.', saved: 'Poll interval saved.', connectionSaved: 'Connection settings updated.', close: 'Close', scope: 'Sync scope', open: 'All open PRs, including drafts', fields: 'Basic information and descriptions', keep: 'Closed and merged records are retained', shared: 'Synced PR data is shared under this Project’s permissions and can be read by its members.', target: 'Project repository', candidate: 'Available App installation', candidateHint: 'Choose an installation that can read this repository’s PRs.', discovering: 'Finding an available installation…', connectBusy: 'Connecting…', disconnectTitle: 'Disconnect GitHub?', disconnectBody: 'This Project will stop receiving PR updates. Saved data is retained and can be synced again after reconnecting.', disconnectDetail: 'The GitHub App will not be uninstalled and other Projects are unaffected.', disconnectBusy: 'Disconnecting…', retry: 'Retry', readError: 'Unable to read GitHub sync status.', discoverError: 'Unable to find an available App installation.', writeError: 'The operation did not complete. Check the error before retrying.', conflict: 'The configuration changed. Check the reread status; your draft is retained.', uncertain: 'The write outcome is unknown. Check the reread status before deciding whether to retry.', current: 'Currently saved', pollError: 'Polling temporarily failed', hookError: 'Webhook update temporarily failed', permission: 'The GitHub App cannot read this repository. Restore access or reconnect.', noData: 'Not connected', loading: 'Loading GitHub sync status…', accessChanged: 'Access changed. Please check again.', errorCode: 'Reason', activeCount: 'Active PRs', retainedCount: 'Retained records', countError: 'Unable to read saved PR counts.', emptySuccess: 'The last complete sync found no open PRs.', draftConflict: 'The configuration changed while you were editing. Review the current value before using the latest version.', acceptVersion: 'Use latest version and keep draft',
  },
} as const;

type Props = { readonly projectId: string; readonly userId: string; readonly repoUrl: string | null; readonly active: boolean; readonly onRoute: boolean; readonly onRetentionChange?: ((retain: boolean) => void) | undefined; readonly onStateChange?: ((state: { dirty: boolean; pending: boolean; needsAttention: boolean }) => void) | undefined; readonly presentationGeneration?: number | undefined; readonly guard: ProjectManagementGuard };
type Dialog = 'connect' | 'disconnect' | null;
type Feedback = 'saved' | 'conflict' | 'uncertain' | 'writeError' | 'accessChanged' | null;
const minutes = (value: string): number | null => {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 1 && n <= 2_147_483_647 ? n : null;
};

export const GitHubSettings = ({ projectId, userId, repoUrl, active, onRoute, onRetentionChange, onStateChange, presentationGeneration, guard }: Props) => {
  const { locale, format } = useI18n();
  const m = copy[locale];
  const access = useProjectAccess(projectId);
  const session = access.session;
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [counts, setCounts] = useState<GitHubPullRequestCounts | null>(null);
  const [countError, setCountError] = useState(false);
  const [draft, setDraft] = useState('');
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [readError, setReadError] = useState<unknown>(null);
  const [operationError, setOperationError] = useState<unknown>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [completedDialog, setCompletedDialog] = useState(false);
  const dialogRef = useRef<Dialog>(null), dialogIdentity = useRef(0), completedIdentity = useRef<number | null>(null);
  const retireDialog = () => { dialogIdentity.current++; dialogRef.current = null; completedIdentity.current = null; setCompletedDialog(false); setDialog(null); };
  const beginDialog = (kind: Exclude<Dialog, null>) => {
    if (dialogRef.current !== kind) { dialogIdentity.current++; completedIdentity.current = null; setCompletedDialog(false); }
    dialogRef.current = kind; setDialog(kind);
  };
  const [candidate, setCandidate] = useState<GitHubInstallationCandidate | null>(null);
  const [discoveryError, setDiscoveryError] = useState<unknown>(null);
  const [discovering, setDiscovering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [needsRead, setNeedsRead] = useState(false);
  const [confirmedPending, setConfirmedPending] = useState(false);
  const [draftConflict, setDraftConflict] = useState(false);
  const statusRef = useRef<GitHubStatus | null>(null);
  const draftRef = useRef('');
  const dirtyRef = useRef(false);
  const draftRevision = useRef(0);
  const draftVersion = useRef<string | null>(null);
  const sequence = useRef(0);
  const readAbort = useRef<AbortController | null>(null);
  const operation = useRef<AbortController | null>(null);
  const writing = useRef(false);
  const writingKind = useRef<'save' | 'connect' | 'disconnect' | 'sync' | null>(null);
  const unresolved = useRef(false);
  const revoked = useRef(false);
  const dispatchedRef = useRef(false);
  const confirmedRef = useRef(false);
  const confirmedSyncFloor = useRef<{ floor: bigint; previous: string } | null>(null);
  const confirmedSave = useRef<{ value: string; revision: number; floor: bigint } | null>(null);
  const routeRef = useRef(onRoute);
  const previousDialog = useRef<Dialog>(null);
  const focusAfterSave = useRef(false);
  routeRef.current = onRoute;
  const alive = useRef(true);
  const activeRef = useRef(active);
  activeRef.current = active;
  const presentationRef = useRef(presentationGeneration);
  presentationRef.current = presentationGeneration;
  const role = access.status === 'ready' ? access.access?.effectiveRole : null;
  const admin = role === 'admin';
  const admission = { userId, onPrincipalMismatch: session.scope.principalMismatch };
  const setDraftValue = (value: string) => { draftRef.current = value; setDraft(value); };
  const clearPrivate = useCallback(() => {
    ++sequence.current; readAbort.current?.abort(); if (!dispatchedRef.current) operation.current?.abort();
    statusRef.current = null; dirtyRef.current = false; draftVersion.current = null; setDraftConflict(false); setStatus(null); setCounts(null); setCountError(false); setDraftValue('');
    setCandidate(null); dialogIdentity.current++; dialogRef.current = null; completedIdentity.current = null; setCompletedDialog(false); setDialog(null); setReadError(null);
    if (writing.current && dispatchedRef.current) { unresolved.current = true; setNeedsRead(true); setConfirmedPending(confirmedRef.current); setFeedback(confirmedRef.current ? writingKind.current === 'save' ? 'saved' : null : 'uncertain'); }
    else if (!unresolved.current) { setOperationError(null); setFeedback(null); setNeedsRead(false); }
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; ++sequence.current; readAbort.current?.abort(); operation.current?.abort(); guard.release('github'); };
  }, [guard]);
  useEffect(() => {
    if (previousDialog.current !== null && dialog === null && active && onRoute && document.activeElement === document.body) {
      (document.getElementById('github-connection-action') ?? document.getElementById('github-settings-title'))?.focus();
    }
    previousDialog.current = dialog;
  }, [dialog, active, onRoute]);
  useEffect(() => { if (!busy && focusAfterSave.current) { focusAfterSave.current = false; if (active && onRoute) document.getElementById('github-poll-interval')?.focus(); } }, [busy, active, onRoute]);
  useLayoutEffect(() => { onRetentionChange?.(busy || needsRead || completedDialog); }, [busy, needsRead, completedDialog, onRetentionChange]);
  useEffect(() => {
    if (!onRoute) { readAbort.current?.abort(); ++sequence.current; if (!dispatchedRef.current) operation.current?.abort(); }
    else if (active && needsRead) void loadRef.current(true);
  }, [onRoute, active, needsRead]);
  useEffect(() => session.scope.subscribe((event) => { if (event.projectId === projectId && event.accessRevoked) { revoked.current = true; clearPrivate(); } }), [session, projectId, clearPrivate]);
  useEffect(() => {
    if (session.scope.isInvalidated) { clearPrivate(); unresolved.current = false; setNeedsRead(false); setConfirmedPending(false); guard.release('github'); }
    else if (access.status === 'unavailable') clearPrivate();
    else if (role !== null && role !== 'admin') { if (dialogRef.current !== null) retireDialog(); setCandidate(null); }
  }, [access.status, role, session, session.scope.isInvalidated, guard, clearPrivate]);

  const load = useCallback(async (reconcile = false) => {
    if (writing.current && !reconcile) return false;
    if (!activeRef.current || !routeRef.current || session.scope.isInvalidated || session.scope.hasIdentityMismatch) return false;
    readAbort.current?.abort();
    const controller = new AbortController(); readAbort.current = controller;
    const signal = AbortSignal.any([controller.signal, session.scope.signal, session.scope.mismatchSignal]);
    const ticket = ++sequence.current;
    try {
      await session.scope.ready(signal);
      if (await session.waitForFreshAccess(signal, true) === null) return false;
      const [next, countResult] = await Promise.all([
        getGitHubStatus(projectId, signal, { userId, onPrincipalMismatch: session.scope.principalMismatch }),
        getGitHubPullRequestCounts(projectId, signal, { userId, onPrincipalMismatch: session.scope.principalMismatch }).then(value => ({ value, error: null }), error => ({ value: null, error })),
      ]);
      if (countResult.error instanceof ApiError && (countResult.error.status === 403 || countResult.error.status === 404)) { void session.revalidate(); throw countResult.error; }
      await session.scope.ready(signal);
      const admitted = await session.waitForFreshAccess(signal, true);
      if (!alive.current || signal.aborted || ticket !== sequence.current || admitted === null || !activeRef.current || !routeRef.current || session.scope.isProjectSuspended(projectId)) return false;
      const old = statusRef.current;
      if (old !== null && (BigInt(next.revision) < BigInt(old.revision) || BigInt(next.version) < BigInt(old.version))) return false;
      if (confirmedSyncFloor.current !== null && BigInt(next.version) < confirmedSyncFloor.current.floor) { setReadError(new Error('Older than confirmed configuration')); return false; }
      if (confirmedSave.current !== null && BigInt(next.version) < confirmedSave.current.floor) { setReadError(new Error('Older than confirmed configuration')); return false; }
      revoked.current = false; statusRef.current = next; setStatus(next);
      setCounts(countResult.value !== null && countResult.value.revision === next.revision ? countResult.value : null);
      setCountError(countResult.error !== null);
      if (confirmedSave.current !== null && BigInt(next.version) === confirmedSave.current.floor && next.pollIntervalMinutes === Number(confirmedSave.current.value)) {
        if (draftRevision.current === confirmedSave.current.revision) { dirtyRef.current = false; draftVersion.current = null; setDraftConflict(false); }
        else { draftVersion.current = next.version; setDraftConflict(false); }
      }
      if (confirmedSyncFloor.current !== null && BigInt(next.version) === confirmedSyncFloor.current.floor && dirtyRef.current && draftVersion.current === confirmedSyncFloor.current.previous) draftVersion.current = next.version;
      confirmedSave.current = null; confirmedSyncFloor.current = null;
      if (!dirtyRef.current) setDraftValue(String(next.pollIntervalMinutes));
      else if (draftVersion.current !== null && draftVersion.current !== next.version) setDraftConflict(true);
      unresolved.current = false; if (!writing.current) guard.release('github'); setReadError(null); setNeedsRead(false); setConfirmedPending(false); return true;
    } catch (error) {
      if (!alive.current || signal.aborted || ticket !== sequence.current || isAbortError(error)) return false;
      if (error instanceof ApiError && error.status === 404) { clearPrivate(); void session.revalidate(); }
      else setReadError(error);
      return false;
    } finally { if (readAbort.current === controller) readAbort.current = null; }
  }, [projectId, userId, session, guard, clearPrivate]);
  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => {
    if (!active || !onRoute || access.status !== 'ready') return;
    void load();
    const refresh = () => { if (document.visibilityState !== 'hidden') void load(); };
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    const timer = window.setInterval(refresh, 30_000);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); window.clearInterval(timer); readAbort.current?.abort(); ++sequence.current; };
  }, [active, onRoute, access.status, load]);

  const openConnect = async () => {
    if (!admin || busy || !onRoute || guard.isBlocked('github') || needsRead || !statusRef.current?.serviceAvailable) return;
    beginDialog('connect'); setCandidate(null); setDiscoveryError(null); setDiscovering(true);
    const controller = new AbortController(); operation.current = controller;
    const signal = AbortSignal.any([controller.signal, session.scope.signal, session.scope.mismatchSignal]);
    try {
      await session.scope.ready(signal);
      const fresh = await session.waitForFreshAccess(signal, true);
      if (fresh?.effectiveRole !== 'admin') throw new Error('Access changed');
      const found = await discoverGitHubInstallation(projectId, signal, admission);
      const current = await session.waitForFreshAccess(signal, true);
      if (!signal.aborted && alive.current && current?.effectiveRole === 'admin') setCandidate(found);
    } catch (error) { if (!signal.aborted && alive.current && !isAbortError(error)) setDiscoveryError(error); }
    finally { if (operation.current === controller) operation.current = null; if (alive.current) setDiscovering(false); }
  };
  const closeDialog = () => { if (busy) return; operation.current?.abort(); setDiscovering(false); setCandidate(null); retireDialog(); };
  const run = async (kind: 'save' | 'connect' | 'disconnect' | 'sync') => {
    const saved = statusRef.current;
    const submittedDraft = draftRef.current, submittedRevision = draftRevision.current;
    const parsed = minutes(submittedDraft);
    if (!saved || !admin || busy || !onRoute || needsRead || kind === 'save' && draftConflict || kind === 'save' && parsed === null || kind === 'connect' && (candidate === null || !saved.serviceAvailable) || (kind === 'connect' || kind === 'disconnect') && completedIdentity.current === dialogIdentity.current || kind === 'sync' && !saved.syncEnabled && (!saved.serviceAvailable || saved.connection !== 'connected') || !guard.tryAcquire('github')) return;
    const controller = new AbortController(); operation.current = controller;
    const signal = AbortSignal.any([controller.signal, session.scope.signal, session.scope.mismatchSignal]);
    let dispatched = false, rejected = false;
    const submittedPresentation = presentationGeneration, submittedDialog = dialogIdentity.current;
    const confirmDialog = () => {
      if ((kind === 'connect' || kind === 'disconnect') && dialogIdentity.current === submittedDialog && dialogRef.current === kind) { completedIdentity.current = submittedDialog; setCompletedDialog(true); }
    };
    if (kind === 'save') focusAfterSave.current = true;
    onRetentionChange?.(true);
    writing.current = true; writingKind.current = kind; dispatchedRef.current = false; confirmedRef.current = false; setBusy(true); setFeedback(null); setOperationError(null);
    ++sequence.current; readAbort.current?.abort();
    try {
      await session.scope.ready(signal);
      const fresh = await session.waitForFreshAccess(signal, true);
      if (fresh?.effectiveRole !== 'admin' || !activeRef.current) { setFeedback('accessChanged'); return; }
      const args = { ...admission, onDispatch: () => { dispatched = true; dispatchedRef.current = true; }, onWriteConfirmed: () => { confirmedRef.current = true; confirmDialog(); if (kind === 'save') confirmedSave.current = { value: submittedDraft, revision: submittedRevision, floor: BigInt(saved.version) + (parsed === saved.pollIntervalMinutes ? 0n : 1n) }; else if (kind === 'sync') confirmedSyncFloor.current = { floor: BigInt(saved.version) + 1n, previous: saved.version }; }, onWriteRejected: () => { rejected = true; } };
      const next = kind === 'save' ? await saveGitHubSettings(projectId, { version: draftVersion.current ?? saved.version, pollIntervalMinutes: parsed! }, signal, args)
        : kind === 'connect' ? await connectGitHub(projectId, { version: saved.version, installationId: candidate!.installation.id }, signal, args)
          : kind === 'disconnect' ? await disconnectGitHub(projectId, { version: saved.version }, signal, args)
            : await updateGitHubSync(projectId, { version: saved.version, syncEnabled: !saved.syncEnabled }, signal, args);
      confirmDialog();
      const current = await session.waitForFreshAccess(signal, true);
      if (signal.aborted || !alive.current || current === null || revoked.current || !activeRef.current || !routeRef.current || presentationRef.current !== submittedPresentation || session.scope.isProjectSuspended(projectId)) { if (alive.current) { focusAfterSave.current = false; unresolved.current = true; setNeedsRead(true); setConfirmedPending(true); setFeedback(kind === 'save' && draftRevision.current === submittedRevision ? 'saved' : null); } return; }
      if (statusRef.current === null || BigInt(next.revision) >= BigInt(statusRef.current.revision)) { statusRef.current = next; setStatus(next); }
      setCounts(null);
      if (kind === 'save') {
        confirmedSave.current = null; setDraftConflict(false);
        if (draftRevision.current === submittedRevision) { dirtyRef.current = false; draftVersion.current = null; setDraftValue(String(next.pollIntervalMinutes)); setFeedback('saved'); }
        else { draftVersion.current = next.version; setFeedback(null); focusAfterSave.current = false; }
      }
      else if (kind === 'sync') { confirmedSyncFloor.current = null; if (dirtyRef.current && !draftConflict && draftVersion.current === saved.version) draftVersion.current = next.version; }
      else if (dialogIdentity.current === submittedDialog) retireDialog();
    } catch (error) {
      if (!alive.current) return;
      if (signal.aborted && !dispatched) return;
      if (session.scope.isInvalidated) return;
      if (session.scope.hasIdentityMismatch) { if (dispatched) { unresolved.current = true; setNeedsRead(true); setConfirmedPending(confirmedRef.current); setFeedback(confirmedRef.current ? kind === 'save' && draftRevision.current === submittedRevision ? 'saved' : null : 'uncertain'); } return; }
      const conflict = error instanceof ApiError && error.status === 409 && (kind === 'sync' || error.code === 'version_conflict');
      const uncertain = dispatched && (!rejected || !(error instanceof ApiError) || error.kind !== 'server' || error.status === null || error.status >= 500 || error.code === 'github_write_outcome_unknown');
      setOperationError(error); setFeedback(confirmedRef.current ? kind === 'save' && draftRevision.current === submittedRevision ? 'saved' : null : conflict ? 'conflict' : uncertain ? 'uncertain' : 'writeError');
      if (confirmedRef.current || conflict || uncertain || error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        unresolved.current = true; setNeedsRead(true); setConfirmedPending(confirmedRef.current);
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) void session.revalidate();
        await load(true);
      }
    } finally { writing.current = false; writingKind.current = null; dispatchedRef.current = false; confirmedRef.current = false; if (operation.current === controller) operation.current = null; if (!unresolved.current || session.scope.isInvalidated) guard.release('github'); if (alive.current) { setBusy(false); if (statusRef.current !== null && !signal.aborted) void load(); } }
  };

  const shown = status;
  const dirty = shown !== null && draft !== String(shown.pollIntervalMinutes);
  const invalid = minutes(draft) === null;
  const syncOperational = shown !== null && shown.syncEnabled && shown.serviceAvailable && shown.connection === 'connected';
  const needsAttention = readError !== null || operationError !== null || discoveryError !== null || countError || dirty && invalid || draftConflict || needsRead && !confirmedPending || shown?.connection === 'unavailable' || Boolean(syncOperational && (shown?.poll.error || shown?.webhook.error));
  const summaryPending = busy || confirmedPending;
  useLayoutEffect(() => { onStateChange?.({ dirty, pending: summaryPending, needsAttention }); }, [dirty, summaryPending, needsAttention, onStateChange]);
  const blocked = busy || needsRead || session.scope.hasIdentityMismatch || session.scope.isInvalidated || !admin || !active || !onRoute || !access.ready || guard.isBlocked('github');
  const labelTime = (value: string | null) => value === null ? m.never : format.dateTime(value);
  const stopped = !shown?.serviceAvailable || shown?.connection === 'unavailable' || shown?.connection === 'disconnected';
  const syncReason = shown?.syncEnabled ? null : shown?.connection === 'not_connected' || shown?.connection === 'disconnected' ? m.connectRequired : !shown?.serviceAvailable ? m.serviceRequired : shown?.connection === 'unavailable' ? m.accessRequired : null;
  const badge = shown === null ? m.unknown : shown.syncEnabled && shown.serviceAvailable && shown.initializing && shown.connection === 'connected' ? m.initial : m[shown.connection];
  const description = repoUrl ?? m.unknown;
  const knownCounts = counts !== null && (!shown?.initializing || counts.counts.all !== '0');
  return <section className="panel github-settings" aria-labelledby="github-settings-title">
    <div className="panel-heading github-settings-heading"><div><h2 id="github-settings-title" tabIndex={-1}>{m.title}</h2><p>{m.subtitle}</p></div>{shown !== null && <span className={`badge ${shown.connection === 'connected' ? 'success' : shown.connection === 'unavailable' ? 'danger' : ''}`}>{badge}</span>}</div>
    <div className="panel-body">
      {readError !== null && <div className="notice error" role="alert"><p>{m.readError}</p><button className="button" type="button" onClick={() => { void load(); }}>{m.retry}</button></div>}
      {shown === null ? readError === null && <p role="status">{m.loading}</p> : <>
        {!shown.serviceAvailable && <div className="notice warning">{m.unconfigured}</div>}
        {!admin && role === 'member' && <p className="github-member-hint">{m.member}</p>}
        <div className="github-repository"><div><span className="small-label">{m.repo}</span><div className="github-repository-name"><strong>{shown.repository?.fullName ?? description}</strong>{shown.repository?.private != null && <span className="badge">{shown.repository.private ? m.private : m.public}</span>}</div></div>
          {admin && <div className="github-repository-actions">{shown.serviceAvailable && (shown.connection === 'disconnected' || shown.connection === 'unavailable') && <button id={shown.connection === 'disconnected' ? 'github-connection-action' : undefined} className="button primary" type="button" disabled={blocked} onClick={() => { void openConnect(); }}>{m.reconnect}</button>}{(shown.connection === 'connected' || shown.connection === 'unavailable') && <button id="github-connection-action" className="button quiet" type="button" disabled={blocked} onClick={() => beginDialog('disconnect')}>{m.disconnect}</button>}</div>}
        </div>
        {shown.connection === 'not_connected' ? <div className="github-empty"><div><h3>{m.emptyTitle}</h3><p>{m.emptyBody}</p></div>{admin && shown.serviceAvailable && <button id="github-connection-action" className="button primary" type="button" disabled={blocked} onClick={() => { void openConnect(); }}>{m.connect}</button>}</div> : null}
        <div className="github-sync-control"><div><strong id="github-sync-label">{m.syncLabel}</strong><p>{m.syncDescription}</p>{syncReason !== null && <p id="github-sync-reason" className="hint">{syncReason}</p>}</div>{admin ? <button className="task-automation-switch" type="button" role="switch" aria-labelledby="github-sync-label" aria-describedby={syncReason === null ? undefined : 'github-sync-reason'} aria-checked={shown.syncEnabled} aria-busy={busy && writingKind.current === 'sync'} aria-disabled={busy || needsRead || undefined} disabled={session.scope.hasIdentityMismatch || session.scope.isInvalidated || !active || !onRoute || !access.ready || guard.isBlocked('github') || syncReason !== null} onClick={() => { void run('sync'); }}><span aria-hidden="true" /></button> : <span className="github-sync-readonly">{shown.syncEnabled ? m.syncEnabledLabel : m.syncDisabledLabel}</span>}</div>
        {shown.connection !== 'not_connected' && <>
          <div className="github-overview"><div><strong>{!shown.syncEnabled ? m.syncOff : stopped ? m.stopped : shown.initializing || shown.poll.running ? m.syncing : shown.poll.error ? m.pollError : shown.webhook.error ? m.hookError : m.healthy}</strong><p>{!shown.syncEnabled ? m.syncOffDetail : stopped ? m.retained : shown.initializing ? m.noComplete : knownCounts && counts.counts.active === '0' && shown.poll.lastSuccessAt !== null ? m.emptySuccess : ''}</p></div>{knownCounts && <div className="github-counts"><div><strong>{counts.counts.active}</strong><span>{m.activeCount}</span></div><div><strong>{(BigInt(counts.counts.closed) + BigInt(counts.counts.merged)).toString()}</strong><span>{m.retainedCount}</span></div></div>}</div>{countError && <p className="hint error" role="alert">{m.countError}</p>}
          <div className="github-channels"><div><div className="github-channel-heading"><strong>{m.poll}</strong><span>{m.complete}</span></div><p>{!shown.syncEnabled || stopped ? m.stoppedChannel : shown.poll.running ? m.running : shown.poll.error ? m.pollError : `${shown.pollIntervalMinutes} ${m.minutes}`}</p><p>{m.channelAttempt}: {labelTime(shown.poll.lastAttemptAt)}</p><p>{m.channelSuccess}: {labelTime(shown.poll.lastSuccessAt)}</p><p>{m.next}: {labelTime(shown.poll.nextAttemptAt)}</p></div><div><div className="github-channel-heading"><strong>{m.webhook}</strong><span>{m.events}</span></div><p>{!shown.syncEnabled || stopped ? m.stoppedChannel : shown.webhook.running ? m.running : shown.webhook.error ? m.hookError : m.ready}</p><p>{m.lastReceived}: {labelTime(shown.webhook.lastReceivedAt)}</p><p>{m.channelAttempt}: {labelTime(shown.webhook.lastAttemptAt)}</p><p>{m.channelSuccess}: {labelTime(shown.webhook.lastSuccessAt)}</p></div></div>
          <dl className="github-details"><div><dt>{m.lastSuccess}</dt><dd>{labelTime(shown.poll.lastSuccessAt)}</dd></div><div><dt>{m.lastAttempt}</dt><dd>{labelTime(shown.poll.lastAttemptAt)}</dd></div><div><dt>{m.installation}</dt><dd>{shown.installation?.accountLogin ?? m.never}</dd></div></dl>
          {shown.connection === 'unavailable' && <div className="notice error" role="alert">{m.permission}</div>}
          {shown.poll.error && <div className={syncOperational ? 'notice warning' : 'notice'} role={syncOperational ? 'alert' : undefined}><strong>{syncOperational ? m.pollError : m.historicalPollError}</strong><p>{shown.poll.error.message} ({shown.poll.error.code})</p></div>}
          {shown.webhook.error && <div className={syncOperational ? 'notice warning' : 'notice'} role={syncOperational ? 'alert' : undefined}><strong>{syncOperational ? m.hookError : m.historicalHookError}</strong><p>{shown.webhook.error.message} ({shown.webhook.error.code})</p></div>}
        </>}
        {feedback !== null && feedback !== 'saved' && <div className="notice warning" role="alert"><p>{m[feedback]}</p>{operationError instanceof ApiError && <p>{m.errorCode}: {operationError.code}</p>}{needsRead && <button className="button" type="button" onClick={() => { void load(); }}>{m.retry}</button>}</div>}
        <div className="github-settings-grid"><form className="poll-setting" noValidate onSubmit={(event) => { event.preventDefault(); void run('save'); }}>{draftConflict && admin && <div className="notice warning" role="alert"><p>{m.draftConflict}</p><p>{m.current}: {shown.pollIntervalMinutes} {m.minutes}</p><button className="button" type="button" disabled={blocked} onClick={() => { draftVersion.current = shown.version; setDraftConflict(false); }}>{m.acceptVersion}</button></div>}<div className="field"><label htmlFor="github-poll-interval">{m.interval}</label>{admin ? <div className="number-unit"><input id="github-poll-interval" type="number" min="1" max="2147483647" step="1" value={draft} aria-invalid={invalid || undefined} aria-describedby="github-poll-hint github-poll-error" onChange={(event) => { draftRevision.current++; if (!dirtyRef.current) draftVersion.current = shown.version; setDraftValue(event.target.value); dirtyRef.current = true; setFeedback(null); }} /><span>{m.minutes}</span></div> : <div id="github-poll-interval">{shown.pollIntervalMinutes} {m.minutes}</div>}<p className="hint" id="github-poll-hint">{m.hint}</p><p className="hint error" id="github-poll-error" role="alert" hidden={!invalid}>{m.invalid}</p></div>
          {admin && <><div className="settings-actions"><button className="button primary" type="submit" disabled={blocked || !dirty || invalid || draftConflict}>{busy ? m.saving : m.save}</button><button className="button" type="button" disabled={busy || !dirty && !draftConflict} onClick={() => { draftRevision.current++; dirtyRef.current = false; draftVersion.current = null; setDraftConflict(false); setDraftValue(String(shown.pollIntervalMinutes)); setFeedback(null); document.getElementById('github-poll-interval')?.focus(); }}>{m.cancel}</button></div><p className={`settings-state${feedback === 'saved' ? ' success' : ''}`} role="status">{feedback === 'saved' ? m.saved : dirty ? m.unsaved : ''}</p></>}</form>
          <div className="github-scope"><h3>{m.scope}</h3><ul><li>{m.open}</li><li>{m.fields}</li><li>{m.keep}</li></ul><p>{m.shared}</p></div></div>
      </>}
    </div>
    {dialog === 'connect' && <ManagementDialog title={m.connect} suspended={!active || !onRoute} busy={busy} onClose={closeDialog} footer={<><button className="button" type="button" data-dialog-cancel disabled={busy} onClick={closeDialog}>{completedDialog ? m.close : m.cancel}</button><button className="button primary" type="button" disabled={blocked || completedDialog || !shown?.serviceAvailable || discovering || candidate === null} onClick={() => { void run('connect'); }}>{busy ? m.connectBusy : m.connect}</button></>}>
      {completedDialog && <p role="status">{m.connectionSaved}</p>}
      <div className="github-dialog-target"><span className="small-label">{m.target}</span><strong>{candidate?.repository.fullName ?? shown?.repository?.fullName ?? description}</strong>{candidate?.repository.private != null && <span className="badge">{candidate.repository.private ? m.private : m.public}</span>}</div>
      {discovering ? <p role="status">{m.discovering}</p> : discoveryError !== null ? <div className="notice error" role="alert"><p>{m.discoverError}</p>{discoveryError instanceof ApiError && <p>{m.errorCode}: {discoveryError.code}</p>}<button className="button" type="button" onClick={() => { void openConnect(); }}>{m.retry}</button></div> : candidate !== null && <div className="field"><label htmlFor="github-installation">{m.candidate}</label><NativeSelect layout="fill" id="github-installation" value={candidate.installation.id} disabled={busy} onChange={() => {}}><option value={candidate.installation.id}>{candidate.installation.accountLogin}</option></NativeSelect><p className="hint">{m.candidateHint}</p></div>}
      <div className="notice">{m.shared}</div>{feedback !== null && feedback !== 'saved' && <div className="notice warning" role="alert">{m[feedback]}{operationError instanceof ApiError && <p>{m.errorCode}: {operationError.code}</p>}{needsRead && <button className="button" type="button" onClick={() => { void load(); }}>{m.retry}</button>}</div>}
    </ManagementDialog>}
    {dialog === 'disconnect' && <ManagementDialog title={m.disconnectTitle} suspended={!active || !onRoute} initialFocus="cancel" busy={busy} onClose={closeDialog} footer={<><button className="button" type="button" data-dialog-cancel disabled={busy} onClick={closeDialog}>{completedDialog ? m.close : m.cancel}</button><button className="button danger" type="button" disabled={blocked || completedDialog} onClick={() => { void run('disconnect'); }}>{busy ? m.disconnectBusy : m.disconnect}</button></>}>{completedDialog && <p role="status">{m.connectionSaved}</p>}<p>{m.disconnectBody}</p><p>{m.disconnectDetail}</p>{feedback !== null && feedback !== 'saved' && <div className="notice warning" role="alert">{m[feedback]}{operationError instanceof ApiError && <p>{m.errorCode}: {operationError.code}</p>}{needsRead && <button className="button" type="button" onClick={() => { void load(); }}>{m.retry}</button>}</div>}</ManagementDialog>}
  </section>;
};
