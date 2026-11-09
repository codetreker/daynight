import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { authRequestsPaused } from "../../../api/client";
import type { StepStatus, TaskStep } from "../../../api/task-steps";
import { useI18n } from "../../../i18n/LocaleProvider";

const statuses: readonly StepStatus[] = ["todo", "in_progress", "done", "skipped"];

export const StepStatusMenu = ({ step, available, selectionBlocked = false, busy, onSelect }: {
  readonly step: TaskStep; readonly available: boolean; readonly selectionBlocked?: boolean; readonly busy: boolean;
  readonly onSelect: (status: StepStatus) => void;
}) => {
  const { messages: { inspection: { steps: m } } } = useI18n();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const options = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();
  const reasonId = useId();
  const close = (restore: boolean) => { setOpen(false); if (restore) trigger.current?.focus(); };
  const show = (index: number) => { if (available) { setActive(index); setOpen(true); } };
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const element = menu.current;
    const position = () => {
      const anchor = trigger.current!.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      const preferredTop = anchor.bottom + box.height + 8 <= window.innerHeight ? anchor.bottom + 4 : anchor.top - box.height - 4;
      element.style.top = `${Math.max(8, Math.min(preferredTop, window.innerHeight - box.height - 8))}px`;
      element.style.left = `${Math.max(8, Math.min(anchor.right - box.width, window.innerWidth - box.width - 8))}px`;
    };
    const toggled = (event: ToggleEvent) => { if (event.newState === "closed") setOpen(false); };
    element.addEventListener("toggle", toggled);
    element.showPopover();
    position();
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    return () => {
      element.removeEventListener("toggle", toggled);
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
      element.hidePopover();
    };
  }, [open]);
  useLayoutEffect(() => { if (open) options.current[active]?.focus(); }, [open, active]);
  useEffect(() => { if (!available) setOpen(false); }, [available]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) close(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return <div className="step-status-picker" ref={container} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) close(false); }}>
    <button className={`step-status step-status-${step.status}`} ref={trigger} type="button" aria-label={`${m.statusMenu(step.title)}: ${m.status[step.status]}`}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} aria-disabled={!available} aria-busy={busy}
      aria-describedby={!available ? reasonId : undefined} onClick={() => open ? close(false) : show(statuses.indexOf(step.status))}
      onKeyDown={(event) => { if (available && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); show(event.key === "ArrowDown" ? 0 : statuses.length - 1); } }}>
      {m.status[step.status]} <span aria-hidden="true">⌄</span>
    </button>
    {!available && <span className="step-status-reason" role="tooltip" id={reasonId}>{m.statusUnavailable}</span>}
    {open && <div className="task-status-menu step-status-menu" ref={menu} id={menuId} popover="auto" role="menu" aria-label={m.statusMenu(step.title)} onKeyDown={(event) => {
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        setActive(event.key === "Home" ? 0 : event.key === "End" ? statuses.length - 1 : (active + (event.key === "ArrowDown" ? 1 : -1) + statuses.length) % statuses.length);
      } else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === "Tab") close(false);
    }}>{statuses.map((value, index) => <button key={value} ref={(node) => { options.current[index] = node; }} type="button" role="menuitemradio" aria-checked={step.status === value} aria-disabled={selectionBlocked} tabIndex={index === active ? 0 : -1}
      className="task-status-option" onFocus={() => setActive(index)} onClick={() => { if (!selectionBlocked && !authRequestsPaused()) { close(true); onSelect(value); } }}>
      <span>{m.status[value]}</span><span aria-hidden="true">{step.status === value ? "✓" : ""}</span>
    </button>)}</div>}
  </div>;
};
