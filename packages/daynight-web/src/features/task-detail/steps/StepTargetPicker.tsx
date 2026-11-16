import { NativeSelect } from "../../../ui/native-select/NativeSelect";
import { AccountRefreshNotice } from '../../auth/AccountRefreshNotice';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TaskStep } from "../../../api/task-steps";
import { useI18n } from "../../../i18n/LocaleProvider";
import { dialogFocusables } from "../focus";

const PAGE_SIZE = 100;

// Selection belongs to the caller so this picker can also be used for insertion.
export const StepTargetPicker = ({ steps, excludeId, selectedId, onSelect }: {
  readonly steps: readonly TaskStep[]; readonly excludeId?: string; readonly selectedId: string | null; readonly onSelect: (id: string) => void;
}) => {
  const { messages: { inspection: { steps: m } }, format } = useI18n();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [input, setInput] = useState("1");
  const matches = useMemo(() => {
    const q = query.toLocaleLowerCase();
    return steps.filter((step) => step.id !== excludeId && (step.title.toLocaleLowerCase().includes(q) || step.id.includes(q)));
  }, [steps, excludeId, query]);
  const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  useEffect(() => { if (page > pages) { setPage(pages); setInput(String(pages)); } }, [page, pages]);
  const start = (currentPage - 1) * PAGE_SIZE;
  const choices = matches.slice(start, start + PAGE_SIZE);
  const selected = steps.find((step) => step.id === selectedId);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const applyPage = () => { const next = Number(input); if (Number.isSafeInteger(next) && next >= 1 && next <= pages) setPage(next); else setInput(String(currentPage)); };
  const changePage = (next: number) => { setPage(next); setInput(String(next)); };
  return <div className="step-target-picker">
    {selected && <div className="step-target-selected"><span>{m.target}</span><strong>{selected.title}</strong><code className="step-id">{selected.id}</code></div>}
    <label className="step-target-field"><span>{m.searchTargets}</span><input type="search" value={query} autoComplete="off" onChange={(event) => { setQuery(event.currentTarget.value); changePage(1); }} /></label>
    {matches.length > PAGE_SIZE && <nav className="step-target-pagination" aria-label={m.targetPagination}>
      <span>{m.range(format.number(start + 1), format.number(Math.min(start + PAGE_SIZE, matches.length)), format.number(matches.length))}</span>
      <div className="steps-page-controls"><button className="button" type="button" disabled={currentPage === 1} onClick={() => changePage(currentPage - 1)}>{m.previous}</button>
        <form className="steps-page-number" onSubmit={(event) => { event.preventDefault(); applyPage(); }}><input type="number" min="1" max={pages} step="1" required value={input} aria-label={m.targetPage} onChange={(event) => setInput(event.currentTarget.value)} onBlur={applyPage} /><span>/ {format.number(pages)}</span></form>
        <button className="button" type="button" disabled={currentPage === pages} onClick={() => changePage(currentPage + 1)}>{m.next}</button></div>
    </nav>}
    <div className="step-target-results" role="radiogroup" aria-label={m.targetResults} onKeyDown={(event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const index = buttons.current.indexOf(document.activeElement as HTMLButtonElement);
      if (index < 0 || !choices.length) return;
      event.preventDefault(); event.stopPropagation();
      const next = event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
      onSelect(choices[next]!.id); buttons.current[next]?.focus();
    }}>
      {choices.length ? choices.map((step, index) => <button key={step.id} ref={(node) => { buttons.current[index] = node; }} type="button" className="step-target-choice" role="radio" aria-label={`${step.title}, ${step.id}`} aria-checked={selectedId === step.id}
        tabIndex={selectedId === step.id || !choices.some((item) => item.id === selectedId) && index === 0 ? 0 : -1} onClick={() => onSelect(step.id)}><span>{step.title}</span><code className="step-id">{step.id}</code>{selectedId === step.id && <span aria-hidden="true">✓</span>}</button>) : <p>{m.noTargets}</p>}
    </div>
  </div>;
};

export const StepMoveDialog = ({ step, steps, available, onCancel, onConfirm }: {
  readonly step: TaskStep; readonly steps: readonly TaskStep[]; readonly available: boolean;
  readonly onCancel: () => void; readonly onConfirm: (id: string, placement: "before" | "after") => void;
}) => {
  const { messages: { inspection: { steps: m } } } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [placement, setPlacement] = useState<"before" | "after">("before");
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const missing = selectedId !== null && !steps.some((item) => item.id === selectedId && item.id !== step.id);
  useLayoutEffect(() => { const element = dialog.current!; element.showModal(); cancel.current?.focus(); return () => element.close(); }, []);
  return <dialog className="auth-dialog step-move-dialog" ref={dialog} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); event.stopPropagation(); onCancel(); }} onKeyDown={(event) => {
    event.stopPropagation();
    if (event.key !== "Tab") return;
    const items = dialogFocusables(event.currentTarget); const first = items[0]; const last = items[items.length - 1];
    if (first && last && (!items.includes(document.activeElement as HTMLElement) || document.activeElement === (event.shiftKey ? first : last))) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
  }}>
    <header className="dialog-header"><h2 id={titleId}>{m.moveTitle}</h2><AccountRefreshNotice /></header>
    <div className="dialog-body step-move-body"><strong>{step.title}</strong><code className="step-id">{step.id}</code>
      <StepTargetPicker steps={steps} excludeId={step.id} selectedId={selectedId} onSelect={setSelectedId} />
      {missing && <p role="alert">{m.targetMissing}</p>}
      <label className="step-target-field"><span>{m.placement}</span><NativeSelect density="form" layout="fill" focusTone="task" value={placement} onChange={(event) => setPlacement(event.currentTarget.value as "before" | "after")}><option value="before">{m.before}</option><option value="after">{m.after}</option></NativeSelect></label>
    </div>
    <footer className="dialog-footer"><button className="button" type="button" ref={cancel} onClick={onCancel}>{m.cancelMove}</button><button className="button primary" type="button" disabled={!available || selectedId === null || missing} onClick={() => { if (selectedId !== null && selectedId !== step.id && !missing) onConfirm(selectedId, placement); }}>{m.confirmMove}</button></footer>
  </dialog>;
};

export const StepAddTargetDialog = ({ steps, selected, onSelect, onCancel, onConfirm }: {
  readonly steps: readonly TaskStep[]; readonly selected: { id: string; createdAt: string | null } | null;
  readonly onSelect: (id: string, createdAt: string) => void;
  readonly onCancel: () => void; readonly onConfirm: (id: string, createdAt: string) => void;
}) => {
  const { messages: { inspection: { steps: m } } } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const missing = selected !== null && !steps.some((step) => step.id === selected.id && step.createdAt === selected.createdAt);
  useLayoutEffect(() => { const element = dialog.current!; element.showModal(); cancel.current?.focus(); return () => element.close(); }, []);
  return <dialog className="auth-dialog step-move-dialog" ref={dialog} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); event.stopPropagation(); onCancel(); }} onKeyDown={(event) => {
    event.stopPropagation();
    if (event.key !== "Tab") return;
    const items = dialogFocusables(event.currentTarget); const first = items[0]; const last = items[items.length - 1];
    if (first && last && (!items.includes(document.activeElement as HTMLElement) || document.activeElement === (event.shiftKey ? first : last))) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
  }}>
    <header className="dialog-header"><h2 id={titleId}>{m.selectTarget}</h2><AccountRefreshNotice /></header>
    <div className="dialog-body step-move-body"><StepTargetPicker steps={steps} selectedId={selected?.id ?? null} onSelect={(id) => { const step = steps.find((item) => item.id === id); if (step !== undefined) onSelect(id, step.createdAt); }} />{missing && <p role="alert">{m.targetMissing}</p>}</div>
    <footer className="dialog-footer"><button className="button" type="button" ref={cancel} onClick={onCancel}>{m.cancel}</button><button className="button primary" type="button" disabled={selected === null || selected.createdAt === null || missing} onClick={() => { if (selected !== null && selected.createdAt !== null && !missing) onConfirm(selected.id, selected.createdAt); }}>{m.confirmTarget}</button></footer>
  </dialog>;
};
