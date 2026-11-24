import { useContext, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { authRequestsPaused, authRequestsPauseRevision } from '../../../api/client';
import { isTopOverlay, OverlayOwnerContext } from '../../../app/overlay';
import { useI18n } from '../../../i18n/LocaleProvider';
import { isNativeSelectPopupOpen } from '../../../ui/native-select/NativeSelect';
import { useDraftNavigationDecision } from '../TaskDraftNavigation';
import { isAttachmentPath } from './model';
import type { AttachmentController } from './useAttachments';

type AttachmentUploadProps = {
  readonly attachments: AttachmentController;
  readonly scope: string;
  readonly compact: boolean;
  readonly open: boolean;
  readonly active: boolean;
  readonly error: ReactNode;
  readonly onOpenChange: (open: boolean) => void;
  readonly onInteract: (() => void) | undefined;
  readonly onUploaded: (path: string) => void;
};

export const AttachmentUpload = ({ attachments, scope, compact, open, active, error, onOpenChange, onInteract, onUploaded }: AttachmentUploadProps) => {
  const { messages } = useI18n();
  const m = messages.inspection.attachments;
  const owner = useContext(OverlayOwnerContext);
  const decision = useDraftNavigationDecision();
  const fileId = useId();
  const pathId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [path, setPath] = useState('');
  const [pathError, setPathError] = useState(false);
  const draftRevision = useRef(0);
  const currentScope = useRef(scope); currentScope.current = scope;
  const confirmed = useRef<{ scope: string; draft: number; path: string; published: boolean; pauseRevision: number; owns: () => boolean } | null>(null);
  const previous = useRef({ compact, open });
  const restoreOpener = useRef(false);
  const busy = attachments.write.status !== 'idle';
  useLayoutEffect(() => {
    const prior = previous.current;
    previous.current = { compact, open };
    if (!active) return;
    if (!open) {
      if (restoreOpener.current) opener.current!.focus({ preventScroll: true });
      restoreOpener.current = false;
      return;
    }
    if (!prior.open || compact !== prior.compact && (document.activeElement === opener.current || document.activeElement === back.current)) {
      (busy ? compact ? back.current : opener.current : fileInput.current)!.focus({ preventScroll: true });
    }
  }, [active, busy, compact, open]);
  const close = () => {
    restoreOpener.current = true;
    onOpenChange(false);
  };
  useEffect(() => {
    if (!active || !open) return;
    // Ancestor DOM refs attach after descendant layout effects. The owner's
    // bubbling listener still precedes the detail's document-level listener.
    const root = owner === null ? slot.current! : owner.current!;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (!active || !open || decision !== null || owner !== null && !isTopOverlay(root)) return;
      if (isNativeSelectPopupOpen(event.target)) return;
      const target = event.target;
      if (target instanceof Element && target.closest('dialog[open], [popover], [role="menu"]') !== null) return;
      event.preventDefault(); event.stopPropagation(); close();
    };
    root.addEventListener('keydown', escape);
    return () => root.removeEventListener('keydown', escape);
  }, [active, decision, onOpenChange, open, owner]);
  const settleConfirmed = () => {
    const result = confirmed.current;
    if (result === null || authRequestsPaused()) return;
    confirmed.current = null;
    if (!result.owns() || result.scope !== currentScope.current || result.draft !== draftRevision.current || fileInput.current === null) return;
    setFile(null); setPath(''); setPathError(false); fileInput.current.value = '';
    if (result.published && result.pauseRevision === authRequestsPauseRevision()) onUploaded(result.path);
  };
  useEffect(() => { if (!attachments.paused) settleConfirmed(); }, [attachments.paused, scope]);
  const upload = async (event: FormEvent) => {
    event.preventDefault();
    if (file === null || authRequestsPaused()) return;
    if (!isAttachmentPath(path)) { setPathError(true); return; }
    onInteract?.();
    const pauseRevision = authRequestsPauseRevision();
    const submittedDraft = draftRevision.current;
    const pending = attachments.put(path, file);
    const owner = attachments.captureWriteOwner();
    const result = await pending;
    if (result === 'published' || result === 'confirmed') {
      confirmed.current = { scope, draft: submittedDraft, path, published: result === 'published', pauseRevision, owns: () => attachments.isWriteOwner(owner) };
      settleConfirmed();
    }
  };
  return <div ref={slot} className="attachment-upload-slot">
    <details className="attachment-upload-disclosure" open={open}>
      <summary ref={opener} onClick={(event) => {
        event.preventDefault();
        if (open) close();
        else { onInteract?.(); onOpenChange(true); }
      }}>{m.upload}</summary>
      <header className="attachment-upload-heading" hidden={!compact}>
        <h4>{m.upload}</h4>
        <button ref={back} className="button" type="button" onClick={close}>{m.backToFiles}</button>
      </header>
      <form className="attachment-upload" onSubmit={(event) => { void upload(event); }}>
        <label htmlFor={fileId}>{m.chooseFile}</label>
        <input id={fileId} ref={fileInput} type="file" disabled={busy} onChange={(event) => {
          ++draftRevision.current;
          const chosen = event.currentTarget.files?.[0];
          setFile(chosen === undefined ? null : chosen);
          setPath(chosen === undefined ? '' : chosen.name);
          setPathError(false);
        }} />
        {file !== null && <p className="attachment-upload-filename">{file.name}</p>}
        <label htmlFor={pathId}>{m.targetPath}</label>
        <div className="attachment-upload-target">
          <input data-touch-text="coarse" id={pathId} type="text" value={path} placeholder={m.pathPlaceholder} disabled={busy} aria-invalid={pathError} onChange={(event) => { ++draftRevision.current; setPath(event.currentTarget.value); setPathError(false); }} />
          <button className="button primary" type="submit" disabled={file === null || busy || attachments.paused}>{attachments.write.status === 'saving' ? m.uploading : m.upload}</button>
        </div>
        <p className="attachment-hint">{m.uploadHint}</p>
        {pathError && <p className="attachment-error" role="alert">{m.invalidPath}</p>}
        {error}
      </form>
    </details>
  </div>;
};
