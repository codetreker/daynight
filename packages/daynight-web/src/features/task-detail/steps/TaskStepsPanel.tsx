import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../../../api/client";
import { useI18n } from "../../../i18n/LocaleProvider";
import { useTaskSteps } from "../useTaskSteps";
import { StepMoveMenu, type MoveAction } from "./StepMoveMenu";
import { StepMoveDialog } from "./StepTargetPicker";
import { StepStatusMenu } from "./StepStatusMenu";
import "../../../styles/task-steps.css";

const PAGE_SIZE = 100;

export const TaskStepsPanel = ({ projectId, taskId, active, renderMarkdown }: {
  readonly projectId: string; readonly taskId: string; readonly active: boolean;
  readonly renderMarkdown: (text: string) => ReactNode;
}) => {
  const { messages, format } = useI18n();
  const m = messages.inspection.steps;
  const state = useTaskSteps(projectId, taskId, active);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const id = useId();
  const workspace = useRef<HTMLElement>(null);
  const submittedMove = useRef<string | null>(null);
  const focusMove = useRef<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const resource = state.resource;
  const total = resource?.steps.length ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const [pageInput, setPageInput] = useState("1");
  useEffect(() => { setPageInput(String(currentPage)); }, [currentPage]);
  const applyPageInput = () => {
    const next = Number(pageInput);
    if (Number.isSafeInteger(next) && next >= 1 && next <= pages) setPage(next);
    else setPageInput(String(currentPage));
  };
  const start = (currentPage - 1) * PAGE_SIZE;
  const busy = state.status === "loading" || state.refreshing;
  const toggle = (stepId: string) => setExpanded((previous) => {
    const next = new Set(previous);
    if (next.has(stepId)) next.delete(stepId);
    else next.add(stepId);
    return next;
  });
  const error = state.error;
  const explanation = error instanceof ApiError ? error.kind === "network" ? m.networkError
    : error.kind === "protocol" ? m.protocolError : error.status === 404 ? m.unavailable
      : error.status === 403 ? m.denied : m.requestFailed : m.requestFailed;
  const mutation = state.mutation;
  const isPosition = mutation.operation?.action === "stepPosition";
  const stepMutation = mutation.operation?.action === "stepStatus" || isPosition ? mutation : null;
  const moving = resource?.steps.find((step) => step.id === movingId) ?? null;
  useLayoutEffect(() => {
    if (!active || resource === null) {
      setMovingId(null);
      if (active) { submittedMove.current = null; focusMove.current = null; }
    }
  }, [active, resource]);
  useLayoutEffect(() => {
    if (!active || submittedMove.current === null || !isPosition || mutation.operation?.stepId !== submittedMove.current) return;
    if (mutation.phase === "confirmed" && !mutation.reconciling && resource !== null) {
      const index = resource.steps.findIndex((step) => step.id === submittedMove.current);
      if (index >= 0) { focusMove.current = submittedMove.current; setPage(Math.floor(index / PAGE_SIZE) + 1); }
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
  const submitMove = (stepId: string, placement: { position: "first" | "last" } | { before: string } | { after: string }) => {
    if (resource === null || !state.canMove) return;
    submittedMove.current = stepId;
    state.move(stepId, placement, resource.version);
  };
  const move = (stepId: string, index: number, action: MoveAction) => {
    if (resource === null) return;
    if (action === "relative") { setMovingId(stepId); return; }
    if (action === "first" || action === "last") submitMove(stepId, { position: action });
    else if (action === "up" && index > 0) submitMove(stepId, { before: resource.steps[index - 1]!.id });
    else if (action === "down" && index + 1 < resource.steps.length) submitMove(stepId, { after: resource.steps[index + 1]!.id });
  };
  const pendingStepId = mutation.operation?.action === "stepStatus" && mutation.phase === "pending" ? mutation.operation.stepId : null;
  const pendingMoveId = isPosition && mutation.phase === "pending" ? mutation.operation.stepId : null;
  const unresolved = stepMutation?.phase === "unknown" || stepMutation?.phase === "conflict" || stepMutation?.reconciliationError != null;
  const mutationError = stepMutation?.error;
  const resolvedConflict = stepMutation?.phase === "reconciled" && stepMutation.reconciledFrom === "conflict";
  const resolvedUnknown = stepMutation?.phase === "reconciled" && stepMutation.reconciledFrom === "unknown";
  const refusal = mutationError instanceof ApiError ? mutationError.status === 404 ? isPosition ? m.moveMissing : m.statusMissing : mutationError.status === 403 ? m.statusDenied
    : mutationError.code === "version_exhausted" ? m.statusExhausted : mutationError.code === "steps_limit_exceeded" ? m.statusCapacity
      : mutationError.code === "invalid_input" ? isPosition ? m.moveInvalid : m.statusInvalid : isPosition ? m.moveRefused : m.statusRefused : isPosition ? m.moveRefused : m.statusRefused;

  return <section ref={workspace} className="steps-workspace" aria-label={m.title}>
    <div className="steps-toolbar">
      <strong className="steps-counts">{resource === null ? m.title : m.count(format.number(total))}</strong>
      <button className="button steps-refresh" type="button" aria-label={m.refresh} aria-busy={busy} disabled={busy || !active || unresolved} onClick={state.retry}>
        {busy ? <span className="spinner" aria-hidden="true" /> : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 11-2l3 3M4 16l3 3a7 7 0 0 0 11-2" /></svg>}
      </button>
    </div>
    {error !== null && <div className="steps-error" role="alert">
      <h3>{resource === null ? m.loadFailed : m.refreshFailed}</h3><p>{explanation}</p>
      {resource !== null && <p>{m.retained}</p>}
      {error instanceof ApiError && error.requestId !== null && <p className="request-id">{messages.common.requestId} <code>{error.requestId}</code></p>}
      <button className="button" type="button" disabled={busy || !active || unresolved} onClick={state.retry}>{m.retry}</button>
    </div>}
    {stepMutation !== null && (unresolved || resolvedConflict || resolvedUnknown || stepMutation.phase === "refused") && <div className="steps-error" role="alert">
      {stepMutation.phase === "unknown" && <p>{isPosition ? m.moveUnknown : m.unknown}</p>}
      {stepMutation.phase === "conflict" && <p>{isPosition ? m.moveConflict : m.conflict}</p>}
      {resolvedConflict && <p>{isPosition ? m.moveConflictReconciled : m.conflictReconciled}</p>}
      {resolvedUnknown && <p>{m.unknownReconciled}</p>}
      {stepMutation.phase === "refused" && <p>{refusal}</p>}
      {stepMutation.phase === "refused" && mutationError instanceof ApiError && mutationError.stepsLimit !== undefined && <p>{m.capacityDetails(format.number(mutationError.stepsLimit.encodedBytes), format.number(mutationError.stepsLimit.maxEncodedBytes))}</p>}
      {mutationError instanceof ApiError && mutationError.requestId !== null && <p className="request-id">{messages.common.requestId} <code>{mutationError.requestId}</code></p>}
      {stepMutation.reconciliationError !== null && <p>{m.checkFailed}</p>}
      {unresolved && <button className="button" type="button" disabled={stepMutation.reconciling} onClick={state.reconcile}>{stepMutation.reconciling ? m.checking : m.checkState}</button>}
      {stepMutation.phase === "refused" && mutationError instanceof ApiError && mutationError.status === 404 && <button className="button" type="button" disabled={busy || !active} onClick={state.retry}>{m.checkState}</button>}
    </div>}
    {resource === null && (busy || state.status === "waiting") && <div className="steps-skeleton" role="status" aria-label={m.loading}>{[0, 1, 2, 3].map((row) => <div key={row}><span /><span /><span /></div>)}</div>}
    {resource !== null && total === 0 && <div className="steps-empty"><p>{m.empty}</p></div>}
    {resource !== null && total > PAGE_SIZE && <nav className="steps-pagination" aria-label={m.pagination}>
      <p className="steps-range" aria-live="polite">{m.range(format.number(start + 1), format.number(Math.min(start + PAGE_SIZE, total)), format.number(total))}</p>
      <div className="steps-page-controls">
        <button className="button" type="button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>{m.previous}</button>
        <form className="steps-page-number" onSubmit={(event) => { event.preventDefault(); applyPageInput(); }}><input type="number" min="1" max={pages} step="1" required value={pageInput} aria-label={m.page} onChange={(event) => setPageInput(event.currentTarget.value)} onBlur={applyPageInput} /><span>/ {format.number(pages)}</span></form>
        <button className="button" type="button" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>{m.next}</button>
      </div>
    </nav>}
    {resource !== null && total > 0 && <ol className="steps-list" start={start + 1}>
      {resource.steps.slice(start, start + PAGE_SIZE).map((step, index) => {
        const open = expanded.has(step.id);
        const bodyId = `${id}-${step.id}`;
        return <li className="step-row" key={step.id} data-step-id={step.id}>
          <div className="step-summary">
            <button type="button" className="step-disclosure" aria-expanded={open} aria-controls={bodyId} onClick={() => toggle(step.id)}>
              <span className="step-chevron" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m6 3 5 5-5 5" /></svg></span>
              <span className="step-number" aria-hidden="true">{format.number(start + index + 1)}</span><span className="step-title">{step.title}</span>
            </button>
            <div className="step-controls"><StepStatusMenu step={step} available={state.canSetStatus} busy={pendingStepId === step.id} onSelect={(status) => state.setStatus(step.id, status, resource.version)} /><code className="step-id">{step.id}</code><StepMoveMenu step={step} index={start + index} total={total} available={state.canMove} busy={pendingMoveId === step.id} onSelect={(action) => move(step.id, start + index, action)} /></div>
          </div>
          <div id={bodyId} className="step-detail" hidden={!open}>
            {open && <>{step.description === "" ? <p className="step-detail-empty">{m.noDescription}</p> : renderMarkdown(step.description)}
              <dl className="step-metadata"><div><dt>{m.created}</dt><dd><time dateTime={step.createdAt}>{format.dateTime(step.createdAt)}</time></dd></div><div><dt>{m.updated}</dt><dd><time dateTime={step.updatedAt}>{format.dateTime(step.updatedAt)}</time></dd></div></dl>
            </>}
          </div>
        </li>;
      })}
    </ol>}
    {moving !== null && resource !== null && <StepMoveDialog step={moving} steps={resource.steps} available={state.canMove} onCancel={() => { setMovingId(null); requestAnimationFrame(() => workspace.current?.querySelector<HTMLButtonElement>(`[data-step-id="${moving.id}"] .step-more`)?.focus()); }} onConfirm={(target, placement) => { setMovingId(null); submitMove(moving.id, placement === "before" ? { before: target } : { after: target }); }} />}
  </section>;
};
