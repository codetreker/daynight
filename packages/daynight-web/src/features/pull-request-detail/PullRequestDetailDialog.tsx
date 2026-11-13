import { useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ApiError } from '../../api/client';
import { isTopOverlay, OverlayOwnerContext, registerOverlay } from '../../app/overlay';
import { useBodyScrollLock } from '../../app/useBodyScrollLock';
import { useI18n } from '../../i18n/LocaleProvider';
import { ChatMarkdown } from '../../ui/ChatMarkdown';
import { captureReadingText, readingTextTop, type ReadingTextAnchor } from '../../ui/reading-text-anchor';
import { dialogFocusables } from '../task-detail/focus';
import { usePullRequestDetail } from './usePullRequestDetail';
import './pull-request-detail.css';

const en = {
  title: 'Pull request details', close: 'Close pull request details', loading: 'Loading pull request…',
  failed: 'Could not load pull request details.', retry: 'Retry', unavailable: 'Pull request details are unavailable.',
  authorMissing: 'Author unavailable', sourceMissing: 'Source repository or branch unavailable', repositoryMissing: 'Repository unavailable', branchMissing: 'Branch unavailable',
  source: 'Source branch', target: 'Target branch', sha: 'Head SHA', created: 'Created', updated: 'GitHub updated',
  closed: 'Closed', merged: 'Merged', observed: 'Last observed', closedState: 'Closed', mergedState: 'Merged', raw: 'Raw Markdown', empty: 'This pull request has no description.',
  image: 'Image unavailable', table: 'Description table', github: 'View on GitHub', draft: 'Draft', open: 'Open', unknown: 'Unknown',
};
const zh: typeof en = {
  title: 'PR 详情', close: '关闭 PR 详情', loading: '正在读取 PR…', failed: '无法读取 PR 详情。', retry: '重试', unavailable: '无法查看 PR 详情。',
  authorMissing: '作者不可用', sourceMissing: '来源仓库或分支不可用', repositoryMissing: '仓库不可用', branchMissing: '分支不可用', source: '来源分支', target: '目标分支', sha: 'Head SHA',
  created: '创建时间', updated: 'GitHub 更新时间', closed: '关闭时间', merged: '合并时间', observed: '最近观测', closedState: '已关闭', mergedState: '已合并', raw: '原始 Markdown',
  empty: '此 PR 没有 description。', image: '图片不可用', table: 'Description 表格', github: '在 GitHub 查看', draft: '草稿', open: '开启', unknown: '未知',
};

export type PullRequestDetailDialogProps = {
  readonly userId: string;
  readonly projectId: string;
  readonly number: string;
  /** False only after access is revoked; a pending identity check keeps the reader mounted. */
  readonly canRead: boolean;
  /** Controls new reads without clearing a still-authorized view. */
  readonly active: boolean;
  readonly visible?: boolean;
  readonly onPrincipalMismatch: () => void;
  readonly onAccessError?: (error: ApiError) => void;
  readonly onClose: () => void;
  readonly onRestoreFocus?: () => void;
  /** Change to request a background reconciliation without rebuilding the dialog. */
  readonly refreshKey?: string | number;
};

const safeExternalUrl = (value: string): string | undefined => {
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : undefined; }
  catch { return undefined; }
};

export function PullRequestDetailDialog(props: PullRequestDetailDialogProps) {
  const { locale, format } = useI18n(), m = locale === 'zh-CN' ? zh : en;
  const { detail, loading, error, refresh } = usePullRequestDetail({
    userId: props.userId, projectId: props.projectId, number: props.number, canRead: props.canRead, active: props.active,
    onPrincipalMismatch: props.onPrincipalMismatch, ...(props.onAccessError === undefined ? {} : { onAccessError: props.onAccessError }),
  });
  const [raw, setRaw] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), close = useRef<HTMLButtonElement>(null), body = useRef<HTMLDivElement>(null);
  const titleId = useId(), owner = useContext(OverlayOwnerContext);
  const callbacks = useRef({ onClose: props.onClose, onRestoreFocus: props.onRestoreFocus });
  callbacks.current = { onClose: props.onClose, onRestoreFocus: props.onRestoreFocus };
  const anchor = useRef<ReadingTextAnchor | undefined>(undefined);
  const identity = `${props.userId}/${props.projectId}/${props.number}`;
  const lastIdentity = useRef(identity);
  const lastRefresh = useRef(props.refreshKey);
  const visible = props.visible !== false;
  useBodyScrollLock(visible);
  useLayoutEffect(() => {
    if (!visible) return;
    const node = dialog.current!, opener = document.activeElement;
    const release = registerOverlay(node, owner?.current ?? null);
    node.showModal(); close.current?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (!isTopOverlay(node)) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); callbacks.current.onClose(); }
      else if (event.key === 'Tab') {
        event.stopPropagation();
        const items = dialogFocusables(node), first = items[0], last = items[items.length - 1];
        if (!first || !last) return;
        if (!node.contains(document.activeElement) || (!event.shiftKey && document.activeElement === last)) { event.preventDefault(); first.focus(); }
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      if (node.open) node.close();
      release();
      if (callbacks.current.onRestoreFocus) callbacks.current.onRestoreFocus();
      else if (opener instanceof HTMLElement && opener.isConnected && !opener.closest('[inert], [hidden]') && !opener.matches(':disabled')) opener.focus({ preventScroll: true });
    };
  }, [owner, visible]);
  useLayoutEffect(() => {
    if (lastIdentity.current !== identity) {
      lastIdentity.current = identity; anchor.current = undefined; setRaw(false);
      if (body.current) body.current.scrollTop = 0;
      return;
    }
    const node = body.current;
    if (node && anchor.current) {
      const top = readingTextTop(node, anchor.current);
      if (top !== undefined) node.scrollTop += top - node.getBoundingClientRect().top - anchor.current.top;
    }
  }, [identity, detail]);
  useEffect(() => {
    if (lastRefresh.current !== props.refreshKey) { lastRefresh.current = props.refreshKey; void refresh(); }
  }, [props.refreshKey, refresh]);

  const branch = !detail || (!detail.head.repositoryFullName && !detail.head.ref) ? m.sourceMissing : `${detail.head.repositoryFullName || m.repositoryMissing}:${detail.head.ref || m.branchMissing}`;
  const target = detail ? `${detail.base.repositoryFullName}:${detail.base.ref}` : '';
  const state = detail?.draft && detail.state === 'open' ? m.draft : detail?.state === 'open' ? m.open : detail?.state === 'closed' ? m.closedState : detail?.state === 'merged' ? m.mergedState : m.unknown;
  const tone = detail?.state === 'open' && detail.draft ? 'draft' : detail?.state === 'closed' ? 'closed' : detail?.state === 'merged' ? 'merged' : '';
  const href = detail ? safeExternalUrl(detail.url) : undefined;
  const fields: readonly [string, string][] = detail ? [
    [m.source, branch], [m.target, target], [m.sha, detail.head.sha], [m.created, format.dateTime(detail.createdAt)],
    [m.updated, format.dateTime(detail.updatedAt)],
    ...(detail.closedAt ? [[m.closed, format.dateTime(detail.closedAt)] as [string, string]] : []),
    ...(detail.mergedAt ? [[m.merged, format.dateTime(detail.mergedAt)] as [string, string]] : []),
  ] : [];
  return createPortal(<dialog className="auth-dialog pr-detail-dialog" ref={dialog} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); props.onClose(); }}
    onClick={event => { if (event.target !== event.currentTarget) return; const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) props.onClose(); }}>
    <header className="dialog-header"><div><span className="pr-detail-kicker">{detail ? `${detail.base.repositoryFullName} · #${detail.number}` : `#${props.number}`}</span><h2 id={titleId}>{detail?.title ?? m.title}</h2></div><button ref={close} className="close-button" type="button" aria-label={m.close} onClick={props.onClose}>×</button></header>
    <div className="dialog-body" ref={body} onScroll={() => { const node = body.current; if (node) anchor.current = captureReadingText(node, node.getBoundingClientRect()); }}>
      {error && <div className="pr-detail-error" role="alert">{m.failed} {props.canRead && props.active && <button type="button" onClick={() => void refresh()}>{m.retry}</button>}</div>}
      {!detail && !error && <p>{props.canRead && loading ? m.loading : m.unavailable}</p>}
      {detail && <>
        <div className="detail-summary-line"><span className={`detail-state ${tone}`}>{state}</span><span>{detail.author?.login ?? m.authorMissing}</span><span>{m.updated}: {format.dateTime(detail.updatedAt)}</span></div>
        <dl className="detail-fields">{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{[m.source, m.target, m.sha].includes(label) ? <code>{value}</code> : value}</dd></div>)}</dl>
        <div className="description-heading"><h3>Description</h3><label className="raw-toggle"><input type="checkbox" checked={raw} onChange={event => setRaw(event.currentTarget.checked)} />{m.raw}</label></div>
        {detail.description === null || detail.description === '' ? <div className="no-description">{m.empty}</div> : raw ? <pre className="pr-description-source">{detail.description}</pre> : <ChatMarkdown text={detail.description} resourceUnavailable={m.image} tableLabel={m.table} />}
      </>}
    </div>
    {detail && <footer className="dialog-footer"><span>{m.observed}: {format.dateTime(detail.observedAt)}</span>{href && <a className="button" href={href} target="_blank" rel="noopener noreferrer">{m.github} <span aria-hidden="true">↗</span></a>}</footer>}
  </dialog>, document.body);
}
