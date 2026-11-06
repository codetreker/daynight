import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { ProjectPerson } from '../../api/auth-types';
import { useI18n } from '../../i18n/LocaleProvider';
import { useProjectAssigneeCatalogue } from '../task-assignees/TaskAssignees';
import { AssigneeAvatar, personName } from './TaskAssigneeIdentity';
import type { AssigneePeopleSnapshot } from '../task-assignees/TaskAssignees';

type Choice = { readonly value: string; readonly label: string; readonly person?: ProjectPerson };
export const AssigneePicker = ({ projectId, label, children, value, choices, disabled = false, resetKey, owner, triggerLabel, includeFormer = false, directCatalogue, selectionBlocked = false, onSelect }: {
  readonly projectId: string;
  readonly taskId?: string;
  readonly label: string;
  readonly triggerLabel?: string;
  readonly includeFormer?: boolean;
  readonly directCatalogue?: AssigneePeopleSnapshot & { readonly open: () => void; readonly retry: () => void };
  readonly children: ReactNode;
  readonly value: string;
  readonly choices: readonly Choice[];
  readonly disabled?: boolean;
  readonly selectionBlocked?: boolean;
  readonly resetKey?: string;
  readonly owner?: RefObject<HTMLElement | null>;
  readonly onSelect: (value: string) => void;
}) => {
  const { messages: { assignment: m } } = useI18n();
  const projectCatalogue = useProjectAssigneeCatalogue(projectId);
  const catalogue = directCatalogue ?? projectCatalogue;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const options = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();
  const close = (restore: boolean) => { setOpen(false); if (restore) trigger.current?.focus({ preventScroll: true }); };
  const show = () => { setQuery(''); setOpen(true); catalogue.open(); };
  useLayoutEffect(() => { setOpen(false); }, [projectId, resetKey, disabled]);
  const candidates = includeFormer ? [...new Map([...catalogue.items, ...catalogue.people.values()].map((person) => [person.userId, person])).values()] : catalogue.items;
  const available: readonly Choice[] = [...choices, ...candidates.filter((person) => includeFormer || person.hasProjectAccess)
    .map((person) => ({ value: person.userId, label: personName(person, person.userId), person }))];
  const matches = available.filter((choice) => choice.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()) || choice.value.includes(query));
  useLayoutEffect(() => {
    if (!open) return;
    if (catalogue.status === 'error') retry.current?.focus({ preventScroll: true });
    else search.current?.focus({ preventScroll: true });
  }, [open, catalogue.status]);
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      if (trigger.current === null || menu.current === null) return;
      const box = trigger.current.getBoundingClientRect();
      const width = Math.min(306, window.innerWidth - 24);
      menu.current.style.width = `${width}px`;
      menu.current.style.maxHeight = `${Math.min(370, window.innerHeight - 24)}px`;
      const height = menu.current.getBoundingClientRect().height;
      menu.current.style.left = `${Math.max(12, Math.min(box.left, window.innerWidth - width - 12))}px`;
      menu.current.style.top = `${Math.max(12, Math.min(box.bottom + height + 18 <= window.innerHeight ? box.bottom + 6 : box.top - height - 6, window.innerHeight - height - 12))}px`;
    };
    position();
    const started = performance.now();
    let frame = 0;
    const settle = () => { position(); if (performance.now() - started < 250) frame = requestAnimationFrame(settle); };
    frame = requestAnimationFrame(settle);
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    document.addEventListener('fullscreenchange', position);
    const observer = new ResizeObserver(position);
    observer.observe(menu.current!);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', position); document.removeEventListener('scroll', position, true); document.removeEventListener('fullscreenchange', position); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) close(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const popup = open ? <div className="assignee-menu" ref={menu} id={menuId} role="dialog" aria-label={label}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== trigger.current) close(false); }}
    onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === 'Tab') {
        const root = owner?.current ?? document;
        const focusables = Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),[tabindex="0"]'))
          .filter((element) => !menu.current?.contains(element) && element.closest('[hidden],[inert]') === null && element.getClientRects().length > 0);
        const index = focusables.indexOf(trigger.current!);
        const destination = focusables[index + (event.shiftKey ? -1 : 1)];
        if (destination !== undefined) { event.preventDefault(); close(false); destination.focus({ preventScroll: true }); }
        else close(false);
      } else if ((event.key === 'Home' || event.key === 'End') && event.target instanceof HTMLButtonElement) {
        event.preventDefault();
        const buttons = options.current.filter((button): button is HTMLButtonElement => button !== null && !button.disabled && button.isConnected);
        buttons[event.key === 'Home' ? 0 : buttons.length - 1]?.focus();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const buttons = options.current.filter((button): button is HTMLButtonElement => button !== null && !button.disabled && button.isConnected);
        if (buttons.length === 0) return;
        event.preventDefault();
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[index < 0 ? event.key === 'ArrowDown' ? 0 : buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    }}>
    <div className="assignee-search-wrap"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg><input className="assignee-search" ref={search} aria-label={m.search} placeholder={m.search} value={query} onChange={(event) => setQuery(event.currentTarget.value)} /></div>
    {catalogue.status === 'error' ? <div className="assignee-menu-state" role="alert"><p>{m.loadFailed}</p><button className="button" type="button" ref={retry} onClick={catalogue.retry}>{m.retry}</button></div>
      : catalogue.status !== 'ready' ? <div className="assignee-menu-state" role="status"><span className="spinner" aria-hidden="true" />{m.loading}</div>
      : <div className="assignee-options" role="listbox" aria-label={label}>{matches.length === 0 ? <p className="assignee-menu-state">{m.noPeople}</p> : matches.map((choice, index) => <button type="button" role="option" aria-selected={value === choice.value} tabIndex={-1} disabled={selectionBlocked}
        className="assignee-option" key={choice.value} ref={(node) => { options.current[index] = node; }}
        onClick={() => { if (!selectionBlocked) { close(true); onSelect(choice.value); } }}>
        <AssigneeAvatar {...(choice.person === undefined ? {} : { person: choice.person })} name={choice.value === '' ? null : choice.label} />
        <span className="assignee-option-name">{choice.label}{choice.person?.hasProjectAccess === false && <span className="assignee-former">{m.formerMember}</span>}</span><span className="assignee-check" aria-hidden="true">{choice.value === value ? '✓' : ''}</span>
      </button>)}</div>}
  </div> : null;
  return <>
    <button className="assignee-trigger" ref={trigger} type="button" aria-label={triggerLabel ?? label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? menuId : undefined} disabled={disabled}
      onClick={() => open ? close(false) : show()} onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(); } }}>{children}<svg className="assignee-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m2 4 3 3 3-3" /></svg></button>
    {popup !== null && (owner?.current == null ? popup : createPortal(popup, owner.current))}
  </>;
};
