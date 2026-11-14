import { NativeSelect, isNativeSelectPopupOpen } from "../../../ui/native-select/NativeSelect";
import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ApiError, authRequestsPaused } from "../../../api/client";
import type { StepStatus, TaskStep } from "../../../api/task-steps";
import { useI18n } from "../../../i18n/LocaleProvider";
import { useDirtyTaskDraft, useDraftNavigationDecision } from "../TaskDraftNavigation";
import { TaskConfirmation } from "../TaskConfirmation";
import { useTaskDetailSessions } from "../TaskDetailSession";
import { useTaskSteps } from "../useTaskSteps";
import { StepMoveMenu, type MoveAction } from "./StepMoveMenu";
import { StepAddTargetDialog, StepMoveDialog } from "./StepTargetPicker";
import { StepStatusMenu } from "./StepStatusMenu";
import "../../../styles/task-steps.css";

const PAGE_SIZE = 100;
type StepDraft = { key: number; revision: number; submittedRevision: number | null; submittedNavigation: number | null; submittedContent: { title: string; description: string; status: StepStatus; placement: "last" | "before" | "after"; anchorId: string | null; anchorCreatedAt: string | null } | null; addReceipt: { version: bigint; publicationPending: boolean; createdAt: string | null } | null; review: { version: bigint; acknowledged: boolean } | null; standalone: boolean; holdForTarget: boolean; kind: "add" | "edit"; id: string; title: string; description: string; status: StepStatus; originalTitle: string; originalDescription: string; originalCreatedAt: string | null; retired: boolean; placement: "last" | "before" | "after"; anchorId: string | null; anchorCreatedAt: string | null; initialPlacement: "last" | "before" | "after"; initialAnchorId: string | null; initialAnchorCreatedAt: string | null; requestId: string | null; confirmed: boolean; uncertain: boolean };
const isDirty = (draft: StepDraft | null) => draft !== null && (draft.title !== draft.originalTitle || draft.description !== draft.originalDescription || draft.kind === "add" && (draft.status !== "todo" || draft.placement !== draft.initialPlacement || draft.anchorId !== draft.initialAnchorId || draft.anchorCreatedAt !== draft.initialAnchorCreatedAt) || draft.requestId !== null);
const invalidText = (value: string) => value.includes("\0") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
// Textareas normalize CR and CRLF for display. Preserve untouched source spans when editing.
type EditSelection = { start: number; end: number; inputType: string };
type TextEdit = { start: number; removed: string; inserted: string };
type TextHistory = { current: string; edits: TextEdit[]; index: number; size: number };
const newHistory = (current: string): TextHistory => ({ current, edits: [], index: 0, size: 0 });
const displayText = (value: string) => value.replace(/\r\n|\r/g, "\n");
const preserveLineEndings = (source: string, value: string, selection: EditSelection | null): string => {
  const display = displayText(source);
  let prefix = 0;
  const backward = selection?.start === selection?.end && selection?.inputType.startsWith("delete") && selection.inputType.endsWith("Backward");
  const forward = selection?.start === selection?.end && selection?.inputType.startsWith("delete") && selection.inputType.endsWith("Forward");
  const prefixLimit = selection ? Math.max(0, selection.start - (backward ? 1 : 0)) : display.length;
  const suffixLimit = selection ? Math.max(0, display.length - selection.end - (forward ? 1 : 0)) : display.length;
  while (prefix < prefixLimit && prefix < display.length && prefix < value.length && display[prefix] === value[prefix]) prefix++;
  let suffix = 0;
  while (suffix < suffixLimit && suffix < display.length - prefix && suffix < value.length - prefix && display[display.length - 1 - suffix] === value[value.length - 1 - suffix]) suffix++;
  const offset = (end: number) => {
    let raw = 0; let shown = 0;
    while (shown < end) { if (source[raw] === "\r" && source[raw + 1] === "\n") raw++; raw++; shown++; }
    return raw;
  };
  return source.slice(0, offset(prefix)) + value.slice(prefix, value.length - suffix) + source.slice(offset(display.length - suffix));
};

// Keep bounded edit deltas, so undo restores raw line endings without retaining a full document per keystroke.
const editText = (history: TextHistory, source: string, value: string, selection: EditSelection | null): { value: string; blocked: boolean } => {
  if (history.current !== source) Object.assign(history, newHistory(source));
  if (selection?.inputType === "historyUndo" || selection?.inputType === "historyRedo") {
    const undo = selection.inputType === "historyUndo";
    let candidate = source; let index = history.index;
    while (undo ? index > 0 : index < history.edits.length) {
      const edit = history.edits[undo ? --index : index++]!;
      const from = undo ? edit.inserted : edit.removed; const to = undo ? edit.removed : edit.inserted;
      candidate = candidate.slice(0, edit.start) + to + candidate.slice(edit.start + from.length);
      if (displayText(candidate) === value) { history.current = candidate; history.index = index; return { value: candidate, blocked: false }; }
    }
    return { value: source, blocked: true };
  }
  const result = preserveLineEndings(source, value, selection);
  let start = 0; while (start < source.length && start < result.length && source[start] === result[start]) start++;
  let suffix = 0; while (suffix < source.length - start && suffix < result.length - start && source[source.length - 1 - suffix] === result[result.length - 1 - suffix]) suffix++;
  history.edits.splice(history.index);
  // Copy deltas so a small slice does not retain a large source string in memory.
  const copy = (text: string): string => JSON.parse(JSON.stringify(text)) as string;
  history.edits.push({ start, removed: copy(source.slice(start, source.length - suffix)), inserted: copy(result.slice(start, result.length - suffix)) });
  history.index = history.edits.length; history.current = result;
  history.size = history.edits.reduce((total, edit) => total + edit.removed.length + edit.inserted.length, 0);
  if (history.edits.length > 1000 || history.size > 4 * 1024 * 1024) Object.assign(history, newHistory(result));
  return { value: result, blocked: false };
};

const StepRow = memo(({ step, index, total, bodyId, open, canDisplayStatus, selectionBlocked, authPaused, canMove, canAdd, canEdit, statusBusy, moveBusy, version, editor, renderMarkdown, onToggle, onStatus, onMove, onEdit }: {
  readonly step: TaskStep; readonly index: number; readonly total: number; readonly bodyId: string; readonly open: boolean;
  readonly canDisplayStatus: boolean; readonly selectionBlocked: boolean; readonly authPaused: boolean; readonly canMove: boolean; readonly canAdd: boolean; readonly canEdit: boolean;
  readonly statusBusy: boolean; readonly moveBusy: boolean; readonly version: bigint;
  readonly editor: ReactNode; readonly renderMarkdown: (text: string) => ReactNode;
  readonly onToggle: (stepId: string) => void; readonly onStatus: (stepId: string, status: StepStatus, version: bigint) => void;
  readonly onMove: (stepId: string, index: number, action: MoveAction) => void; readonly onEdit: (stepId: string) => void;
}) => {
  const { messages: { inspection: { steps: m } }, format } = useI18n();
  return <li className="step-row" data-step-id={step.id}>
    <div className="step-summary">
      <button type="button" className="step-disclosure" aria-expanded={open} aria-controls={bodyId} onClick={() => onToggle(step.id)}>
        <span className="step-chevron" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m6 3 5 5-5 5" /></svg></span>
        <span className="step-number" aria-hidden="true">{format.number(index + 1)}</span><span className="step-title">{step.title}</span>
      </button>
      <div className="step-controls"><StepStatusMenu step={step} available={canDisplayStatus} selectionBlocked={selectionBlocked || authPaused} busy={statusBusy} onSelect={(status) => onStatus(step.id, status, version)} /><code className="step-id">{step.id}</code><StepMoveMenu step={step} index={index} total={total} available={canMove} canAdd={canAdd} canEdit={canEdit} busy={moveBusy} onSelect={(action) => onMove(step.id, index, action)} /></div>
    </div>
    <div id={bodyId} className="step-detail" hidden={!open}>
      {open && <>{editor !== null ? editor : <><button className="button" type="button" onClick={() => onEdit(step.id)}>{m.editStep}</button>{step.description === "" ? <p className="step-detail-empty">{m.noDescription}</p> : renderMarkdown(step.description)}
        <dl className="step-metadata"><div><dt>{m.created}</dt><dd><time dateTime={step.createdAt}>{format.dateTime(step.createdAt)}</time></dd></div><div><dt>{m.updated}</dt><dd><time dateTime={step.updatedAt}>{format.dateTime(step.updatedAt)}</time></dd></div></dl></>}
      </>}
    </div>
  </li>;
});

export const TaskStepsPanel = ({ projectId, taskId, active, renderMarkdown, confirmationOwner, confirmationFallback, onConfirmationChange, available = true }: {
  readonly projectId: string; readonly taskId: string; readonly active: boolean;
  readonly renderMarkdown: (text: string) => ReactNode;
  readonly available?: boolean;
  readonly confirmationOwner?: RefObject<HTMLElement | null>; readonly confirmationFallback?: RefObject<HTMLElement | null>;
  readonly onConfirmationChange?: (open: boolean) => void;
}) => {
  const { messages, format } = useI18n();
  const m = messages.inspection.steps;
  const state = useTaskSteps(projectId, taskId, active);
  const sessions = useTaskDetailSessions();
  const [page, setPage] = useState(1);
  const navigationRevision = useRef(0);
  const previousActive = useRef(active);
  if (previousActive.current !== active) { previousActive.current = active; navigationRevision.current++; }
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [draft, setDraft] = useState<StepDraft | null>(null);
  const draftOwner = useRef<{ key: number; kind: StepDraft["kind"] } | null>(null);
  const activeRef = useRef(active);
  draftOwner.current = draft === null ? null : { key: draft.key, kind: draft.kind };
  activeRef.current = active;
  const draftKey = useRef(0);
  const deferredOperations = useRef(new Set<string>());
  const [deleting, setDeleting] = useState<{ step: TaskStep; version: bigint } | null>(null);
  const [deleteChanged, setDeleteChanged] = useState(false);
  const [submittedDelete, setSubmittedDelete] = useState<{ requestId: string; stepId: string; version: bigint; draftKey: number | null; draftRevision: number | null; navigation: number; next: readonly Pick<TaskStep, "id" | "createdAt">[]; previous: readonly Pick<TaskStep, "id" | "createdAt">[] } | null>(null);
  const [preview, setPreview] = useState(false);
  const [discard, setDiscard] = useState<{ key: number; kind: StepDraft["kind"] } | null>(null);
  const [switchTarget, setSwitchTarget] = useState<{ id: string; createdAt: string } | null>(null);
  const [invalidTitle, setInvalidTitle] = useState(false);
  const [invalidDescription, setInvalidDescription] = useState(false);
  const [undoUnavailable, setUndoUnavailable] = useState(false);
  const [addedMissing, setAddedMissing] = useState(false);
  const [focusStep, setFocusStep] = useState<string | null>(null);
  const workspace = useRef<HTMLElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const titleInput = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const skipEditFocus = useRef<number | null>(null);
  const restoreEditSelection = useRef<{ key: number; start: number; end: number } | null>(null);
  const chooseTarget = useRef<HTMLButtonElement>(null);
  const restoreTargetFocus = (key: number) => requestAnimationFrame(() => {
    const button = chooseTarget.current;
    if (draftOwner.current?.key === key && draftOwner.current.kind === "add" && activeRef.current && button?.isConnected && !button.closest("[hidden], [inert]")) button.focus();
  });
  const [choosingTarget, setChoosingTarget] = useState<{ key: number; selected: { id: string; createdAt: string | null } | null } | null>(null);
  const [anchorNeedsDecision, setAnchorNeedsDecision] = useState(false);
  const rejectedAnchorRequest = useRef<string | null>(null);
  const descriptionInput = useRef<HTMLTextAreaElement>(null);
  const titleHistory = useRef<TextHistory>(newHistory(""));
  const descriptionHistory = useRef<TextHistory>(newHistory(""));
  const titleSelection = useRef<EditSelection | null>(null);
  const descriptionSelection = useRef<EditSelection | null>(null);
  useLayoutEffect(() => {
    const title = titleInput.current; const description = descriptionInput.current;
    const capture = (element: HTMLInputElement | HTMLTextAreaElement, target: { current: EditSelection | null }) => (event: Event) => {
      target.current = { start: element.selectionStart ?? 0, end: element.selectionEnd ?? 0, inputType: (event as InputEvent).inputType ?? "" };
    };
    const titleBefore = title && capture(title, titleSelection); const descriptionBefore = description && capture(description, descriptionSelection);
    if (title && titleBefore) title.addEventListener("beforeinput", titleBefore);
    if (description && descriptionBefore) description.addEventListener("beforeinput", descriptionBefore);
    return () => { if (title && titleBefore) title.removeEventListener("beforeinput", titleBefore); if (description && descriptionBefore) description.removeEventListener("beforeinput", descriptionBefore); };
  });
  useDirtyTaskDraft({ isDirty: () => isDirty(draft), discard: () => { titleHistory.current = newHistory(""); descriptionHistory.current = newHistory(""); setDraft(null); setChoosingTarget(null); setDiscard(null); onConfirmationChange?.(false); } });
  useEffect(() => () => { onConfirmationChange?.(false); }, [onConfirmationChange]);
  useLayoutEffect(() => { if (!available) { setDiscard(null); onConfirmationChange?.(false); } }, [available, onConfirmationChange]);
  useLayoutEffect(() => sessions.subscribe(projectId, taskId, () => {
    const mutation = sessions.snapshot(projectId, taskId).mutation;
    if (mutation.publicationPending && mutation.operation !== null && "requestId" in mutation.operation) deferredOperations.current.add(mutation.operation.requestId);
    if (mutation.phase === "confirmed" && mutation.operation?.action === "stepAdd") {
      const { requestId, version } = mutation.operation;
      setDraft((current) => current === null || current.kind !== "add" || current.requestId !== requestId || typeof version !== "bigint" ? current : { ...current, addReceipt: { version, publicationPending: mutation.publicationPending === true, createdAt: current.addReceipt?.createdAt ?? null } });
    }
    if (!mutation.publicationPending && (mutation.phase === "confirmed" && !mutation.reconciling && mutation.reconciliationError === null || mutation.phase === "unknown") && (mutation.operation?.action === "stepAdd" || mutation.operation?.action === "stepEdit")) {
      const requestId = mutation.operation.requestId;
      setDraft((current) => current !== null && current.requestId === requestId && current.revision === current.submittedRevision ? { ...current, confirmed: current.confirmed || mutation.phase === "confirmed", uncertain: current.uncertain || mutation.phase === "unknown" } : current);
    }
  }), [sessions, projectId, taskId]);
  const id = useId();
  const submittedMove = useRef<{ stepId: string; navigation: number } | null>(null);
  const focusMove = useRef<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const navigationDecision = useDraftNavigationDecision();
  const interruptedMove = useRef(false);
  const observedDecision = useRef<typeof navigationDecision>(null);
  useLayoutEffect(() => {
    if (navigationDecision !== null) {
      if (observedDecision.current !== navigationDecision) {
        observedDecision.current = navigationDecision;
        setDraft((current) => current === null || current.requestId === null ? current : { ...current, revision: current.revision + 1, holdForTarget: current.kind === "add" || current.holdForTarget });
      }
      if (movingId !== null) interruptedMove.current = true;
      setMovingId(null); setDeleting(null);
      onConfirmationChange?.(false);
    } else {
      const resumed = observedDecision.current !== null;
      observedDecision.current = null;
      if (resumed && discard && available) onConfirmationChange?.(true);
      if (interruptedMove.current) {
        interruptedMove.current = false;
        if (draft !== null && active) titleInput.current?.focus();
      }
    }
  }, [navigationDecision, movingId, choosingTarget, draft, active, discard, available, onConfirmationChange]);
  const resource = state.resource;
  const total = resource?.steps.length ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const [pageInput, setPageInput] = useState("1");
  useEffect(() => { setPageInput(String(currentPage)); }, [currentPage]);
  const applyPageInput = () => {
    navigationRevision.current++;
    const next = Number(pageInput);
    if (Number.isSafeInteger(next) && next >= 1 && next <= pages) setPage(next);
    else setPageInput(String(currentPage));
  };
  const start = (currentPage - 1) * PAGE_SIZE;
  const busy = state.status === "loading" || state.refreshing;
  const toggle = useCallback((stepId: string) => setExpanded((previous) => {
    const next = new Set(previous);
    if (next.has(stepId)) next.delete(stepId);
    else next.add(stepId);
    return next;
  }), []);
  const error = state.error;
  const explanation = error instanceof ApiError ? error.kind === "network" ? m.networkError
    : error.kind === "protocol" ? m.protocolError : error.status === 404 ? m.unavailable
      : error.status === 403 ? m.denied : m.requestFailed : m.requestFailed;
  const mutation = state.mutation;
  const ownAdd = draft !== null && draft.requestId !== null && (mutation.operation?.action === "stepAdd" || mutation.operation?.action === "stepEdit") && mutation.operation.requestId === draft.requestId ? mutation : null;
  const ownDelete = submittedDelete !== null && draft?.key === submittedDelete.draftKey && mutation.operation?.action === "stepDelete" && mutation.operation.requestId === submittedDelete.requestId ? mutation : null;
  const interruptedDraftNavigation = draft?.requestId !== null && draft?.requestId !== undefined && deferredOperations.current.has(draft.requestId) && draft.submittedNavigation !== navigationRevision.current;
  const unappliedAddChoices = draft?.kind === "add" && draft.submittedContent !== null && (draft.status !== draft.submittedContent.status || draft.placement !== draft.submittedContent.placement || draft.anchorId !== draft.submittedContent.anchorId || draft.anchorCreatedAt !== draft.submittedContent.anchorCreatedAt);
  const addReceipt = draft?.kind === "add" ? draft.addReceipt : null;
  const savedAdd = draft?.kind === "add" && resource !== null ? resource.steps.find((step) => step.id === draft.id) : undefined;
  const initialAddReceipt = addReceipt !== null && addReceipt !== undefined && !addReceipt.publicationPending && !ownAdd?.reconciling && ownAdd?.reconciliationError == null && draft?.submittedContent !== null && draft?.submittedContent !== undefined && resource !== null && !state.stale && state.error === null && resource.version === addReceipt.version + 1n && savedAdd !== undefined && savedAdd.title === draft.submittedContent.title && savedAdd.description === draft.submittedContent.description && savedAdd.status === draft.submittedContent.status;
  const addCreatedAt = addReceipt?.createdAt ?? (initialAddReceipt ? savedAdd!.createdAt : null);
  const originalAddCurrent = addReceipt !== null && addReceipt !== undefined && !addReceipt.publicationPending && mutation.phase !== "pending" && !mutation.reconciling && resource !== null && !state.stale && state.error === null && resource.version > addReceipt.version && savedAdd !== undefined && addCreatedAt !== null && savedAdd.createdAt === addCreatedAt;
  useEffect(() => {
    if (draft?.kind !== "add" || draft.addReceipt === null || draft.addReceipt.createdAt !== null || !initialAddReceipt || savedAdd === undefined) return;
    setDraft((current) => current !== draft ? current : { ...current, addReceipt: { ...current.addReceipt!, createdAt: savedAdd.createdAt } });
  }, [draft, initialAddReceipt, savedAdd]);
  const frozen = !interruptedDraftNavigation && draft?.confirmed === true || ownDelete !== null && !ownDelete.publicationPending && draft?.revision === submittedDelete?.draftRevision && (ownDelete.phase === "pending" || ownDelete.phase === "unknown" || ownDelete.phase === "confirmed") || ownAdd !== null && !ownAdd.publicationPending && !interruptedDraftNavigation && draft?.revision === draft?.submittedRevision && (ownAdd.phase === "pending" || ownAdd.phase === "unknown" || ownAdd.phase === "confirmed");
  const duplicateId = ownAdd?.phase === "refused" && ownAdd.error instanceof ApiError && ownAdd.error.code === "step_id_conflict";
  useEffect(() => {
    if (draft?.kind === "add" && ownAdd?.phase === "refused" && ownAdd.error instanceof ApiError && ownAdd.error.status === 404 && draft.requestId && rejectedAnchorRequest.current !== draft.requestId) {
      rejectedAnchorRequest.current = draft.requestId;
      setAnchorNeedsDecision(true);
    }
  }, [ownAdd, draft?.kind, draft?.requestId]);
  const dirty = isDirty(draft);
  const closeDraft = () => { titleHistory.current = newHistory(""); descriptionHistory.current = newHistory(""); setDraft(null); setChoosingTarget(null); setDiscard(null); setSwitchTarget(null); onConfirmationChange?.(false); setInvalidTitle(false); setInvalidDescription(false); setPreview(false); };
  const preserveDraftInteraction = () => setDraft((current) => current === null || current.requestId === null ? current : { ...current, revision: current.revision + 1, holdForTarget: current.kind === "add" || current.holdForTarget });
  const cancelDraft = () => { if (dirty && draft !== null) { preserveDraftInteraction(); setDiscard({ key: draft.key, kind: draft.kind }); onConfirmationChange?.(true); } else { const target = draft?.kind === "edit" ? draft.id : ""; closeDraft(); setFocusStep(target); } };
  useEffect(() => {
    const confirmedAdd = draft?.kind === "add" && draft.addReceipt !== null;
    if (draft === null || choosingTarget?.key === draft.key || draft.holdForTarget || discard || navigationDecision !== null || deleting !== null || movingId !== null || !confirmedAdd && ownAdd?.phase !== "confirmed" || confirmedAdd && (draft.addReceipt!.publicationPending || mutation.phase === "pending" || mutation.reconciling) || ownAdd?.publicationPending || ownAdd?.reconciling || ownAdd?.reconciliationError != null || resource === null || state.stale || state.error !== null || draft.submittedContent === null || unappliedAddChoices || !interruptedDraftNavigation && draft.revision === draft.submittedRevision) return;
    const operation = confirmedAdd ? { action: "stepAdd" as const, version: draft.addReceipt!.version } : ownAdd!.operation;
    if (operation === null || (operation.action !== "stepAdd" && operation.action !== "stepEdit") || resource.version < operation.version) return;
    const saved = resource.steps.find((step) => step.id === draft.id);
    const matches = saved !== undefined && saved.title === draft.submittedContent.title && saved.description === draft.submittedContent.description && (draft.kind === "edit" || saved.status === draft.submittedContent.status);
    if (draft.kind === "add" && resource.version <= operation.version || !matches && resource.version === operation.version) return;
    const sameInstance = saved !== undefined && (draft.kind === "edit" ? saved.createdAt === draft.originalCreatedAt : originalAddCurrent);
    if (draft.kind === "add") {
      skipEditFocus.current = draft.key;
      const input = titleInput.current;
      if (input !== null && document.activeElement === input) restoreEditSelection.current = { key: draft.key, start: input.selectionStart ?? 0, end: input.selectionEnd ?? 0 };
    }
    setDraft((current) => current !== draft ? current : { ...current, kind: "edit", standalone: current.kind === "add" || current.standalone, originalTitle: matches && sameInstance ? saved!.title : current.submittedContent!.title, originalDescription: matches && sameInstance ? saved!.description : current.submittedContent!.description, originalCreatedAt: sameInstance ? saved!.createdAt : current.originalCreatedAt, retired: !sameInstance, review: sameInstance && !matches ? { version: resource.version, acknowledged: false } : null, requestId: null, addReceipt: null, submittedRevision: null, submittedNavigation: null, submittedContent: null, confirmed: false, uncertain: false });
  }, [draft, ownAdd, resource, state.stale, state.error, interruptedDraftNavigation, unappliedAddChoices, originalAddCurrent, choosingTarget, discard, navigationDecision, deleting, movingId]);
  useEffect(() => {
    if (draft === null || choosingTarget?.key === draft.key || draft.holdForTarget || discard || navigationDecision !== null || deleting !== null || movingId !== null || !draft.confirmed || interruptedDraftNavigation || draft.revision !== draft.submittedRevision || resource === null || state.stale || state.error !== null || draft.kind === "edit" && (draft.retired || !resource.steps.some((step) => step.id === draft.id && step.createdAt === draft.originalCreatedAt))) return;
    const index = resource.steps.findIndex((step) => step.id === draft.id);
    if (index < 0) { setAddedMissing(true); setFocusStep(""); }
    else { setPage(Math.floor(index / PAGE_SIZE) + 1); setFocusStep(draft.id); }
    closeDraft();
  }, [draft, resource, state.stale, state.error, interruptedDraftNavigation, choosingTarget, discard, navigationDecision, deleting, movingId]);
  useLayoutEffect(() => {
    if (focusStep === null || !active) return;
    const target = focusStep === "" ? (addButton.current?.disabled ? titleInput.current : addButton.current) : workspace.current?.querySelector<HTMLButtonElement>(`[data-step-id="${focusStep}"] .step-disclosure`);
    if (target) { target.focus(); setFocusStep(null); }
  }, [focusStep, currentPage, active, resource]);
  const otherAdd = (mutation.operation?.action === "stepAdd" || mutation.operation?.action === "stepEdit") && ownAdd === null ? mutation : null;
  const isPosition = mutation.operation?.action === "stepPosition";
  const isDelete = mutation.operation?.action === "stepDelete";
  const stepMutation = mutation.operation?.action === "stepStatus" || isPosition || isDelete ? mutation : null;
  useLayoutEffect(() => {
    if (deleting !== null && (!active || !available || resource === null)) { setDeleting(null); onConfirmationChange?.(false); }
  }, [active, available, resource, deleting, onConfirmationChange]);
  useEffect(() => {
    if (submittedDelete === null) return;
    const current = mutation.operation?.action === "stepDelete" && mutation.operation.requestId === submittedDelete.requestId;
    if (!current || mutation.phase !== "confirmed") {
      if (current && ["refused", "conflict", "reconciled"].includes(mutation.phase)) setSubmittedDelete(null);
      return;
    }
    // A replacement cache history can retract a validated receipt while admission is pending.
    if (mutation.publicationPending || mutation.reconciling || mutation.reconciliationError !== null || resource === null || resource.version <= submittedDelete.version || state.stale || state.error !== null) return;
    const navigationCurrent = !deferredOperations.current.has(submittedDelete.requestId) || navigationRevision.current === submittedDelete.navigation;
    const matchingDraft = draft !== null && draft.key === submittedDelete.draftKey && draft.revision === submittedDelete.draftRevision && navigationCurrent;
    const editingOther = draft !== null && !matchingDraft && document.activeElement instanceof HTMLElement && document.activeElement.closest(".step-add-form") !== null;
    if (matchingDraft) closeDraft();
    setExpanded((previous) => { const next = new Set(previous); next.delete(submittedDelete.stepId); return next; });
    if (active && !editingOther && navigationCurrent) {
      const current = new Map(resource.steps.map((step) => [step.id, step.createdAt]));
      const target = [...submittedDelete.next, ...submittedDelete.previous].find((candidate) => current.get(candidate.id) === candidate.createdAt)?.id ?? "";
      const index = resource.steps.findIndex((step) => step.id === target);
      setPage(index < 0 ? Math.max(1, Math.ceil(resource.steps.length / PAGE_SIZE)) : Math.floor(index / PAGE_SIZE) + 1);
      setFocusStep(target);
    }
    setSubmittedDelete(null);
  }, [submittedDelete, mutation, resource, state.stale, state.error, draft, active]);
  const moving = resource?.steps.find((step) => step.id === movingId) ?? null;
  useLayoutEffect(() => {
    if (!active || resource === null) {
      setMovingId(null);
      if (active) { submittedMove.current = null; focusMove.current = null; }
    }
  }, [active, resource]);
  useLayoutEffect(() => {
    if (!active || submittedMove.current === null || !isPosition || mutation.operation?.stepId !== submittedMove.current.stepId) return;
    if (mutation.phase === "confirmed" && !mutation.publicationPending && !mutation.reconciling && resource !== null) {
      const index = resource.steps.findIndex((step) => step.id === submittedMove.current!.stepId);
      const editing = document.activeElement instanceof HTMLElement && document.activeElement.closest(".step-add-form") !== null;
      if (index >= 0 && !editing && (mutation.operation?.requestId === undefined || !deferredOperations.current.has(mutation.operation.requestId) || navigationRevision.current === submittedMove.current.navigation)) { focusMove.current = submittedMove.current.stepId; setPage(Math.floor(index / PAGE_SIZE) + 1); }
      submittedMove.current = null;
    } else if (["refused", "conflict", "unknown", "reconciled"].includes(mutation.phase)) submittedMove.current = null;
  }, [active, isPosition, mutation, resource]);
  useLayoutEffect(() => {
    if (focusMove.current === null || resource === null) return;
    const index = resource.steps.findIndex((step) => step.id === focusMove.current);
    if (index < 0 || Math.floor(index / PAGE_SIZE) + 1 !== currentPage) return;
    const row = Array.from(workspace.current?.querySelectorAll<HTMLElement>("[data-step-id]") ?? []).find((item) => item.dataset.stepId === focusMove.current);
    const button = row?.querySelector<HTMLButtonElement>(".step-more");
    if (button) { button.focus(); button.scrollIntoView?.({ block: "nearest" }); focusMove.current = null; }
  });
  const submitMove = useCallback((stepId: string, placement: { position: "first" | "last" } | { before: string } | { after: string }) => {
    if (resource === null || !state.canMove) return;
    submittedMove.current = { stepId, navigation: navigationRevision.current };
    state.move(stepId, placement, resource.version);
  }, [resource, state.canMove, state.move]);
  const hasDraft = draft !== null;
  const startAdd = useCallback((placement: StepDraft["placement"], anchorId: string | null) => {
    if (hasDraft) return;
    if (placement === "last") setPage(pages);
    setPreview(false); setInvalidTitle(false); setInvalidDescription(false); setAddedMissing(false);
    setAnchorNeedsDecision(false);
    titleHistory.current = newHistory(""); descriptionHistory.current = newHistory(""); setUndoUnavailable(false);
    const anchorCreatedAt = resource?.steps.find((step) => step.id === anchorId)?.createdAt ?? null;
    setDraft({ key: ++draftKey.current, revision: 0, submittedRevision: null, submittedNavigation: null, submittedContent: null, addReceipt: null, review: null, standalone: false, holdForTarget: false, kind: "add", id: crypto.randomUUID().slice(0, 8), title: "", description: "", status: "todo", originalTitle: "", originalDescription: "", originalCreatedAt: null, retired: false, placement, anchorId, anchorCreatedAt, initialPlacement: placement, initialAnchorId: anchorId, initialAnchorCreatedAt: anchorCreatedAt, requestId: null, confirmed: false, uncertain: false });
  }, [hasDraft, pages, resource]);
  const authPaused = authRequestsPaused();
  const pendingStepId = mutation.operation?.action === "stepStatus" && mutation.phase === "pending" ? mutation.operation.stepId : null;
  const pendingMoveId = (isPosition || isDelete) && mutation.phase === "pending" ? mutation.operation.stepId : null;
  const unresolved = stepMutation?.phase === "unknown" || stepMutation?.phase === "conflict" || stepMutation?.reconciliationError != null || (mutation.operation?.action === "stepAdd" || mutation.operation?.action === "stepEdit") && (mutation.phase === "unknown" || mutation.phase === "conflict" || mutation.reconciliationError !== null);
  const mutationError = stepMutation?.error;
  const resolvedConflict = stepMutation?.phase === "reconciled" && stepMutation.reconciledFrom === "conflict";
  const resolvedUnknown = stepMutation?.phase === "reconciled" && stepMutation.reconciledFrom === "unknown";
  const refusal = mutationError instanceof ApiError ? mutationError.status === 404 ? isDelete ? m.deleteMissing : isPosition ? m.moveMissing : m.statusMissing : mutationError.status === 403 ? m.statusDenied
    : mutationError.code === "version_exhausted" ? m.statusExhausted : mutationError.code === "steps_limit_exceeded" ? m.statusCapacity
      : mutationError.code === "invalid_input" ? isDelete ? m.deleteRefused : isPosition ? m.moveInvalid : m.statusInvalid : isDelete ? m.deleteRefused : isPosition ? m.moveRefused : m.statusRefused : isDelete ? m.deleteRefused : isPosition ? m.moveRefused : m.statusRefused;
  const anchor = draft?.anchorId === null || draft?.anchorId === undefined ? null : resource?.steps.find((step) => step.id === draft.anchorId) ?? null;
  const missingAnchor = draft?.kind === "add" && draft.placement !== "last" && draft.anchorId !== null && resource !== null && (anchor === null || anchor.createdAt !== draft.anchorCreatedAt);
  useEffect(() => { if (missingAnchor) setAnchorNeedsDecision(true); }, [missingAnchor]);

  useLayoutEffect(() => { if (draft?.kind === "edit" && active) { const restore = restoreEditSelection.current; if (restore?.key === draft.key && titleInput.current !== null) { titleInput.current.focus(); titleInput.current.setSelectionRange(restore.start, restore.end); restoreEditSelection.current = null; skipEditFocus.current = null; } else if (skipEditFocus.current === draft.key) skipEditFocus.current = null; else titleInput.current?.focus(); } }, [draft?.kind, draft?.id, active]);
  const currentDraftStep = draft?.kind === "edit" ? resource?.steps.find((step) => step.id === draft.id) : undefined;
  const editTargetAvailable = draft?.kind === "edit" && !draft.retired && currentDraftStep?.createdAt === draft.originalCreatedAt;
  const needsReview = draft?.review !== null && draft?.review !== undefined && (!draft.review.acknowledged || draft.review.version !== resource?.version);
  useEffect(() => {
    if (draft?.kind === "edit" && !draft.retired && resource !== null && !state.stale && state.error === null && !editTargetAvailable) {
      setDraft((current) => current === draft ? { ...current, retired: true, confirmed: false } : current);
    }
  }, [draft, resource, state.stale, state.error, editTargetAvailable]);
  const beginEdit = useCallback((stepId: string) => {
    const step = resource?.steps.find((item) => item.id === stepId);
    if (!step) return;
    titleHistory.current = newHistory(step.title); descriptionHistory.current = newHistory(step.description); setUndoUnavailable(false);
    setDraft({ key: ++draftKey.current, revision: 0, submittedRevision: null, submittedNavigation: null, submittedContent: null, addReceipt: null, review: null, standalone: false, holdForTarget: false, kind: "edit", id: step.id, title: step.title, description: step.description, status: step.status, originalTitle: step.title, originalDescription: step.description, originalCreatedAt: step.createdAt, retired: false, placement: "last", anchorId: null, anchorCreatedAt: null, initialPlacement: "last", initialAnchorId: null, initialAnchorCreatedAt: null, requestId: null, confirmed: false, uncertain: false });
    setExpanded((previous) => new Set(previous).add(step.id));
    setPreview(false); setInvalidTitle(false); setInvalidDescription(false); setAddedMissing(false);
  }, [resource]);
  const editDraftId = draft?.kind === "edit" ? draft.id : null;
  const editDraftRetired = draft?.kind === "edit" ? draft.retired : false;
  const editDraftCreatedAt = draft?.kind === "edit" ? draft.originalCreatedAt : null;
  const currentDraftCreatedAt = currentDraftStep?.createdAt;
  const selectEdit = useCallback((stepId: string) => {
    if (editDraftId === stepId && !editDraftRetired && currentDraftCreatedAt === editDraftCreatedAt) { titleInput.current?.focus(); return; }
    if (dirty && draft !== null) { const target = resource?.steps.find((step) => step.id === stepId); if (target === undefined) return; preserveDraftInteraction(); setSwitchTarget({ id: stepId, createdAt: target.createdAt }); setDiscard({ key: draft.key, kind: draft.kind }); onConfirmationChange?.(true); }
    else beginEdit(stepId);
  }, [editDraftId, editDraftRetired, currentDraftCreatedAt, editDraftCreatedAt, dirty, draft, resource, beginEdit, onConfirmationChange]);
  const move = useCallback((stepId: string, index: number, action: MoveAction) => {
    if (resource === null) return;
    if (action === "addBefore" || action === "addAfter") { startAdd(action === "addBefore" ? "before" : "after", stepId); return; }
    if (action === "edit") { selectEdit(stepId); return; }
    if (action === "delete") { const target = resource.steps.find((step) => step.id === stepId); if (target) { preserveDraftInteraction(); setDeleteChanged(false); setDeleting({ step: target, version: resource.version }); onConfirmationChange?.(true); } return; }
    if (action === "relative") { preserveDraftInteraction(); setMovingId(stepId); return; }
    if (action === "first" || action === "last") submitMove(stepId, { position: action });
    else if (action === "up" && index > 0) submitMove(stepId, { before: resource.steps[index - 1]!.id });
    else if (action === "down" && index + 1 < resource.steps.length) submitMove(stepId, { after: resource.steps[index + 1]!.id });
  }, [resource, startAdd, selectEdit, submitMove, onConfirmationChange]);
  const editor = draft !== null && <form className={draft.kind === "edit" ? "step-add-form step-edit-form" : "step-add-form"} onSubmit={(event) => {
      event.preventDefault();
      if (!/[^\p{White_Space}]/u.test(draft.title) || invalidText(draft.title)) { setInvalidTitle(true); titleInput.current?.focus(); return; }
      if (invalidText(draft.description)) { setInvalidDescription(true); setPreview(false); return; }
      if (resource === null || !state.canAdd || authRequestsPaused() || frozen || ownAdd?.phase === "confirmed" || addReceipt !== null && addReceipt !== undefined || needsReview || draft.kind === "edit" && !editTargetAvailable || draft.kind === "add" && (anchorNeedsDecision || draft.placement !== "last" && (draft.anchorId === null || missingAnchor))) return;
      const placement = draft.placement === "last" ? undefined : draft.placement === "before" ? { before: draft.anchorId! } : { after: draft.anchorId! };
      const requestId = draft.kind === "edit" ? state.edit(draft.id, draft.title, draft.description, resource.version) : placement === undefined ? state.add(draft.id, draft.title, draft.description, draft.status, resource.version) : state.add(draft.id, draft.title, draft.description, draft.status, resource.version, placement);
      if (requestId !== null) setDraft({ ...draft, requestId, submittedRevision: draft.revision, submittedNavigation: navigationRevision.current, addReceipt: null, submittedContent: { title: draft.title, description: draft.description, status: draft.status, placement: draft.placement, anchorId: draft.anchorId, anchorCreatedAt: draft.anchorCreatedAt }, review: null });
    }} onKeyDown={(event) => { if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; if (isNativeSelectPopupOpen(event.target)) { event.stopPropagation(); return; } if (!discard) { event.preventDefault(); event.stopPropagation(); cancelDraft(); } }}>
      <label>{m.addTitle}{draft.kind === "edit" ? <textarea className="step-title-editor" ref={titleInput as RefObject<HTMLTextAreaElement | null>} value={draft.title} disabled={frozen} aria-invalid={invalidTitle} aria-describedby={invalidTitle ? `${id}-title-error` : undefined} onChange={(event) => { const result = editText(titleHistory.current, draft.title, event.currentTarget.value, titleSelection.current); setDraft({ ...draft, revision: draft.revision + 1, title: result.value }); setUndoUnavailable(result.blocked); titleSelection.current = null; setInvalidTitle(false); }} /> : <input ref={titleInput as RefObject<HTMLInputElement | null>} autoFocus value={draft.title} disabled={frozen} aria-invalid={invalidTitle} aria-describedby={invalidTitle ? `${id}-title-error` : undefined} onChange={(event) => { setDraft({ ...draft, revision: draft.revision + 1, title: event.currentTarget.value }); setInvalidTitle(false); }} />}</label>
      {undoUnavailable && <p className="step-field-error" role="alert">{m.undoUnavailable}</p>}
      {invalidTitle && <p className="step-field-error" id={`${id}-title-error`} role="alert">{invalidText(draft.title) ? m.invalidText : m.titleRequired}</p>}
      {draft.kind === "add" && <label>{m.initialStatus}<NativeSelect density="form" layout="fill" focusTone="task" value={draft.status} disabled={frozen} onChange={(event) => setDraft({ ...draft, revision: draft.revision + 1, status: event.currentTarget.value as StepStatus })}>{(["todo", "in_progress", "done", "skipped"] as const).map((value) => <option key={value} value={value}>{m.status[value]}</option>)}</NativeSelect></label>}
      {draft.kind === "add" && <label>{m.placement}<NativeSelect density="form" layout="fill" focusTone="task" value={draft.placement} disabled={frozen} onChange={(event) => { const placement = event.currentTarget.value as StepDraft["placement"]; setDraft({ ...draft, revision: draft.revision + 1, placement, anchorId: placement === "last" ? null : draft.anchorId, anchorCreatedAt: placement === "last" ? null : draft.anchorCreatedAt }); if (placement === "last") setAnchorNeedsDecision(false); }}><option value="last">{m.addEnd}</option><option value="before">{m.before}</option><option value="after">{m.after}</option></NativeSelect></label>}
      {draft.kind === "add" && draft.placement !== "last" && <div className="step-add-target">{anchor !== null && <div className="step-target-selected"><span>{m.target}</span><strong>{anchor.title}</strong><code className="step-id">{anchor.id}</code></div>}{(missingAnchor || anchorNeedsDecision && ownAdd?.phase !== "refused") && <p role="alert">{m.targetMissing} <code>{draft.anchorId}</code></p>}<button ref={chooseTarget} className="button" type="button" disabled={frozen || resource === null} onClick={() => { preserveDraftInteraction(); setChoosingTarget({ key: draft.key, selected: draft.anchorId === null ? null : { id: draft.anchorId, createdAt: draft.anchorCreatedAt } }); }}>{m.chooseTarget}</button></div>}
      {unappliedAddChoices && addReceipt !== null && addReceipt !== undefined && draft.submittedContent !== null && <div className="steps-error" role="status"><p>{originalAddCurrent ? m.addChoicesRetained : m.addChoicesUnverified}</p>{originalAddCurrent && <button className="button" type="button" onClick={() => { const submitted = draft.submittedContent!; setDraft({ ...draft, revision: draft.revision + 1, status: submitted.status, placement: submitted.placement, anchorId: submitted.anchorId, anchorCreatedAt: submitted.anchorCreatedAt, holdForTarget: false }); setAnchorNeedsDecision(false); }}>{m.restoreAddChoices}</button>}</div>}
      {draft.kind === "add" && draft.holdForTarget && !unappliedAddChoices && addReceipt !== null && originalAddCurrent && <div className="steps-error" role="status"><p>{m.addReadyToEdit}</p><button className="button" type="button" onClick={() => { restoreEditSelection.current = { key: draft.key, start: draft.title.length, end: draft.title.length }; setDraft({ ...draft, revision: draft.revision + 1, holdForTarget: false }); }}>{m.editCreatedStep}</button></div>}
      {draft.kind === "add" && draft.holdForTarget && !unappliedAddChoices && addReceipt !== null && !originalAddCurrent && <div className="steps-error" role="status"><p>{m.addIdentityUnverified}</p></div>}
      <div className="step-editor-heading"><span>{m.description}</span><div><button type="button" aria-pressed={!preview} onClick={() => { if (preview) preserveDraftInteraction(); setPreview(false); }}>{m.edit}</button><button type="button" aria-pressed={preview} onClick={() => { if (!preview) preserveDraftInteraction(); setPreview(true); }}>{m.preview}</button></div></div>
      <textarea ref={descriptionInput} aria-label={m.description} aria-invalid={invalidDescription} aria-describedby={invalidDescription ? `${id}-description-error` : undefined} hidden={preview} value={draft.description} disabled={frozen} onChange={(event) => { const result = editText(descriptionHistory.current, draft.description, event.currentTarget.value, descriptionSelection.current); setDraft({ ...draft, revision: draft.revision + 1, description: result.value }); setUndoUnavailable(result.blocked); descriptionSelection.current = null; setInvalidDescription(false); }} />
      {invalidDescription && <p className="step-field-error" id={`${id}-description-error`} role="alert">{m.invalidText}</p>}
      {preview && <div className="step-add-preview">{draft.description === "" ? <p>{m.noDescription}</p> : renderMarkdown(draft.description)}</div>}
      {draft.kind === "edit" && currentDraftStep && (needsReview || ownAdd?.phase === "reconciled" || currentDraftStep.title !== draft.originalTitle || currentDraftStep.description !== draft.originalDescription) && <div className="step-current-content"><strong>{m.currentContent}</strong><p>{currentDraftStep.title}</p>{currentDraftStep.description === "" ? <p>{m.noDescription}</p> : renderMarkdown(currentDraftStep.description)}</div>}
      {needsReview && currentDraftStep && resource !== null && <div className="steps-error" role="alert"><p>{m.editChanged}</p><button className="button" type="button" disabled={!editTargetAvailable || state.stale || state.error !== null} onClick={() => setDraft({ ...draft, revision: draft.revision + 1, originalTitle: currentDraftStep.title, originalDescription: currentDraftStep.description, review: { version: resource.version, acknowledged: true } })}>{m.reviewCurrent}</button></div>}
      {draft.kind === "edit" && resource !== null && !editTargetAvailable && <div className="steps-error" role="alert">{m.editMissing}</div>}
      {draft.uncertain && ownAdd === null && <div className="steps-error" role="alert"><p>{m.addUnknownReconciled} <code>{draft.id}</code></p></div>}
      {ownAdd !== null && (ownAdd.phase === "unknown" || ownAdd.phase === "conflict" || ownAdd.phase === "reconciled" || ownAdd.phase === "refused" || ownAdd.reconciliationError !== null) && <div className="steps-error" role="alert">
        {ownAdd.phase === "unknown" && <p>{draft.kind === "edit" ? m.editUnknown : m.addUnknown} <code>{draft.id}</code></p>}{ownAdd.phase === "conflict" && <p>{m.addConflict}</p>}
        {ownAdd.phase === "reconciled" && <p>{ownAdd.reconciledFrom === "unknown" ? m.addUnknownReconciled : m.addConflictReconciled} {ownAdd.reconciledFrom === "unknown" && <code>{draft.id}</code>}</p>}
        {ownAdd.phase === "refused" && <p>{draft.kind === "edit" && ownAdd.error instanceof ApiError && ownAdd.error.status === 404 ? m.editMissing : draft.kind === "edit" ? ownAdd.error instanceof ApiError && ownAdd.error.code === "steps_limit_exceeded" ? m.statusCapacity : ownAdd.error instanceof ApiError && ownAdd.error.code === "version_exhausted" ? m.statusExhausted : ownAdd.error instanceof ApiError && ownAdd.error.status === 403 ? m.statusDenied : ownAdd.error instanceof ApiError && ownAdd.error.code === "invalid_input" ? m.addInvalid : m.editRefused : duplicateId ? m.duplicateId : ownAdd.error instanceof ApiError && ownAdd.error.status === 404 ? m.addMissing : ownAdd.error instanceof ApiError && ownAdd.error.code === "steps_limit_exceeded" ? m.statusCapacity : ownAdd.error instanceof ApiError && ownAdd.error.code === "version_exhausted" ? m.statusExhausted : ownAdd.error instanceof ApiError && ownAdd.error.code === "invalid_input" ? m.addInvalid : ownAdd.error instanceof ApiError && ownAdd.error.status === 403 ? m.addDenied : m.addRefused}</p>}
        {ownAdd.phase === "refused" && ownAdd.error instanceof ApiError && ownAdd.error.status === 404 && <button className="button" type="button" disabled={busy || !active} onClick={state.retry}>{m.checkState}</button>}
        {duplicateId && !draft.uncertain && <button className="button" type="button" onClick={() => setDraft({ ...draft, revision: draft.revision + 1, id: crypto.randomUUID().slice(0, 8), requestId: null })}>{m.chooseId}</button>}
        {ownAdd.error instanceof ApiError && ownAdd.error.stepsLimit !== undefined && <p>{m.capacityDetails(format.number(ownAdd.error.stepsLimit.encodedBytes), format.number(ownAdd.error.stepsLimit.maxEncodedBytes))}</p>}
        {ownAdd.error instanceof ApiError && ownAdd.error.requestId !== null && <p className="request-id">{messages.common.requestId} <code>{ownAdd.error.requestId}</code></p>}
        {ownAdd.reconciliationError !== null && <p>{m.checkFailed}</p>}
        {(ownAdd.phase === "unknown" || ownAdd.phase === "conflict" || ownAdd.reconciliationError !== null) && <button className="button" type="button" disabled={ownAdd.reconciling} onClick={state.reconcile}>{ownAdd.reconciling ? m.checking : m.checkState}</button>}
      </div>}
      <div className="step-add-actions"><button className="button" type="button" onClick={cancelDraft}>{m.cancel}</button><button className="button primary" type="submit" disabled={!state.canAdd || authPaused || frozen || ownAdd?.phase === "confirmed" || addReceipt !== null && addReceipt !== undefined || needsReview || duplicateId || draft.kind === "edit" && !editTargetAvailable || draft.kind === "add" && (anchorNeedsDecision || draft.placement !== "last" && (draft.anchorId === null || missingAnchor))} aria-busy={ownAdd?.phase === "pending" || ownAdd?.reconciling}>{ownAdd?.phase === "pending" && <span className="spinner" aria-hidden="true" />}{m.save}</button></div>
    </form>;

  return <section className="steps-workspace" aria-label={m.title} ref={workspace}>
    <div className="steps-toolbar">
      <strong className="steps-counts">{resource === null ? m.title : m.count(format.number(total))}</strong>
      <div className="steps-toolbar-actions">
      <button className="button steps-refresh" type="button" aria-label={m.refresh} aria-busy={busy} disabled={busy || !active || unresolved} onClick={state.retry}>
        {busy ? <span className="spinner" aria-hidden="true" /> : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 11-2l3 3M4 16l3 3a7 7 0 0 0 11-2" /></svg>}
      </button>
      <button className="button primary" type="button" ref={addButton} disabled={!active || resource === null || draft !== null} onClick={() => startAdd("last", null)}>{m.add}</button></div>
    </div>
    {error !== null && <div className="steps-error" role="alert">
      <h3>{resource === null ? m.loadFailed : m.refreshFailed}</h3><p>{explanation}</p>
      {resource !== null && <p>{m.retained}</p>}
      {error instanceof ApiError && error.requestId !== null && <p className="request-id">{messages.common.requestId} <code>{error.requestId}</code></p>}
      <button className="button" type="button" disabled={busy || !active || unresolved} onClick={state.retry}>{m.retry}</button>
    </div>}
    {draft?.kind === "edit" && !draft.standalone && resource !== null && editTargetAvailable && (!resource.steps.slice(start, start + PAGE_SIZE).some((step) => step.id === draft.id) || !expanded.has(draft.id)) && <button className="button" type="button" onClick={() => { navigationRevision.current++; const index = resource.steps.findIndex((step) => step.id === draft.id); setPage(Math.floor(index / PAGE_SIZE) + 1); setExpanded((previous) => new Set(previous).add(draft.id)); requestAnimationFrame(() => titleInput.current?.focus()); }}>{m.returnEditing}</button>}
    {deleteChanged && <div className="steps-error" role="alert"><p>{m.deleteChanged}</p><button className="button" type="button" disabled={busy || !active} onClick={() => { setDeleteChanged(false); state.retry(); }}>{m.checkState}</button></div>}
    {addedMissing && <div className="steps-error" role="status">{m.addedMissing}</div>}
    {stepMutation !== null && (unresolved || resolvedConflict || resolvedUnknown || stepMutation.phase === "refused") && <div className="steps-error" role="alert">
      {stepMutation.phase === "unknown" && <p>{isDelete ? m.deleteUnknown : isPosition ? m.moveUnknown : m.unknown}</p>}
      {stepMutation.phase === "conflict" && <p>{isDelete ? m.deleteConflict : isPosition ? m.moveConflict : m.conflict}</p>}
      {resolvedConflict && <p>{isDelete ? m.deleteConflictReconciled : isPosition ? m.moveConflictReconciled : m.conflictReconciled}</p>}
      {resolvedUnknown && <p>{m.unknownReconciled}</p>}
      {stepMutation.phase === "refused" && <p>{refusal}</p>}
      {stepMutation.phase === "refused" && mutationError instanceof ApiError && mutationError.stepsLimit !== undefined && <p>{m.capacityDetails(format.number(mutationError.stepsLimit.encodedBytes), format.number(mutationError.stepsLimit.maxEncodedBytes))}</p>}
      {mutationError instanceof ApiError && mutationError.requestId !== null && <p className="request-id">{messages.common.requestId} <code>{mutationError.requestId}</code></p>}
      {stepMutation.reconciliationError !== null && <p>{m.checkFailed}</p>}
      {unresolved && <button className="button" type="button" disabled={stepMutation.reconciling} onClick={state.reconcile}>{stepMutation.reconciling ? m.checking : m.checkState}</button>}
      {stepMutation.phase === "refused" && mutationError instanceof ApiError && mutationError.status === 404 && <button className="button" type="button" disabled={busy || !active} onClick={state.retry}>{m.checkState}</button>}
    </div>}
    {otherAdd !== null && (otherAdd.phase === "unknown" || otherAdd.phase === "conflict" || otherAdd.phase === "reconciled" || otherAdd.reconciliationError !== null) && <div className="steps-error" role="alert">
      <p>{otherAdd.phase === "unknown" ? (otherAdd.operation?.action === "stepEdit" ? m.editUnknown : m.addUnknown) : otherAdd.phase === "conflict" ? m.addConflict : otherAdd.reconciledFrom === "unknown" ? m.addUnknownReconciled : m.addConflictReconciled} <code>{(otherAdd.operation?.action === "stepAdd" || otherAdd.operation?.action === "stepEdit") && otherAdd.operation.stepId}</code></p>
      {otherAdd.reconciliationError !== null && <p>{m.checkFailed}</p>}
      {(otherAdd.phase === "unknown" || otherAdd.phase === "conflict" || otherAdd.reconciliationError !== null) && <button className="button" type="button" disabled={otherAdd.reconciling} onClick={state.reconcile}>{otherAdd.reconciling ? m.checking : m.checkState}</button>}
    </div>}
    {resource === null && (busy || state.status === "waiting") && <div className="steps-skeleton" role="status" aria-label={m.loading}>{[0, 1, 2, 3].map((row) => <div key={row}><span /><span /><span /></div>)}</div>}
    {resource !== null && total === 0 && <div className="steps-empty"><p>{m.empty}</p></div>}
    {resource !== null && total > PAGE_SIZE && <nav className="steps-pagination" aria-label={m.pagination}>
      <p className="steps-range" aria-live="polite">{m.range(format.number(start + 1), format.number(Math.min(start + PAGE_SIZE, total)), format.number(total))}</p>
      <div className="steps-page-controls">
        <button className="button" type="button" disabled={currentPage === 1} onClick={() => { navigationRevision.current++; setPage(currentPage - 1); }}>{m.previous}</button>
        <form className="steps-page-number" onSubmit={(event) => { event.preventDefault(); applyPageInput(); }}><input type="number" min="1" max={pages} step="1" required value={pageInput} aria-label={m.page} onChange={(event) => setPageInput(event.currentTarget.value)} onBlur={applyPageInput} /><span>/ {format.number(pages)}</span></form>
        <button className="button" type="button" disabled={currentPage === pages} onClick={() => { navigationRevision.current++; setPage(currentPage + 1); }}>{m.next}</button>
      </div>
    </nav>}
    {resource !== null && total > 0 && <ol className="steps-list" start={start + 1}>
      {resource.steps.slice(start, start + PAGE_SIZE).map((step, index) => <StepRow key={step.id} step={step} index={start + index} total={total}
        bodyId={`${id}-${step.id}`} open={expanded.has(step.id)} canDisplayStatus={state.canDisplayStatus} selectionBlocked={!state.canSetStatus} authPaused={authPaused} canMove={state.canMove}
        canAdd={active && draft === null} canEdit={active} statusBusy={pendingStepId === step.id} moveBusy={pendingMoveId === step.id}
        version={resource.version} editor={draft?.kind === "edit" && !draft.standalone && draft.id === step.id && editTargetAvailable ? editor : null}
        renderMarkdown={renderMarkdown} onToggle={toggle} onStatus={state.setStatus} onMove={move} onEdit={selectEdit} />)}
    </ol>}
    {draft !== null && (draft.kind === "add" || draft.standalone || resource !== null && !editTargetAvailable) && editor}
    {discard !== null && draft !== null && draft.key === discard.key && draft.kind === discard.kind && available && navigationDecision === null && <TaskConfirmation title={m.discardTitle} question={draft.kind === "edit" ? m.discardEditQuestion : m.discardQuestion} explanation={m.discardExplanation} taskTitle={draft.title} confirmLabel={m.discard} cancelLabel={m.keep} closeLabel={m.cancel} destructive owner={confirmationOwner ?? workspace} fallbackFocus={confirmationFallback ?? addButton} confirmDisabled={switchTarget !== null && !resource?.steps.some((step) => step.id === switchTarget.id && step.createdAt === switchTarget.createdAt)} content={switchTarget !== null && !resource?.steps.some((step) => step.id === switchTarget.id && step.createdAt === switchTarget.createdAt) ? <p role="alert">{m.editMissing}</p> : undefined} onCancel={() => { if (draftOwner.current?.key !== discard.key || draftOwner.current.kind !== discard.kind) return; setDiscard(null); setSwitchTarget(null); onConfirmationChange?.(false); }} onConfirm={() => { if (draftOwner.current?.key !== discard.key || draftOwner.current.kind !== discard.kind) return; const target = switchTarget; if (target !== null && !resource?.steps.some((step) => step.id === target.id && step.createdAt === target.createdAt)) return; const previous = draft.kind === "edit" ? draft.id : ""; closeDraft(); if (target !== null) beginEdit(target.id); else setFocusStep(previous); }} />}
    {navigationDecision === null && available && deleting !== null && <TaskConfirmation title={m.deleteTitle} question={m.deleteQuestion} explanation={m.deleteExplanation} taskTitle={`${deleting.step.title} (${deleting.step.id})`} content={<><p>{m.deleteExplanation}</p>{draft?.kind === "edit" && draft.id === deleting.step.id && dirty && <p>{m.deleteDraft}</p>}</>} confirmLabel={m.deleteStep} cancelLabel={m.cancel} closeLabel={m.cancel} destructive confirmDisabled={!state.canDelete || authRequestsPaused()} owner={confirmationOwner ?? workspace} fallbackFocus={confirmationFallback ?? addButton} onCancel={() => { setDeleting(null); onConfirmationChange?.(false); }} onConfirm={() => {
      if (!state.canDelete || authRequestsPaused()) return;
      setDeleting(null); onConfirmationChange?.(false);
      if (resource === null || !state.canDelete || resource.version !== deleting.version || !resource.steps.some((step) => step.id === deleting.step.id && step.createdAt === deleting.step.createdAt)) { setDeleteChanged(true); return; }
      const index = resource.steps.findIndex((step) => step.id === deleting.step.id);
      const requestId = state.remove(deleting.step.id, deleting.version);
      if (requestId !== null) setSubmittedDelete({ requestId, stepId: deleting.step.id, version: resource.version, draftKey: draft?.kind === "edit" && draft.id === deleting.step.id && draft.originalCreatedAt === deleting.step.createdAt ? draft.key : null, draftRevision: draft?.revision ?? null, navigation: navigationRevision.current, next: resource.steps.slice(index + 1).map(({ id, createdAt }) => ({ id, createdAt })), previous: resource.steps.slice(0, index).reverse().map(({ id, createdAt }) => ({ id, createdAt })) });
      else setDeleteChanged(true);
    }} />}
    {navigationDecision === null && moving !== null && resource !== null && <StepMoveDialog step={moving} steps={resource.steps} available={state.canMove} onCancel={() => { setMovingId(null); requestAnimationFrame(() => workspace.current?.querySelector<HTMLButtonElement>(`[data-step-id="${moving.id}"] .step-more`)?.focus()); }} onConfirm={(target, placement) => { if (!state.canMove || authRequestsPaused()) return; setMovingId(null); submitMove(moving.id, placement === "before" ? { before: target } : { after: target }); }} />}
    {active && navigationDecision === null && choosingTarget !== null && draft?.kind === "add" && draft.key === choosingTarget.key && resource !== null && <StepAddTargetDialog key={choosingTarget.key} steps={resource.steps} selected={choosingTarget.selected} onSelect={(id, createdAt) => setChoosingTarget((current) => current?.key === choosingTarget.key ? { ...current, selected: { id, createdAt } } : current)} onCancel={() => { if (draftOwner.current?.key !== choosingTarget.key || draftOwner.current.kind !== "add") return; setChoosingTarget((current) => current?.key === choosingTarget.key ? null : current); restoreTargetFocus(choosingTarget.key); }} onConfirm={(target, createdAt) => { if (draftOwner.current?.key !== choosingTarget.key || draftOwner.current.kind !== "add") return; const selected = resource.steps.find((step) => step.id === target && step.createdAt === createdAt); if (!selected) return; setDraft((current) => current?.kind === "add" && current.key === choosingTarget.key ? { ...current, revision: current.revision + 1, anchorId: target, anchorCreatedAt: createdAt } : current); setAnchorNeedsDecision(false); setChoosingTarget((current) => current?.key === choosingTarget.key ? null : current); restoreTargetFocus(choosingTarget.key); }} />}
  </section>;
};
