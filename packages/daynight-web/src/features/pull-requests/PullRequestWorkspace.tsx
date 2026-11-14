import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { ApiError } from '../../api/client';
import { navigate } from '../../app/router';
import { useI18n } from '../../i18n/LocaleProvider';
import { PullRequestDetailDialog } from '../pull-request-detail/PullRequestDetailDialog';
import type { PullRequestState } from './api';
import { usePullRequests } from './usePullRequests';
import './pull-requests.css';

const en = {
  title: 'Pull requests', subtitle: 'Pull requests saved from this project’s repository', refresh: 'Refresh', refreshing: 'Refreshing…',
  filter: 'Pull request status', search: 'Search pull request title or number', placeholder: 'Search title or #number',
  active: 'Active', merged: 'Merged', closed: 'Closed', all: 'All', draft: 'Draft', open: 'Open', unknown: 'Unknown',
  authorMissing: 'Author unavailable', sourceMissing: 'Source repository or branch unavailable', repositoryMissing: 'Repository unavailable', branchMissing: 'Branch unavailable',
  updated: 'Updated', count: 'pull requests', includesDraft: 'Includes Draft', previous: 'Previous', next: 'Next', page: 'Page', of: 'of',
  settings: 'View sync settings', connected: 'GitHub connected', success: 'Last complete sync', webhook: 'Last webhook update',
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
  noMatches: 'No matching pull requests', noMatchesDetail: 'Try another title or pull request number.', clear: 'Clear search',
  noSaved: 'No saved pull requests in this view', noSavedDetail: 'No records currently match this status.',
  updates: 'New pull requests are available. Refresh to include them.', range: 'Showing',
};
const zh: typeof en = {
  title: 'PR 列表', subtitle: '此项目仓库中已同步的 Pull Request', refresh: '刷新', refreshing: '正在刷新…',
  filter: 'PR 状态', search: '搜索 PR 标题或编号', placeholder: '搜索标题或 #编号',
  active: '活跃', merged: '已合并', closed: '已关闭', all: '全部', draft: 'Draft', open: 'Open', unknown: '未知',
  authorMissing: '作者不可用', sourceMissing: '来源仓库或分支不可用', repositoryMissing: '仓库不可用', branchMissing: '分支不可用',
  updated: '更新于', count: '个 PR', includesDraft: '包含 Draft', previous: '上一页', next: '下一页', page: '页码', of: '/',
  settings: '查看同步设置', connected: 'GitHub 已连接', success: '最近完整同步成功', webhook: '最近 Webhook 更新',
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
  noMatches: '没有找到匹配的 PR', noMatchesDetail: '试试其他标题或 PR 编号。', clear: '清除搜索',
  noSaved: '没有符合条件的 PR', noSavedDetail: '此状态下还没有已保存的记录。', updates: '有新的 PR，刷新后可纳入当前列表。', range: '显示',
};
const filters: readonly PullRequestState[] = ['active', 'merged', 'closed', 'all'];

export type PullRequestWorkspaceProps = {
  readonly userId: string;
  readonly projectId: string;
  readonly active: boolean;
  readonly canRead: boolean;
  readonly onPrincipalMismatch: () => void;
  readonly onAccessError?: (error: ApiError) => void;
};

const PullRequestIcon = ({ tone }: { readonly tone: string }) => <svg className={`pr-status-icon ${tone}`} width="18" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="19" r="2" /><path d="M6 7v10M11 5h3a4 4 0 0 1 4 4v8M11 5l3-3M11 5l3 3" />{tone === 'merged' && <path d="M11 12h7" />}</svg>;

const Workspace = (props: PullRequestWorkspaceProps) => {
  const { locale, format } = useI18n(), m = locale === 'zh-CN' ? zh : en;
  const read = usePullRequests(props), { status, page, loading } = read;
  const accessDenied = [read.error, read.statusError].some(error => error !== null && (
    error.code === 'principal_mismatch' || error.status === 401 || error.kind === 'server' && (error.status === 403 || error.status === 404)
  ));
  const [selected, setSelected] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const search = useRef<HTMLInputElement | null>(null);
  useEffect(() => { if (!props.canRead || accessDenied) setSelected(null); }, [props.canRead, accessDenied]);
  const settings = `/projects/${props.projectId}/settings`;
  const settingsClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); navigate(settings);
  };
  const settingsLink = <a href={settings} onClick={settingsClick}>{m.settings}</a>;
  const known = page !== null && (BigInt(page.counts.all) > 0n || status !== null && !status.initializing && status.poll.lastSuccessAt !== null);
  const syncOperational = status !== null && status.syncEnabled && status.serviceAvailable && status.connection === 'connected';
  const primaryNote = status === null ? null
    : !status.syncEnabled ? { text: m.syncOff, danger: false }
      : !status.serviceAvailable ? { text: m.serviceUnavailable, danger: false }
        : status.connection === 'unavailable' ? { text: m.unavailable, danger: true }
          : status.connection === 'disconnected' ? { text: m.disconnected, danger: false }
            : status.connection === 'connected' && status.initializing ? { text: m.initializing, danger: false }
              : null;
  const notes = status === null ? [] : [
    ...(primaryNote === null ? [] : [primaryNote]),
    ...(status.poll.error !== null ? [{ text: syncOperational ? m.pollError : m.historicalPollError, danger: false }] : []),
    ...(status.webhook.error !== null ? [{ text: syncOperational ? m.webhookError : m.historicalWebhookError, danger: false }] : []),
  ];
  const empty = read.error !== null ? { title: m.failed, detail: '', retry: true }
    : page === null && loading ? { title: m.loading, detail: '', retry: false }
      : status?.connection === 'not_connected' ? { title: m.noConnection, detail: m.noConnectionDetail, retry: false }
        : status?.syncEnabled && status.serviceAvailable && status.connection === 'connected' && status.initializing ? { title: m.initialTitle, detail: m.initialDetail, retry: false }
          : read.query !== '' ? { title: m.noMatches, detail: m.noMatchesDetail, retry: false }
            : known && page?.counts.all === '0' ? { title: m.emptyTitle, detail: m.emptyDetail, retry: false }
              : { title: m.noSaved, detail: m.noSavedDetail, retry: false };
  const pages = page === null ? 1n : (BigInt(page.total) + 5n) / 6n;
  const start = BigInt(read.pageNumber - 1) * 6n + 1n;
  const end = start + BigInt(page?.items.length ?? 0) - 1n;

  return <div className="pull-request-workspace">
    <div className="project-section-heading pr-heading"><div><h2>{m.title}</h2><p>{m.subtitle}</p></div><button className="button" type="button" onClick={read.refresh} disabled={loading || !props.canRead} aria-busy={loading}><span aria-hidden="true">↻</span> {loading ? m.refreshing : m.refresh}</button></div>
    <div className="pr-sync-status">
      {notes.map(note => <div className={`pr-status-note${note.danger ? ' danger' : ''}`} role="status" key={note.text}>{note.text} {settingsLink}</div>)}
      {read.statusError !== null && <div className="pr-status-note danger" role="alert">{m.statusError} <button type="button" onClick={read.reconcile}>{m.retry}</button></div>}
      {status?.connection === 'connected' && <span>{m.connected}</span>}
      {status?.poll.lastSuccessAt != null && <span>{m.success}: <time dateTime={status.poll.lastSuccessAt}>{format.dateTime(status.poll.lastSuccessAt)}</time></span>}
      {status?.webhook.lastSuccessAt != null && <span>{m.webhook}: <time dateTime={status.webhook.lastSuccessAt}>{format.dateTime(status.webhook.lastSuccessAt)}</time></span>}
    </div>
    {read.hasUpdates && <p className="pr-status-note" role="status">{m.updates} <button type="button" onClick={read.refresh} disabled={loading}>{m.refresh}</button></p>}
    <div className="pr-toolbar"><div className="pr-filter-wrap"><label className="sr-only" htmlFor="pr-filter">{m.filter}</label><select id="pr-filter" value={read.filter} onChange={event => read.setFilter(event.currentTarget.value as PullRequestState)} disabled={!props.canRead}>{filters.map(filter => <option key={filter} value={filter}>{m[filter]}{known && page !== null ? ` · ${page.counts[filter]}` : ''}</option>)}</select><svg className="pr-filter-arrow" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m2 4 3 3 3-3" /></svg></div><div className="pr-search-wrap"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></svg><label className="sr-only" htmlFor="pr-search">{m.search}</label><input ref={search} id="pr-search" type="search" value={read.query} onChange={event => read.setQuery(event.currentTarget.value)} placeholder={m.placeholder} autoComplete="off" disabled={!props.canRead} /></div></div>
    <div aria-live="polite">{known && page !== null && <p className="pr-results-count">{read.filter === 'active' ? `${m.includesDraft} · ` : ''}{page.total} {m.count}</p>}</div>
    {read.error !== null && page !== null && page.items.length > 0 && <p className="pr-status-note danger" role="alert">{m.failed} <button type="button" onClick={read.reconcile}>{m.retry}</button></p>}
    <ul className="pr-list" aria-label="Pull Request">{page?.items.map(item => {
      const tone = item.state === 'open' && item.draft ? 'draft' : item.state;
      const state = item.state === 'merged' ? m.merged : item.state === 'closed' ? m.closed : item.state === 'open' ? item.draft ? m.draft : m.open : m.unknown;
      const source = item.head.repositoryFullName === null && item.head.ref === null ? m.sourceMissing
        : `${item.head.repositoryFullName === item.base.repositoryFullName ? '' : `${item.head.repositoryFullName ?? m.repositoryMissing}:`}${item.head.ref ?? m.branchMissing}`;
      return <li key={item.number}><button className="pr-row" type="button" id={`pr-row-${item.number}`} aria-label={`#${item.number} ${item.title}, ${state}`} onClick={event => { trigger.current = event.currentTarget; setSelected(item.number); }}><PullRequestIcon tone={tone} /><span className="pr-row-main"><span className="pr-row-heading"><span className="pr-row-title">{item.title}</span>{item.draft && item.state === 'open' && <span className="badge pr-row-badge draft">{m.draft}</span>}</span><span className="pr-row-meta"><span className="pr-row-number">#{item.number}</span><span>{item.author?.login ?? m.authorMissing}</span>{item.state !== 'open' && <span>{state}</span>}<span>{m.updated} <time dateTime={item.updatedAt}>{format.dateTime(item.updatedAt)}</time></span></span><span className="pr-row-branch"><code title={source}>{source}</code><span aria-hidden="true">→</span><code title={`${item.base.repositoryFullName}:${item.base.ref}`}>{item.base.ref}</code></span></span><span className="pr-row-time" aria-hidden="true">{format.date(item.updatedAt)}</span><span className="pr-chevron" aria-hidden="true">›</span></button></li>;
    })}</ul>
    {(page === null || page.items.length === 0) && <div className="pr-empty-state" role={read.error !== null ? 'alert' : 'status'}>{loading && page === null || status?.syncEnabled && status.serviceAvailable && status.connection === 'connected' && status.initializing ? <span className="spinner" aria-hidden="true" /> : <span className="pr-empty-icon" aria-hidden="true">⑂</span>}<h3>{empty.title}</h3>{empty.detail && <p>{empty.detail}</p>}{empty.retry && <button className="button" type="button" onClick={read.reconcile}>{m.retry}</button>}{status?.connection === 'not_connected' && settingsLink}{read.query !== '' && read.error === null && <button className="button" type="button" onClick={() => { read.setQuery(''); search.current?.focus(); }}>{m.clear}</button>}</div>}
    {page !== null && (page.items.length > 0 || read.pageNumber > 1 || page.previousCursor !== null || page.nextCursor !== null) && <div className="list-pagination pr-pagination"><span>{page.items.length > 0 ? `${m.range} ${start}–${end} · ${page.total} ${m.count}` : `${page.total} ${m.count}`}</span><div className="list-pagination-controls"><button className="button" type="button" onClick={read.previous} disabled={loading || page.previousCursor === null}>{m.previous}</button><span className="list-pagination-page">{m.page} {read.pageNumber} {m.of} {pages > 0n ? pages.toString() : '1'}</span><button className="button" type="button" onClick={read.next} disabled={loading || page.nextCursor === null}>{m.next}</button></div></div>}
    {selected !== null && props.canRead && !accessDenied && <PullRequestDetailDialog userId={props.userId} projectId={props.projectId} number={selected} canRead={props.canRead} active={props.active} visible={props.active} onPrincipalMismatch={props.onPrincipalMismatch} {...(props.onAccessError === undefined ? {} : { onAccessError: props.onAccessError })} refreshKey={read.refreshKey} onClose={() => setSelected(null)} onRestoreFocus={() => {
      if (!props.active) return;
      const target = trigger.current;
      if (target?.isConnected && !target.closest('[hidden], [inert]')) target.focus({ preventScroll: true });
      else document.getElementById('project-section-tab-prs')?.focus({ preventScroll: true });
    }} />}
  </div>;
};

export const PullRequestWorkspace = (props: PullRequestWorkspaceProps) => <Workspace key={`${props.userId}/${props.projectId}`} {...props} />;
