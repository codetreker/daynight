import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, authRequestsPaused, authRequestsPauseRevision, attachmentPageUrl, attachmentDownloadUrl, attachmentPreviewRoot, attachmentPreviewUrl } from '../../../api/client';
import { useI18n } from '../../../i18n/LocaleProvider';
import type { Attachment } from '../../../api/types';
import type { AttachmentPreviewState } from './AttachmentPreview';
import { AttachmentActionMenu, AttachmentDeleteDialog, type AttachmentActionTarget } from './AttachmentActions';
import { AttachmentPreview, type AttachmentKeyboardOwner } from './AttachmentPreview';
import { attachmentTree, isAttachmentPath, type AttachmentNode } from './model';
import { useAttachments, type AttachmentApi, type AttachmentController } from './useAttachments';
import '../../../styles/attachments.css';

export type AttachmentUrls = {
  readonly preview: (path: string) => string;
  readonly download: (path: string) => string;
  readonly previewRoot: string;
  readonly page: (path: string) => string;
};

type TaskAttachmentsProps = {
  readonly projectId: string;
  readonly taskId: string;
  readonly keyboardOwner?: AttachmentKeyboardOwner;
  readonly api?: AttachmentApi;
  readonly urls?: AttachmentUrls;
};

export type AttachmentNavigation = { readonly invalid: boolean };
export type AttachmentTreeReveal = { readonly path: string | null };
export type AttachmentRecordSlots = {
  readonly sidebar: ReactNode;
  readonly preview: ReactNode | null;
  readonly clearSelection: () => void;
};

type TaskAttachmentsPanelProps = Omit<TaskAttachmentsProps, 'api'> & {
  readonly attachments: AttachmentController;
  readonly records?: AttachmentRecordSlots;
  readonly navigation?: AttachmentNavigation | null;
  readonly reveal?: AttachmentTreeReveal;
  readonly onInteract?: () => void;
  readonly active?: boolean;
  readonly onSelect?: (path: string) => void;
  readonly onRemove?: (path: string) => void;
};

const ErrorMessage = ({ error, message }: { readonly error: unknown; readonly message: string }) => {
  const { messages } = useI18n();
  return <>
    <p>{message}</p>
    {error instanceof ApiError && error.requestId !== null && <p className="request-id">{messages.common.requestId}{' '}<code>{error.requestId}</code></p>}
  </>;
};

const ancestorDirectories = (path: string | null): readonly string[] => {
  if (path === null) return [];
  const segments = path.split('/');
  return segments.slice(0, -1).map((_segment, index) => segments.slice(0, index + 1).join('/'));
};

const FileTree = ({ nodes, selectedPath, onSelect, onActions, actionPath, busy, expanded, onDirectoryToggle }: {
  readonly nodes: readonly AttachmentNode[];
  readonly selectedPath: string | null;
  readonly onSelect: (path: string) => void;
  readonly onActions: (target: AttachmentActionTarget) => void;
  readonly actionPath: string | null;
  readonly busy: boolean;
  readonly expanded: ReadonlySet<string>;
  readonly onDirectoryToggle: (path: string, open: boolean) => void;
}) => {
  const { format, messages } = useI18n();
  return <ul className="attachment-tree">
    {nodes.map((node) => <li key={node.path}>{node.kind === 'directory' ? (
      <details open={expanded.has(node.path)} onToggle={(event) => onDirectoryToggle(node.path, event.currentTarget.open)}>
        <summary onClick={(event) => {
          // Native toggle events are queued; commit clicks before another navigation can reveal the path.
          event.preventDefault();
          onDirectoryToggle(node.path, !expanded.has(node.path));
        }}><span aria-hidden="true">▱</span> {node.name}</summary>
        <FileTree nodes={node.children} selectedPath={selectedPath} onSelect={onSelect} onActions={onActions} actionPath={actionPath} busy={busy} expanded={expanded} onDirectoryToggle={onDirectoryToggle} />
      </details>
    ) : (
      <div className={`attachment-file-row${selectedPath === node.path ? ' attachment-file-selected' : ''}`}><button className="attachment-file" type="button" aria-pressed={selectedPath === node.path} onClick={() => onSelect(node.path)}>
        <span className="attachment-file-icon" aria-hidden="true">▤</span>
        <span className="attachment-file-name">{node.name}</span>
        <span className="attachment-file-size">{format.bytes(node.attachment.sizeBytes)}</span>
      </button><button className="attachment-actions-trigger" type="button" aria-label={messages.inspection.attachments.fileActions({ path: node.path })} aria-haspopup="menu" aria-expanded={actionPath === node.path} disabled={busy} onClick={(event) => onActions({ path: node.path, trigger: event.currentTarget })} onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); onActions({ path: node.path, trigger: event.currentTarget }); }
      }}>…</button></div>
    )}</li>)}
  </ul>;
};

export const TaskAttachmentsPanel = ({ projectId, taskId, attachments, records, urls, navigation, reveal, onInteract, keyboardOwner, onSelect, onRemove, active = true }: TaskAttachmentsPanelProps) => {
  const { messages, format } = useI18n();
  const m = messages.inspection.attachments;
  const headingId = useId();
  const fileId = useId();
  const pathId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const previewPane = useRef<HTMLDivElement>(null);
  const [action, setAction] = useState<(AttachmentActionTarget & { readonly kind: 'menu' | 'confirm'; readonly scope: string }) | null>(null);
  const scope = `${projectId}/${taskId}`;
  const [file, setFile] = useState<File | null>(null);
  const draftRevision = useRef(0);
  const [path, setPath] = useState('');
  const [pathError, setPathError] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(ancestorDirectories(reveal === undefined ? null : reveal.path)));
  useLayoutEffect(() => {
    if (reveal === undefined) return;
    const ancestors = ancestorDirectories(reveal.path);
    setExpanded((current) => ancestors.every((path) => current.has(path)) ? current : new Set([...current, ...ancestors]));
  }, [reveal]);
  const toggleDirectory = (path: string, open: boolean) => setExpanded((current) => {
    if (current.has(path) === open) return current;
    const next = new Set(current);
    if (open) next.add(path);
    else next.delete(path);
    return next;
  });
  const selected = attachments.selected;
  const busy = attachments.write.status !== 'idle';
  const paused = attachments.paused;
  const retainedPreview = useRef<{ scope: string; attachment: Attachment; preview: AttachmentPreviewState } | null>(null);
  if (retainedPreview.current?.scope !== scope) retainedPreview.current = null;
  if (!paused) retainedPreview.current = selected !== undefined && attachments.preview.status === 'ready' ? { scope, attachment: selected, preview: attachments.preview } : null;
  const retained = paused ? retainedPreview.current : null;
  const previews = selected === undefined ? (retained === null ? [] : [retained])
    : retained !== null && retained.attachment.path !== selected.path ? [retained, { attachment: selected, preview: attachments.preview }]
    : [{ attachment: selected, preview: retained?.preview ?? attachments.preview }];
  useEffect(() => {
    if (action !== null && (action.scope !== scope || !active && !busy || busy && action.kind === 'menu')) setAction(null);
  }, [active, busy, scope, action]);
  const dismissMenu = (restoreFocus: boolean) => {
    if (restoreFocus) action!.trigger.focus();
    setAction(null);
  };
  const confirmDelete = async () => {
    if (action === null || action.scope !== scope || authRequestsPaused()) return;
    onInteract?.();
    const revision = authRequestsPauseRevision();
    if (await attachments.remove(action.path) && !authRequestsPaused() && revision === authRequestsPauseRevision()) { onRemove?.(action.path); setAction(null); }
  };
  useLayoutEffect(() => {
    if (navigation !== undefined && navigation !== null) previewPane.current!.focus();
  }, [navigation]);
  const select = (path: string) => {
    records?.clearSelection();
    onInteract?.();
    attachments.select(path);
    onSelect?.(path);
  };
  const upload = async (event: FormEvent) => {
    event.preventDefault();
    if (file === null || authRequestsPaused()) return;
    if (!isAttachmentPath(path)) {
      setPathError(true);
      return;
    }
    onInteract?.();
    const pauseRevision = authRequestsPauseRevision();
    const submittedDraft = draftRevision.current;
    if (await attachments.put(path, file) && !authRequestsPaused() && pauseRevision === authRequestsPauseRevision() && submittedDraft === draftRevision.current) {
      records?.clearSelection();
      onSelect?.(path);
      setFile(null);
      setPath('');
      fileInput.current!.value = '';
    }
  };

  return (
    <section className="task-attachments" aria-labelledby={headingId}>
      <div className="attachment-split">
        <aside className="attachment-sidebar">
          {records?.sidebar}
          <div className="attachment-section-heading">
            <h4 id={headingId}>{attachments.complete ? m.heading({ count: format.number(attachments.items.length) }) : m.title}</h4>
            <button className="button" type="button" disabled={attachments.loading || busy || paused} onClick={attachments.reload}>{m.refresh}</button>
          </div>
          {attachments.write.error !== null && action?.kind !== 'confirm' && <div className="attachment-error attachment-state" role="alert"><ErrorMessage error={attachments.write.error} message={m.writeError} /></div>}
          {attachments.loading && <p className="attachment-state" role="status">{m.loading}</p>}
          {attachments.error !== null && (
            <div className="attachment-state attachment-error" role="alert">
              <ErrorMessage error={attachments.error} message={attachments.items.length === 0 ? m.listError : m.incompleteList} />
              <button className="button" type="button" disabled={busy || paused} onClick={attachments.reload}>{m.retry}</button>
            </div>
          )}
          {attachments.complete && attachments.items.length === 0 && <p className="attachment-state">{m.empty}</p>}
          {attachments.items.length > 0 && <nav className="attachment-files" aria-label={m.files}><FileTree nodes={attachmentTree(attachments.items)} expanded={expanded} onDirectoryToggle={toggleDirectory} selectedPath={records?.preview == null ? attachments.selectedPath : null} onSelect={select} busy={busy || paused} actionPath={action?.kind === 'menu' ? action.path : null} onActions={(target) => { onInteract?.(); setAction(action?.kind === 'menu' && action.path === target.path ? null : { ...target, kind: 'menu', scope }); }} /></nav>}
          <details className="attachment-upload-disclosure">
            <summary>{m.upload}</summary>
            <form className="attachment-upload" onSubmit={(event) => { void upload(event); }}>
              <label htmlFor={fileId}>{m.chooseFile}</label>
              <input id={fileId} ref={fileInput} type="file" disabled={busy} onChange={(event) => {
                ++draftRevision.current;
                const chosen = event.currentTarget.files?.[0];
                setFile(chosen === undefined ? null : chosen);
                setPath(chosen === undefined ? '' : chosen.name);
                setPathError(false);
              }} />
              <label htmlFor={pathId}>{m.targetPath}</label>
              <div className="attachment-upload-target">
                <input id={pathId} type="text" value={path} placeholder={m.pathPlaceholder} disabled={busy} aria-invalid={pathError} onChange={(event) => { ++draftRevision.current; setPath(event.currentTarget.value); setPathError(false); }} />
                <button className="button primary" type="submit" disabled={file === null || busy || paused}>{attachments.write.status === 'saving' ? m.uploading : m.upload}</button>
              </div>
              <p className="attachment-hint">{m.uploadHint}</p>
              {pathError && <p className="attachment-error" role="alert">{m.invalidPath}</p>}
            </form>
          </details>
        </aside>
        <div className="attachment-preview-pane" ref={previewPane} tabIndex={-1} role="group" aria-label={m.preview}>
          <div className="attachment-file-preview" hidden={records?.preview != null} inert={records?.preview != null}>
          {navigation?.invalid === true ? <div className="attachment-preview-body"><p className="attachment-state attachment-error" role="alert">{m.invalidReference}</p></div> : selected === undefined ? <div className="attachment-preview-body attachment-preview-empty">
            {attachments.selectedPath === null ? <p className="attachment-state">{m.choosePreview}</p> : attachments.error !== null ? <div className="attachment-state attachment-error" role="alert">
              <ErrorMessage error={attachments.error} message={attachments.items.length === 0 ? m.listError : m.incompleteList} />
              <button className="button" type="button" disabled={busy || paused} onClick={attachments.reload}>{m.retry}</button>
            </div> : !attachments.complete ? <p className="attachment-state" role="status">{m.loading}</p> : <div className="attachment-state" role="alert"><p>{m.missing}</p><button className="button" type="button" disabled={busy || paused} onClick={attachments.reload}>{m.retry}</button></div>}
          </div> : null}
            <section className="attachment-preview" aria-label={m.preview} hidden={selected === undefined || navigation?.invalid === true} style={selected === undefined || navigation?.invalid === true ? { display: 'none' } : undefined}>
              {selected !== undefined && <header className="attachment-preview-header">
                <div className="attachment-file-information"><h5 title={selected.path}>{selected.path}</h5><p title={m.fileMetadata({ contentType: selected.contentType, size: format.bytes(selected.sizeBytes) })}>{m.fileMetadata({ contentType: selected.contentType, size: format.bytes(selected.sizeBytes) })}</p></div>
                <dl className="attachment-timestamps">
                  <dt>{m.created}</dt><dd><time dateTime={selected.createdAt}>{format.dateTime(selected.createdAt)}</time></dd>
                  <dt>{m.lastModified}</dt><dd><time dateTime={selected.updatedAt}>{format.dateTime(selected.updatedAt)}</time></dd>
                </dl>
                <div className="attachment-preview-actions">
                  <a className="button" href={paused ? undefined : urls === undefined ? attachmentDownloadUrl(projectId, taskId, selected.path) : urls.download(selected.path)} download={paused ? undefined : true} aria-disabled={paused || undefined} role={paused ? "link" : undefined} tabIndex={paused ? 0 : undefined}>{m.download}</a>
                  <a className="button" href={paused ? undefined : urls === undefined ? attachmentPageUrl(projectId, taskId, selected.path) : urls.page(selected.path)} aria-disabled={paused || undefined} role={paused ? "link" : undefined} tabIndex={paused ? 0 : undefined} target="_blank" rel="noopener noreferrer" aria-label={m.openInNewTab} title={m.openInNewTab}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M14 3h7v7M21 3 10 14M10 3H4a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6" /></svg><span className="attachment-preview-open-label">{m.openInNewTab}</span></a>
                </div>
              </header>}
              {previews.map(({ attachment, preview }) => {
                const hidden = attachment.path !== selected?.path;
                return <div key={`${attachment.path}/${attachment.updatedAt}`} hidden={hidden} style={hidden ? undefined : { display: 'contents' }}><AttachmentPreview attachment={attachment} preview={preview} paused={paused} url={urls === undefined ? attachmentPreviewUrl(projectId, taskId, attachment.path) : urls.preview(attachment.path)} previewRoot={urls === undefined ? attachmentPreviewRoot(projectId, taskId) : urls.previewRoot} onRetry={attachments.retryPreview} {...(keyboardOwner === undefined ? {} : { keyboardOwner })} /></div>;
              })}
            </section>
          </div>
          {records?.preview != null ? <div className="attachment-record-preview">{records.preview}</div> : null}
        </div>
      </div>
      {active && action?.scope === scope && action.kind === 'menu' && !busy && <AttachmentActionMenu target={action} onDismiss={dismissMenu} onDelete={() => setAction({ ...action, kind: 'confirm' })} />}
      {action?.scope === scope && action.kind === 'confirm' && <AttachmentDeleteDialog target={action} busy={busy} paused={paused} error={attachments.write.error} fallback={previewPane} onConfirm={() => { void confirmDelete(); }} onDismiss={() => setAction(null)} />}
    </section>
  );
};

const TaskAttachmentContent = ({ api, ...props }: TaskAttachmentsProps) => {
  const attachments = useAttachments(props.projectId, props.taskId, api);
  return <TaskAttachmentsPanel {...props} attachments={attachments} />;
};

export const TaskAttachments = (props: TaskAttachmentsProps) => <TaskAttachmentContent key={`${props.projectId}/${props.taskId}`} {...props} />;
