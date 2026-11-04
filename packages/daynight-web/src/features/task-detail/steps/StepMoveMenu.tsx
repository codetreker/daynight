import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { TaskStep } from "../../../api/task-steps";
import { useI18n } from "../../../i18n/LocaleProvider";

export type MoveAction = "edit" | "up" | "down" | "first" | "last" | "relative";

export const StepMoveMenu = ({ step, index, total, available, busy, onSelect }: {
  readonly step: TaskStep; readonly index: number; readonly total: number;
  readonly available: boolean; readonly busy: boolean; readonly onSelect: (action: MoveAction) => void;
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
  const actions: { action: MoveAction; label: string; disabled: boolean }[] = [
    { action: "up", label: m.moveUp, disabled: index === 0 },
    { action: "down", label: m.moveDown, disabled: index === total - 1 },
    { action: "first", label: m.moveFirst, disabled: index === 0 },
    { action: "last", label: m.moveLast, disabled: index === total - 1 },
    { action: "relative", label: m.moveRelative, disabled: total < 2 },
    { action: "edit", label: m.editStep, disabled: false },
  ];
  const enabled = actions.map((item, i) => item.disabled ? -1 : i).filter((i) => i >= 0);
  const close = (restore: boolean) => { setOpen(false); if (restore) trigger.current?.focus(); };
  const show = (last = false) => { if (available && enabled.length) { setActive(last ? enabled[enabled.length - 1]! : enabled[0]!); setOpen(true); } };
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const element = menu.current;
    const position = () => {
      const anchor = trigger.current!.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      const top = anchor.bottom + box.height + 8 <= window.innerHeight ? anchor.bottom + 4 : anchor.top - box.height - 4;
      element.style.top = `${Math.max(8, Math.min(top, window.innerHeight - box.height - 8))}px`;
      element.style.left = `${Math.max(8, Math.min(anchor.right - box.width, window.innerWidth - box.width - 8))}px`;
    };
    const toggled = (event: ToggleEvent) => { if (event.newState === "closed") setOpen(false); };
    element.addEventListener("toggle", toggled); element.showPopover(); position();
    window.addEventListener("resize", position); document.addEventListener("scroll", position, true);
    return () => { element.removeEventListener("toggle", toggled); window.removeEventListener("resize", position); document.removeEventListener("scroll", position, true); element.hidePopover(); };
  }, [open]);
  useLayoutEffect(() => { if (open) options.current[active]?.focus(); }, [open, active]);
  useEffect(() => { if (!available) setOpen(false); }, [available]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) close(false); };
    document.addEventListener("pointerdown", outside); return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return <div className="step-move-picker" ref={container} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) close(false); }}>
    <button ref={trigger} className="step-more" type="button" aria-label={m.moveMenu(step.title)} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      aria-disabled={!available} aria-busy={busy} aria-describedby={!available ? reasonId : undefined}
      onClick={() => open ? close(false) : show()} onKeyDown={(event) => { if (available && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); show(event.key === "ArrowUp"); } }}>{busy ? <span className="spinner" aria-hidden="true" /> : "⋯"}</button>
    {!available && <span className="step-status-reason" role="tooltip" id={reasonId}>{m.moveUnavailable}</span>}
    {open && <div className="task-status-menu step-move-menu" ref={menu} id={menuId} popover="auto" role="menu" aria-label={m.moveMenu(step.title)} onKeyDown={(event) => {
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault(); const pos = enabled.indexOf(active);
        setActive(event.key === "Home" ? enabled[0]! : event.key === "End" ? enabled[enabled.length - 1]! : enabled[(pos + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length]!);
      } else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === "Tab") close(false);
    }}>{actions.map((item, i) => <button key={item.action} ref={(node) => { options.current[i] = node; }} type="button" role="menuitem" disabled={item.disabled} tabIndex={active === i ? 0 : -1}
      className="task-status-option" onFocus={() => setActive(i)} onClick={() => { close(true); onSelect(item.action); }}>{item.label}</button>)}</div>}
  </div>;
};
