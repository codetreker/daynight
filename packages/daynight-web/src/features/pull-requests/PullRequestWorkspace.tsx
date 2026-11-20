import { NativeSelect } from '../../ui/native-select/NativeSelect';
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import type { ApiError } from '../../api/client';
import { navigate } from '../../app/router';
import { useI18n } from '../../i18n/LocaleProvider';
import { PullRequestDetailDialog } from '../pull-request-detail/PullRequestDetailDialog';
import type { PullRequestRepository, PullRequestState } from './api';
import { usePullRequests } from './usePullRequests';
import { usePullRequestAuthors } from './usePullRequestAuthors';
import { PullRequestAuthorPicker } from './PullRequestAuthorPicker';
import './pull-requests.css';

const en = {
  title: 'Pull requests', refresh: 'Refresh', refreshing: 'Refreshing…',
  source: 'Repository source', current: 'Current repository', history: 'Historical source', sourceFailed: 'Could not read repository sources.', filter: 'Pull request status', search: 'Search pull request title or number', placeholder: 'Search title or #number',
  active: 'Active', merged: 'Merged', closed: 'Closed', all: 'All', draft: 'Draft', open: 'Open', unknown: 'Unknown',
  authorMissing: 'Author unavailable', sourceMissing: 'Source repository or branch unavailable', repositoryMissing: 'Repository unavailable', branchMissing: 'Branch unavailable',
  updated: 'Updated', count: 'pull requests', includesDraft: 'Includes Draft', previous: 'Previous', next: 'Next', page: 'Page', of: 'of',
  settings: 'View sync settings', connected: 'Connected', success: 'Last complete sync', webhook: 'Last webhook update',
  syncOff: 'Sync is off. Saved pull requests remain readable but will not be updated.',
  historicalPollError: 'The last polling attempt failed.', historicalWebhookError: 'The last webhook update failed.',
  initializing: 'Initial synchronization is in progress. Saved records remain available.',
  disconnected: 'GitHub is disconnected. Previously saved pull requests are retained.',
  unavailable: 'GitHub access is unavailable. Updates have stopped; saved pull requests are retained.',
  pollError: 'Polling temporarily failed. Showing saved records; synchronization will retry automatically.',
  webhookError: 'Webhook processing temporarily failed. Saved records are retained; processing will retry automatically.',
  serviceUnavailable: 'GitHub integration is not configured on this service. Saved pull requests remain readable.',
  statusError: 'Could not read synchronization status.', failed: 'Could not read pull requests. Previously saved data has not been deleted.',
  retry: 'Retry', loading: 'Loading pull requests…', noConnection: 'GitHub is not connected',
  noConnectionDetail: 'Connect this project’s GitHub repository to read synchronized pull requests.',
  initialTitle: 'Initial synchronization in progress', initialDetail: 'The complete active pull request collection is being read.',
  emptyTitle: 'No pull requests', emptyDetail: 'The latest complete synchronization succeeded. No saved pull requests match this filter.',
  noAuthorMatchesDetail: 'Try a different creator, status, or search.', clearAuthor: 'Clear creator',
  noMatches: 'No matching pull requests', noMatchesDetail: 'Try another title or pull request number.', clear: 'Clear search',
  noSaved: 'No saved pull requests in this view', noSavedDetail: 'No records currently match this status.',
  range: 'Showing',
};
const zh: typeof en = {
  title: 'PR 列表', refresh: '刷新', refreshing: '正在刷新…',
  source: '仓库来源', current: '当前仓库', history: '历史来源', sourceFailed: '无法读取仓库来源。', filter: 'PR 状态', search: '搜索 PR 标题或编号', placeholder: '搜索标题或 #编号',
  active: '活跃', merged: '已合并', closed: '已关闭', all: '全部', draft: 'Draft', open: 'Open', unknown: '未知',
  authorMissing: '作者不可用', sourceMissing: '来源仓库或分支不可用', repositoryMissing: '仓库不可用', branchMissing: '分支不可用',
  updated: '更新于', count: '个 PR', includesDraft: '包含 Draft', previous: '上一页', next: '下一页', page: '页码', of: '/',
  settings: '查看同步设置', connected: '已连接', success: '最近完整同步成功', webhook: '最近 Webhook 更新',
  syncOff: '同步已关闭，已有 PR 仍可读取，暂不会更新。',
  historicalPollError: '最近一次轮询尝试失败。', historicalWebhookError: '最近一次 Webhook 更新失败。',
  initializing: '正在首次完整同步，已有记录继续保留。', disconnected: 'GitHub 连接已断开，以下为保留的数据。',
  unavailable: 'GitHub 授权不可用，更新已停止，已有 PR 数据继续保留。',
  pollError: '轮询暂时失败，以下为最近保存的数据。系统将自动重试。',
  webhookError: 'Webhook 处理暂时失败，已有数据继续保留。系统将自动重试。',
  serviceUnavailable: '服务尚未配置 GitHub 集成，已有 PR 数据仍可读取。',
  statusError: '无法读取同步状态。', failed: '暂时无法读取 PR，已有数据不会因此删除。', retry: '重试', loading: '正在读取 PR…',
  noConnection: '尚未连接 GitHub', noConnectionDetail: '连接此项目的 GitHub 仓库后，即可查看已同步的 PR。',
  initialTitle: '正在首次同步', initialDetail: '完整读取仓库的活跃 PR，完成后会在这里显示。',
  emptyTitle: '暂无 PR', emptyDetail: '最近一次完整同步已成功，当前没有符合条件的 PR。',
  noAuthorMatchesDetail: '试试其他创建者、状态或搜索条件。', clearAuthor: '清除创建者',
  noMatches: '没有找到匹配的 PR', noMatchesDetail: '试试其他标题或 PR 编号。', clear: '清除搜索',
  noSaved: '没有符合条件的 PR', noSavedDetail: '此状态下还没有已保存的记录。', range: '显示',
};
const filters: readonly PullRequestState[] = ['active', 'merged', 'closed', 'all'];

export type PullRequestWorkspaceProps = {
  readonly userId: string;
  readonly projectId: string;
  readonly active: boolean;
  readonly canRead: boolean;
  readonly repositories: readonly PullRequestRepository[]; readonly currentRepositoryId: string | null; readonly repositoryId: string | null;
  readonly setRepositoryId: (repositoryId: string) => void; readonly sourceLoading: boolean; readonly sourceLoaded: boolean; readonly sourceError: ApiError | null; readonly retrySources: () => void;
  readonly onScrollReady?: (ready: boolean) => void;
  readonly onPrincipalMismatch: () => void;
  readonly onAccessError?: (error: ApiError) => void;
};

const PullRequestIcon = ({ tone }: { readonly tone: string }) => <svg className={`pr-status-icon ${tone}`} width="18" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="19" r="2" /><path d="M6 7v10M11 5h3a4 4 0 0 1 4 4v8M11 5l3-3M11 5l3 3" />{tone === 'merged' && <path d="M11 12h7" />}</svg>;

const Workspace = (props: PullRequestWorkspaceProps) => {
  const { locale, format } = useI18n(), m = locale === 'zh-CN' ? zh : en;
  const read = usePullRequests(props), { status, page } = read;
  const authors = usePullRequestAuthors({ userId: props.userId, projectId: props.projectId, active: props.active, scope: read.scope, repositoryId: props.repositoryId });
  const workspace = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (read.author === null) return;
    const latest = authors.items.find(author => author.id === read.author?.id);
    if (latest !== undefined) read.setAuthor(latest);
  }, [authors.items, read.author, read.setAuthor]);
  const accessDenied = read.scope.isRevoked() || [read.error, read.statusError].some(error => error !== null && (
    error.code === 'principal_mismatch' || error.status === 401 || error.kind === 'server' && (error.status === 403 || error.status === 404)
  ));
  const loading = (read.loading || !props.sourceLoaded && props.sourceLoading) && !accessDenied;
  const scrollReady = props.active && props.canRead && !accessDenied && page !== null && status !== null && !loading && read.error === null && read.statusError === null;
  useLayoutEffect(() => { props.onScrollReady?.(scrollReady); }, [props.onScrollReady, scrollReady]);
  const [selected, setSelected] = useState<{ repositoryId: string; number: string } | null>(null);
  useLayoutEffect(() => { setSelected(null); }, [props.repositoryId]);
  useLayoutEffect(() => read.scope.subscribe(() => setSelected(null)), [read.scope]);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const search = useRef<HTMLInputElement | null>(null);
  useEffect(() => { if (!props.canRead || accessDenied) setSelected(null); }, [props.canRead, accessDenied]);
  const settings = `/projects/${props.projectId}/settings`;
  const settingsClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); navigate(settings);
  };
  const settingsLink = <a href={settings} onClick={settingsClick}>{m.settings}</a>;
  const projectTotal = read.projectTotal;
  const selectedCurrent = props.repositoryId !== null && props.repositoryId === props.currentRepositoryId;
  const visibleStatus = selectedCurrent && status?.repository?.id === props.repositoryId ? status : null;
  const connectedRepositoryId = status?.connection === 'connected' && status.repository?.id === props.currentRepositoryId ? props.currentRepositoryId : null;
  const known = projectTotal !== null && (BigInt(projectTotal) > 0n || props.repositoryId !== null && !selectedCurrent || visibleStatus !== null && !visibleStatus.initializing && visibleStatus.poll.lastSuccessAt !== null);
  const syncOperational = visibleStatus !== null && visibleStatus.syncEnabled && visibleStatus.serviceAvailable && visibleStatus.connection === 'connected';
  const primaryNote = visibleStatus === null ? null
    : !visibleStatus.syncEnabled ? { text: m.syncOff, danger: false }
      : !visibleStatus.serviceAvailable ? { text: m.serviceUnavailable, danger: false }
        : visibleStatus.connection === 'unavailable' ? { text: m.unavailable, danger: true }
          : visibleStatus.connection === 'disconnected' ? { text: m.disconnected, danger: false }
            : visibleStatus.connection === 'connected' && visibleStatus.initializing ? { text: m.initializing, danger: false }
              : null;
  const notes = visibleStatus === null ? [] : [
    ...(primaryNote === null ? [] : [primaryNote]),
    ...(visibleStatus.poll.error !== null ? [{ text: syncOperational ? m.pollError : m.historicalPollError, danger: false }] : []),
    ...(visibleStatus.webhook.error !== null ? [{ text: syncOperational ? m.webhookError : m.historicalWebhookError, danger: false }] : []),
  ];
  const empty = props.sourceError !== null && !props.sourceLoaded ? { title: m.sourceFailed, detail: '', retry: false }
    : read.error !== null || accessDenied ? { title: m.failed, detail: '', retry: true }
    : page === null && loading ? { title: m.loading, detail: '', retry: false }
      : read.author !== null && page !== null && known ? { title: m.noMatches, detail: m.noAuthorMatchesDetail, retry: false }
      : props.repositoryId === null && props.sourceLoaded || visibleStatus?.connection === 'not_connected' ? { title: m.noConnection, detail: m.noConnectionDetail, retry: false }
        : visibleStatus?.syncEnabled && visibleStatus.serviceAvailable && visibleStatus.connection === 'connected' && visibleStatus.initializing ? { title: m.initialTitle, detail: m.initialDetail, retry: false }
          : read.query !== '' ? { title: m.noMatches, detail: m.noMatchesDetail, retry: false }
            : known && page?.projectTotal === '0' ? { title: m.emptyTitle, detail: selectedCurrent ? m.emptyDetail : m.noSavedDetail, retry: false }
              : { title: m.noSaved, detail: m.noSavedDetail, retry: false };
  const pages = page === null ? 1n : (BigInt(page.total) + 5n) / 6n;
  const start = BigInt(read.pageNumber - 1) * 6n + 1n;
  const end = start + BigInt(page?.items.length ?? 0) - 1n;

  return <div className="pull-request-workspace" ref={workspace}>
    <div className="project-section-heading pr-heading"><div className="pr-title-line"><h2>{m.title}</h2>{visibleStatus?.connection === 'connected' && <span className="pr-connected">{m.connected}</span>}</div><button className="button" type="button" onClick={read.refresh} disabled={loading || !props.canRead || props.repositoryId === null} aria-busy={loading}><span aria-hidden="true">↻</span> {loading ? m.refreshing : m.refresh}</button></div>
    <div className="pr-sync-status">
      {notes.map(note => <div className={`pr-status-note${note.danger ? ' danger' : ''}`} role="status" key={note.text}>{note.text} {settingsLink}</div>)}
      {selectedCurrent && (status === null || visibleStatus !== null) && read.statusError !== null && <div className="pr-status-note danger" role="alert">{m.statusError} <button type="button" onClick={read.reconcile}>{m.retry}</button></div>}
      {visibleStatus?.poll.lastSuccessAt != null && <span>{m.success}: <time dateTime={visibleStatus.poll.lastSuccessAt}>{format.dateTime(visibleStatus.poll.lastSuccessAt)}</time></span>}
      {visibleStatus?.webhook.lastSuccessAt != null && <span>{m.webhook}: <time dateTime={visibleStatus.webhook.lastSuccessAt}>{format.dateTime(visibleStatus.webhook.lastSuccessAt)}</time></span>}
    </div>
    <div className="pr-toolbar"><div className="pr-filter-group"><div className="pr-filter-wrap pr-source-wrap"><label className="sr-only" htmlFor="pr-source">{m.source}</label><NativeSelect density="filter" focusTone="task" touchMode="responsive" layout="content" id="pr-source" value={props.repositoryId ?? ''} onChange={event => props.setRepositoryId(event.currentTarget.value)} disabled={!props.canRead || accessDenied || props.repositories.length === 0}>{props.repositories.length === 0 && <option value="">{m.noConnection}</option>}{props.repositories.map(repository => <option key={repository.repositoryId} value={repository.repositoryId}>{repository.fullName} · {repository.repositoryId === connectedRepositoryId ? m.current : m.history}</option>)}</NativeSelect></div><div className="pr-filter-wrap"><label className="sr-only" htmlFor="pr-filter">{m.filter}</label><NativeSelect density="filter" focusTone="task" layout="fill" id="pr-filter" value={read.filter} onChange={event => read.setFilter(event.currentTarget.value as PullRequestState)} disabled={!props.canRead || accessDenied || props.repositoryId === null}>{filters.map(filter => <option key={filter} value={filter}>{m[filter]}{known && read.counts !== null ? ` · ${read.counts[filter]}` : ''}</option>)}</NativeSelect></div><PullRequestAuthorPicker key={props.repositoryId ?? 'no-repository'} selected={read.author} items={authors.items} query={authors.query} loaded={authors.loaded} loading={authors.loading} error={authors.error} nextCursor={authors.nextCursor} rebuilding={authors.rebuilding} disabled={!props.canRead || accessDenied || props.repositoryId === null} active={props.active} owner={workspace} onOpen={authors.open} onClose={authors.close} onQueryChange={authors.setQuery} onLoadMore={authors.loadMore} onRetry={authors.retry} onSelect={read.setAuthor} /></div><div className="pr-search-wrap"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></svg><label className="sr-only" htmlFor="pr-search">{m.search}</label><input ref={search} id="pr-search" type="search" value={read.query} onChange={event => read.setQuery(event.currentTarget.value)} placeholder={m.placeholder} autoComplete="off" disabled={!props.canRead || accessDenied || props.repositoryId === null} /></div></div>
    {props.sourceError !== null && <p className="pr-status-note danger" role="alert">{m.sourceFailed} <button type="button" onClick={props.retrySources}>{m.retry}</button></p>}
    <div aria-live="polite">{known && page !== null && <p className="pr-results-count">{read.filter === 'active' ? `${m.includesDraft} · ` : ''}{page.total} {m.count}</p>}</div>
    {read.error !== null && page !== null && page.items.length > 0 && <p className="pr-status-note danger" role="alert">{m.failed} <button type="button" onClick={read.reconcile}>{m.retry}</button></p>}
    <ul className="pr-list" aria-label="Pull Request">{page?.items.map(item => {
      const tone = item.state === 'open' && item.draft ? 'draft' : item.state;
      const state = item.state === 'merged' ? m.merged : item.state === 'closed' ? m.closed : item.state === 'open' ? item.draft ? m.draft : m.open : m.unknown;
      const source = item.head.repositoryFullName === null && item.head.ref === null ? m.sourceMissing
        : `${item.head.repositoryFullName === item.base.repositoryFullName ? '' : `${item.head.repositoryFullName ?? m.repositoryMissing}:`}${item.head.ref ?? m.branchMissing}`;
      return <li key={item.number}><button className="pr-row" type="button" id={`pr-row-${item.number}`} aria-label={`#${item.number} ${item.title}, ${state}`} onClick={event => { trigger.current = event.currentTarget; if (props.repositoryId !== null) setSelected({ repositoryId: props.repositoryId, number: item.number }); }}><PullRequestIcon tone={tone} /><span className="pr-row-main"><span className="pr-row-heading"><span className="pr-row-title">{item.title}</span>{item.draft && item.state === 'open' && <span className="badge pr-row-badge draft">{m.draft}</span>}</span><span className="pr-row-meta"><span className="pr-row-number">#{item.number}</span><span>{item.author?.login ?? m.authorMissing}</span>{item.state !== 'open' && <span>{state}</span>}<span>{m.updated} <time dateTime={item.updatedAt}>{format.dateTime(item.updatedAt)}</time></span></span><span className="pr-row-branch"><code title={source}>{source}</code><span aria-hidden="true">→</span><code title={`${item.base.repositoryFullName}:${item.base.ref}`}>{item.base.ref}</code></span></span><span className="pr-row-time" aria-hidden="true">{format.date(item.updatedAt)}</span><span className="pr-chevron" aria-hidden="true">›</span></button></li>;
    })}</ul>
    {(page === null || page.items.length === 0) && <div className="pr-empty-state" role={read.error !== null || accessDenied ? 'alert' : 'status'}>{loading && page === null || empty.title === m.initialTitle ? <span className="spinner" aria-hidden="true" /> : <span className="pr-empty-icon" aria-hidden="true">⑂</span>}<h3>{empty.title}</h3>{empty.detail && <p>{empty.detail}</p>}{empty.retry && <button className="button" type="button" onClick={read.reconcile}>{m.retry}</button>}{props.sourceLoaded && props.repositoryId === null && read.author === null && settingsLink}{read.author !== null && page !== null && known && read.error === null && <button className="button" type="button" onClick={() => read.setAuthor(null)}>{m.clearAuthor}</button>}{read.query !== '' && read.error === null && <button className="button" type="button" onClick={() => { read.setQuery(''); search.current?.focus(); }}>{m.clear}</button>}</div>}
    {page !== null && (page.items.length > 0 || read.pageNumber > 1 || page.previousCursor !== null || page.nextCursor !== null) && <div className="list-pagination pr-pagination"><span>{page.items.length > 0 ? `${m.range} ${start}–${end} · ${page.total} ${m.count}` : `${page.total} ${m.count}`}</span><div className="list-pagination-controls"><button className="button" type="button" onClick={read.previous} disabled={loading || page.previousCursor === null}>{m.previous}</button><span className="list-pagination-page">{m.page} {read.pageNumber} {m.of} {pages > 0n ? pages.toString() : '1'}</span><button className="button" type="button" onClick={read.next} disabled={loading || page.nextCursor === null}>{m.next}</button></div></div>}
    {selected !== null && selected.repositoryId === props.repositoryId && props.canRead && !accessDenied && <PullRequestDetailDialog userId={props.userId} projectId={props.projectId} number={selected.number} repositoryId={selected.repositoryId} canRead={props.canRead} active={props.active} visible={props.active} onPrincipalMismatch={props.onPrincipalMismatch} {...(props.onAccessError === undefined ? {} : { onAccessError: props.onAccessError })} refreshKey={read.refreshKey} onClose={() => setSelected(null)} onRestoreFocus={() => {
      if (!props.active) return;
      const target = trigger.current;
      if (target?.isConnected && !target.closest('[hidden], [inert]')) target.focus({ preventScroll: true });
      else document.getElementById('project-section-tab-prs')?.focus({ preventScroll: true });
    }} />}
  </div>;
};

export const PullRequestWorkspace = (props: PullRequestWorkspaceProps) => <Workspace key={`${props.userId}/${props.projectId}`} {...props} />;
