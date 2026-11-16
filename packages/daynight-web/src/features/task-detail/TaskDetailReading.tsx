import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { TaskDetailNavigation } from '../../app/router';
import { attachmentPreviewRoot } from '../../api/client';
import { useI18n } from '../../i18n/LocaleProvider';
import { MarkdownContent } from './MarkdownContent';
import { TaskDetailPanels } from './TaskDetailPanels';
import { TaskAttachmentsPanel, type AttachmentNavigation, type AttachmentTreeReveal, type AttachmentUrls, type AttachmentRecordSlots } from './attachments/TaskAttachments';
import type { AttachmentKeyboardOwner } from './attachments/AttachmentPreview';
import { resolveAttachmentReference, resolveMarkdownAttachmentUrl } from './attachments/model';
import { useAttachments, type AttachmentApi } from './attachments/useAttachments';

type TaskDetailReadingProps = {
  readonly projectId: string;
  readonly taskId: string;
  readonly description: string;
  readonly available?: boolean;
  readonly steps?: (active: boolean, renderMarkdown: (text: string) => ReactNode) => ReactNode;
  readonly discussion?: ReactNode | ((active: boolean) => ReactNode);
  readonly sessionRecords?: (active: boolean, render: (records: AttachmentRecordSlots) => ReactNode, resetSelection: object) => ReactNode;
  readonly session?: ReactNode | ((active: boolean) => ReactNode);
  readonly overview: (description: ReactNode) => ReactNode;
  readonly keyboardOwner?: AttachmentKeyboardOwner;
  readonly selection?: TaskDetailNavigation;
  readonly onSelectionChange?: (selection: TaskDetailNavigation) => void;
  readonly requireCompleteInventory?: boolean;
  readonly api?: AttachmentApi;
  readonly urls?: AttachmentUrls;
};

export const TaskDetailReading = ({ projectId, taskId, description, overview, steps, discussion, session, sessionRecords, keyboardOwner, api, urls, selection: controlledSelection, onSelectionChange, requireCompleteInventory = false, available = true }: TaskDetailReadingProps) => {
  const { messages } = useI18n();
  const attachments = useAttachments(projectId, taskId, api, { requireCompleteInventory, enabled: available });
  const [localSelection, setLocalSelection] = useState<TaskDetailNavigation>({ tab: 'overview', path: null });
  const selection = controlledSelection === undefined ? localSelection : controlledSelection;
  const localNavigation = useRef<TaskDetailNavigation | null>(null);
  const select = (next: TaskDetailNavigation) => { localNavigation.current = next; setLocalSelection(next); onSelectionChange?.(next); };
  const [reveal, setReveal] = useState<AttachmentTreeReveal>(() => ({ path: selection.path }));
  const observedPath = useRef(selection.path);
  useLayoutEffect(() => {
    if (observedPath.current === selection.path) return;
    observedPath.current = selection.path;
    if (localNavigation.current?.path !== selection.path) setReveal({ path: selection.path });
    localNavigation.current = null;
  }, [selection.path]);
  const currentSelection = useRef(selection);
  currentSelection.current = selection;
  const unselected = attachments.selectedPath === null;
  useLayoutEffect(() => { if (available) attachments.select(selection.path); }, [attachments.select, selection.path, requireCompleteInventory && unselected, available]);
  // Link feedback belongs to its resulting selection, not later history entries.
  const [reference, setReference] = useState<(AttachmentNavigation & { readonly selection: TaskDetailNavigation }) | null>(null);
  const ownsReference = reference !== null && reference.selection.tab === selection.tab && reference.selection.path === selection.path;
  useLayoutEffect(() => { if (reference !== null && !ownsReference) setReference(null); }, [reference, ownsReference]);
  const previewRoot = urls === undefined ? attachmentPreviewRoot(projectId, taskId) : urls.previewRoot;
  const base = { kind: 'root' } as const;

  const renderMarkdown = (text: string): ReactNode => <MarkdownContent className="task-description" remotePaused={attachments.paused} text={text} resolveUrl={(value) => resolveMarkdownAttachmentUrl(value, base, previewRoot)} onLinkClick={(value, event) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.currentTarget.hasAttribute('download') || event.currentTarget.target !== '' || /[?#]/.test(value)) return;
      const resolved = resolveAttachmentReference(value, base);
      if (resolved.kind === 'native') return;
      event.preventDefault();
      const path = resolved.kind === 'relative' ? resolved.path : null;
      attachments.select(path);
      const next = { tab: 'attachments', path } as const;
      select(next);
      setReveal({ path });
      setReference({ invalid: resolved.kind !== 'relative', selection: next });
    }} />;

  return <TaskDetailPanels suspended={!available} {...(steps === undefined ? {} : { steps: (active: boolean) => steps(available && active, renderMarkdown) })} {...(discussion === undefined ? {} : { discussion: typeof discussion === 'function' ? (active: boolean) => available ? discussion(active) : null : available ? discussion : null })} {...(session === undefined ? {} : { session: typeof session === 'function' ? (active: boolean) => available ? session(active) : null : available ? session : null })} active={selection.tab} onChange={(tab) => select({ ...selection, tab })} overview={() => overview(description === ''
    ? <p className="task-detail-description">{messages.inspection.detail.noDescription}</p>
    : <div className="description-card">{renderMarkdown(description)}</div>)} attachments={(active) => {
      if (!available) return null;
      const render = (records?: AttachmentRecordSlots) => <TaskAttachmentsPanel active={active} {...(records === undefined ? {} : { records })} projectId={projectId} taskId={taskId} attachments={attachments} reveal={reveal} navigation={ownsReference ? reference : null} onInteract={() => setReference(null)} onSelect={(path) => select({ tab: 'attachments', path })} onRemove={(path) => { if (!requireCompleteInventory && currentSelection.current.path === path) select({ ...currentSelection.current, path: null }); }} {...(keyboardOwner === undefined ? {} : { keyboardOwner })} {...(urls === undefined ? {} : { urls })} />;
      return sessionRecords === undefined ? render() : sessionRecords(active, render, reveal);
    }} />;
};
