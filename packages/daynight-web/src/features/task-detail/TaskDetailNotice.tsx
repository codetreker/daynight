import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../i18n/LocaleProvider';
import type { TaskMutationState } from './TaskDetailSession';

type NoticeHost = { readonly element: HTMLDivElement | null; readonly fallbackFocus: RefObject<HTMLElement | null> };
const Context = createContext<NoticeHost | undefined>(undefined);
type Tip = { readonly id: string; readonly source: 'hover' | 'focus' };
type TipController = {
  readonly active: Tip | null;
  readonly show: (id: string, source: Tip['source']) => void;
  readonly hide: (id: string, source: Tip['source']) => void;
  readonly dismiss: (id: string) => void;
};
const TipContext = createContext<TipController | undefined>(undefined);

export const TaskDetailNotifications = ({ children, fallbackFocus }: { readonly children: ReactNode; readonly fallbackFocus: RefObject<HTMLElement | null> }) => {
  const [tip, setTip] = useState<Tip | null>(null);
  const show = useCallback((id: string, source: Tip['source']) => setTip((current) => current?.source === 'focus' && source === 'hover' ? current : { id, source }), []);
  const hide = useCallback((id: string, source: Tip['source']) => setTip((current) => current?.id === id && current.source === source ? null : current), []);
  const dismiss = useCallback((id: string) => setTip((current) => current?.id === id ? null : current), []);
  const controller = useMemo(() => ({ active: tip, show, hide, dismiss }), [tip, show, hide, dismiss]);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const host = useMemo(() => ({ element, fallbackFocus }), [element, fallbackFocus]);
  return <Context.Provider value={host}><TipContext.Provider value={controller}>{children}<div className="task-detail-notifications" ref={setElement} /></TipContext.Provider></Context.Provider>;
};

export const useMutationNoticeEvent = (mutation: TaskMutationState): object => useMemo(() => ({}),
  [mutation.operation, mutation.phase, mutation.reconciling, mutation.error, mutation.reconciliationError]);

export const TaskDetailNotice = ({ active = true, event, initiallyVisible = true, tone = 'info', recoverable = false, children }: {
  readonly active?: boolean;
  readonly event: unknown;
  readonly initiallyVisible?: boolean;
  readonly tone?: 'info' | 'success' | 'warning' | 'error';
  readonly recoverable?: boolean;
  readonly children: ReactNode;
}) => {
  const host = useContext(Context);
  const { messages: { inspection: { detail: m } } } = useI18n();
  const [display, setDisplay] = useState({ event, dismissed: !initiallyVisible, attempt: 0 });
  const visible = active && (display.event !== event || !display.dismissed);
  const bubble = useRef<HTMLDivElement>(null);
  const reopen = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const focusOnOpen = useRef(false);
  const paused = hovered || focused;
  const duration = tone === 'error' || tone === 'warning' || recoverable ? 8000 : 3000;
  const remaining = useRef(duration);
  const lifetime = useRef({ event, attempt: display.attempt });
  useLayoutEffect(() => () => {
    if (bubble.current?.contains(document.activeElement)) host?.fallbackFocus.current?.focus();
  }, [host?.fallbackFocus]);
  const dismiss = () => {
    restoreFocus.current = bubble.current?.contains(document.activeElement) === true;
    setHovered(false);
    setFocused(false);
    setDisplay((current) => ({ event, dismissed: true, attempt: current.attempt }));
  };
  useEffect(() => {
    if (lifetime.current.event !== event || lifetime.current.attempt !== display.attempt) {
      lifetime.current = { event, attempt: display.attempt };
      remaining.current = duration;
    }
    if (!visible || paused) return;
    const started = performance.now();
    const timer = window.setTimeout(dismiss, remaining.current);
    return () => { window.clearTimeout(timer); remaining.current = Math.max(0, remaining.current - (performance.now() - started)); };
  }, [event, display.attempt, visible, paused]);
  useLayoutEffect(() => {
    if (!visible) {
      if (hovered) setHovered(false);
      if (focused) {
        setFocused(false);
        if (document.activeElement === document.body) host?.fallbackFocus.current?.focus();
      }
    }
    if (visible && (focusOnOpen.current || focused && document.activeElement === document.body)) {
      focusOnOpen.current = false;
      bubble.current?.querySelector<HTMLButtonElement>('button')?.focus();
    }
    if (!visible && restoreFocus.current) {
      restoreFocus.current = false;
      (reopen.current ?? host?.fallbackFocus.current)?.focus();
    }
  });
  if (!active || host?.element === null) return null;
  const content = visible ? <div className="task-detail-toast" data-tone={tone} ref={bubble}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <button className="task-detail-notice-close" type="button" aria-label={m.dismissNotice} onClick={dismiss}>×</button>
    {children}
  </div> : recoverable ? <button className="button task-detail-notice-reopen" type="button" ref={reopen} aria-label={m.showNotice}
    onClick={() => { focusOnOpen.current = true; setHovered(false); setFocused(false); setDisplay((current) => ({ event, dismissed: false, attempt: current.attempt + 1 })); }}>ⓘ</button> : null;
  return host === undefined ? content : content === null ? null : createPortal(content, host.element!);
};

export const TaskControlTip = ({ children, text, label, id }: { readonly children: ReactNode; readonly text: string | null; readonly label: string; readonly id?: string }) => {
  const generatedId = useId();
  const tipId = id === undefined ? generatedId : id;
  const [localOpen, setLocalOpen] = useState(false);
  const controller = useContext(TipContext);
  const open = text !== null && (controller === undefined ? localOpen : controller.active?.id === tipId);
  const show = (source: Tip['source']) => { if (text !== null) { if (controller === undefined) setLocalOpen(true); else controller.show(tipId, source); } };
  const hide = (source: Tip['source']) => { if (controller === undefined) setLocalOpen(false); else controller.hide(tipId, source); };
  const dismiss = () => { if (controller === undefined) setLocalOpen(false); else controller.dismiss(tipId); };
  useEffect(() => () => controller?.dismiss(tipId), [controller?.dismiss, tipId]);
  const wrapper = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (text === null) { if (localOpen) setLocalOpen(false); controller?.dismiss(tipId); return; }
    if (!open) return;
    const box = wrapper.current!.getBoundingClientRect();
    const width = tip.current!.getBoundingClientRect().width;
    const height = tip.current!.getBoundingClientRect().height;
    tip.current!.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - width - 8))}px`;
    tip.current!.style.top = `${box.bottom + height + 8 < window.innerHeight ? box.bottom + 6 : Math.max(8, box.top - height - 6)}px`;
  }, [open, text]);
  return <span className="task-control-tip" ref={wrapper} tabIndex={text === null ? undefined : 0} role={text === null ? undefined : 'group'}
    aria-label={text === null ? undefined : label} aria-describedby={text === null ? undefined : tipId}
    onMouseEnter={() => show('hover')} onMouseLeave={() => hide('hover')} onFocus={() => show('focus')} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) hide('focus'); }}
    onKeyDown={(event) => { if (event.key === 'Escape' && text !== null && open) { event.preventDefault(); event.stopPropagation(); dismiss(); } }}>
    {children}{text !== null && <span id={tipId} ref={tip} role="tooltip" className={open ? 'task-control-tip-bubble' : 'task-control-tip-hidden'}>{text}</span>}
  </span>;
};
