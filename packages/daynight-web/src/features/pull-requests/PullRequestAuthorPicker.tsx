import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../i18n/LocaleProvider';
import { SelectTrigger } from '../../ui/selection-control/SelectTrigger';
import './pull-request-author-picker.css';

export type PullRequestAuthor = { readonly id: string; readonly login: string; readonly loginAmbiguous: boolean };
export type PullRequestAuthorAnchor = { readonly focusedId: string | null; readonly visibleId: string | null };
export type PullRequestAuthorPickerProps = {
  readonly selected: PullRequestAuthor | null;
  readonly items: readonly PullRequestAuthor[];
  readonly query: string;
  readonly loading: boolean;
  readonly loaded: boolean;
  readonly error: unknown | null;
  readonly nextCursor: string | null;
  readonly rebuilding: boolean;
  readonly disabled: boolean;
  readonly active: boolean;
  readonly owner?: RefObject<HTMLElement | null>;
  readonly onOpen: () => void;
  readonly onClose: () => void;
  readonly onQueryChange: (value: string, composing?: boolean) => void;
  readonly onLoadMore: () => void;
  readonly onRetry: (anchor: PullRequestAuthorAnchor) => void;
  readonly onSelect: (author: PullRequestAuthor | null) => void;
};

const en = { creator: 'Creator: ', all: 'All', allAuthors: 'All creators', search: 'Search GitHub username', choose: 'Choose PR creator', list: 'PR creator', loading: 'Loading creators…', error: 'Unable to load creators.', retry: 'Retry', empty: 'No creators', noMatches: 'No matching creators', more: 'Load more', id: 'GitHub ID' };
const zh: typeof en = { creator: '创建者：', all: '全部', allAuthors: '全部创建者', search: '搜索 GitHub 用户名', choose: '选择 PR 创建者', list: 'PR 创建者', loading: '正在读取创建者…', error: '无法读取创建者。', retry: '重试', empty: '暂无创建者', noMatches: '没有匹配的创建者', more: '加载更多', id: 'GitHub ID' };

export const PullRequestAuthorPicker = (props: PullRequestAuthorPickerProps) => {
  const { locale } = useI18n(), m = locale === 'zh-CN' ? zh : en;
  const [open, setOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null), scroll = useRef<HTMLDivElement>(null);
  const composing = useRef(false), lastFocused = useRef<string | null>(null), moreFocused = useRef(false);
  const pendingAnchor = useRef<{ id: string | null; index: number; offset: number; focusedId: string | null; focusElement: Element | null; started: boolean } | null>(null);
  const menuId = useId(), listId = useId();
  const close = (restore: boolean) => { setOpen(false); setRetrying(false); pendingAnchor.current = null; props.onClose(); if (restore) trigger.current?.focus({ preventScroll: true }); };
  const show = () => { if (props.disabled) return; lastFocused.current = null; setOpen(true); props.onOpen(); };
  useLayoutEffect(() => { if (props.disabled && open) close(false); }, [props.disabled]);
  useLayoutEffect(() => { if (open && props.active) search.current?.focus({ preventScroll: true }); }, [open]);
  useLayoutEffect(() => {
    if (!open || !props.active) return;
    const position = () => {
      if (trigger.current === null || menu.current === null) return;
      const box = trigger.current.getBoundingClientRect(), width = Math.min(306, Math.max(0, window.innerWidth - 24));
      menu.current.style.width = `${width}px`;
      menu.current.style.maxHeight = `${Math.max(0, Math.min(420, window.innerHeight - 24))}px`;
      const height = menu.current.getBoundingClientRect().height;
      menu.current.style.left = `${Math.max(12, Math.min(box.left, window.innerWidth - width - 12))}px`;
      menu.current.style.top = `${Math.max(12, Math.min(box.bottom + height + 18 <= window.innerHeight ? box.bottom + 6 : box.top - height - 6, window.innerHeight - height - 12))}px`;
    };
    position();
    window.addEventListener('resize', position); document.addEventListener('scroll', position, true); document.addEventListener('fullscreenchange', position);
    const observer = new ResizeObserver(position);
    if (menu.current) observer.observe(menu.current);
    if (trigger.current) observer.observe(trigger.current);
    return () => { observer.disconnect(); window.removeEventListener('resize', position); document.removeEventListener('scroll', position, true); document.removeEventListener('fullscreenchange', position); };
  }, [open, props.active, props.items.length, props.loading, props.rebuilding, props.error]);
  useEffect(() => {
    if (!open || !props.active) return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.project-section-tab')) return;
      if (!trigger.current?.contains(target as Node) && !menu.current?.contains(target as Node)) close(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, props.active, props.onClose]);
  useLayoutEffect(() => {
    const anchor = pendingAnchor.current;
    if (anchor === null) return;
    if (props.rebuilding || props.loading) { anchor.started = true; return; }
    if (!anchor.started) return;
    pendingAnchor.current = null;
    setRetrying(false);
    if (props.error !== null) return;
    const entries = Array.from(scroll.current?.querySelectorAll<HTMLButtonElement>('[data-author-id]') ?? []);
    const row = anchor.id === null ? undefined : entries.find(entry => entry.dataset.authorId === anchor.id) ?? entries[Math.min(anchor.index, entries.length - 1)];
    if (row && scroll.current) scroll.current.scrollTop += row.getBoundingClientRect().top - scroll.current.getBoundingClientRect().top - anchor.offset;
    if (anchor.focusElement && (document.activeElement === anchor.focusElement || document.activeElement === document.body)) {
      const focus = entries.find(entry => entry.dataset.authorId === anchor.focusedId);
      (focus ?? search.current)?.focus({ preventScroll: true });
    }
  }, [props.items, props.loading, props.rebuilding, props.error]);
  useLayoutEffect(() => {
    if (open && props.active && props.nextCursor === null && moreFocused.current && document.activeElement === document.body) {
      moreFocused.current = false;
      search.current?.focus({ preventScroll: true });
    }
  }, [open, props.active, props.nextCursor]);
  const retry = () => {
    const container = scroll.current, entries = Array.from(container?.querySelectorAll<HTMLButtonElement>('[data-author-id]') ?? []);
    const top = container?.getBoundingClientRect().top ?? 0;
    const visible = entries.find(entry => entry.getBoundingClientRect().bottom > top);
    const focused = document.activeElement instanceof HTMLButtonElement ? document.activeElement.dataset.authorId ?? null : null;
    pendingAnchor.current = { id: visible?.dataset.authorId ?? null, index: Math.max(0, entries.indexOf(visible!)), offset: visible ? visible.getBoundingClientRect().top - top : 0, focusedId: focused ?? lastFocused.current, focusElement: menu.current?.contains(document.activeElement) ? document.activeElement : null, started: false };
    setRetrying(true);
    props.onRetry({ focusedId: focused ?? lastFocused.current, visibleId: visible?.dataset.authorId ?? null });
  };
  const select = (author: PullRequestAuthor | null) => { props.onSelect(author); close(true); };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || composing.current || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === 'Tab') {
      const inner = Array.from(menu.current?.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled):not([tabindex="-1"])') ?? []);
      const current = document.activeElement as HTMLElement;
      const index = current.getAttribute('role') === 'option' ? event.shiftKey ? 1 : 0 : inner.indexOf(current);
      const nextInner = inner[index + (event.shiftKey ? -1 : 1)];
      if (nextInner) { event.preventDefault(); nextInner.focus({ preventScroll: true }); return; }
      const root = props.owner?.current ?? document;
      const outer = Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),[tabindex="0"]')).filter(element => !menu.current?.contains(element) && element.closest('[hidden],[inert]') === null && element.getClientRects().length > 0);
      const destination = outer[outer.indexOf(trigger.current!) + (event.shiftKey ? -1 : 1)];
      if (destination) { event.preventDefault(); destination.focus({ preventScroll: true }); }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || ((event.key === 'Home' || event.key === 'End') && event.target instanceof HTMLButtonElement && event.target.getAttribute('role') === 'option')) {
      const choices = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
      if (!choices.length) return;
      event.preventDefault();
      const current = choices.indexOf(document.activeElement as HTMLButtonElement);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : current < 0 ? event.key === 'ArrowDown' ? 0 : choices.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
      choices[index]?.focus();
    }
  };
  const label = `${m.creator}${props.selected === null ? m.all : `${props.selected.login}${props.selected.loginAmbiguous ? ` (${m.id}: ${props.selected.id})` : ''}`}`;
  const popup = open ? <div ref={menu} className="pr-author-menu" id={menuId} role="dialog" aria-label={m.choose} hidden={!props.active} onKeyDown={keyDown}>
    <div className="pr-author-search-wrap"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></svg><input ref={search} type="search" role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-label={m.search} placeholder={m.search} autoComplete="off" value={props.query} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={event => { composing.current = false; props.onQueryChange(event.currentTarget.value, false); }} onChange={event => props.onQueryChange(event.currentTarget.value, composing.current)} /></div>
    <div id={listId} className="pr-author-options" role="listbox" aria-label={m.list} aria-busy={props.loading || props.rebuilding}>
      <button type="button" className="pr-author-option pr-author-all" role="option" aria-selected={props.selected === null} tabIndex={-1} onFocus={() => { lastFocused.current = null; }} onClick={() => select(null)}><span className="pr-author-avatar" aria-hidden="true">◎</span><span className="pr-author-name">{m.allAuthors}</span><span className="pr-author-check" aria-hidden="true">{props.selected === null ? '✓' : ''}</span></button>
      <div className="pr-author-scroll" ref={scroll}>{props.items.map(author => <button key={author.id} type="button" className="pr-author-option" role="option" aria-selected={props.selected?.id === author.id} tabIndex={-1} data-author-id={author.id} onFocus={() => { lastFocused.current = author.id; }} onClick={() => select(author)}><span className="pr-author-avatar" aria-hidden="true">{author.login.slice(0, 2).toUpperCase()}</span><span className="pr-author-name">{author.login}{author.loginAmbiguous && <span className="pr-author-id">{m.id}: {author.id}</span>}</span><span className="pr-author-check" aria-hidden="true">{props.selected?.id === author.id ? '✓' : ''}</span></button>)}</div>
    </div>
    {(props.error !== null || retrying && (props.loading || props.rebuilding)) && <div className="pr-author-state pr-author-error" role="alert"><span>{m.error}</span><button className="button" type="button" aria-disabled={props.loading || props.rebuilding} onClick={() => { if (!props.loading && !props.rebuilding) retry(); }}>{m.retry}</button></div>}
    {(props.loading || props.rebuilding || !props.loaded && props.error === null) && <div className="pr-author-state" role="status">{m.loading}</div>}
    {props.loaded && !props.loading && !props.rebuilding && props.error === null && props.items.length === 0 && <div className="pr-author-state" role="status">{props.query === '' ? m.empty : m.noMatches}</div>}
    {props.nextCursor !== null && <button className="button pr-author-more" type="button" aria-disabled={props.loading || props.rebuilding || props.error !== null} onFocus={() => { moreFocused.current = true; }} onBlur={() => { moreFocused.current = false; }} onClick={() => { if (!props.loading && !props.rebuilding && props.error === null) props.onLoadMore(); }}>{m.more}</button>}
  </div> : null;
  return <><SelectTrigger ref={trigger} density="filter" touchMode="responsive" focusTone="task" layoutClassName="pr-author-trigger" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? menuId : undefined} aria-label={label} title={label} disabled={props.disabled} pending={open && props.loading} aria-invalid={props.error !== null || undefined} onClick={() => open ? close(false) : show()} onKeyDown={event => { if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); show(); } }}>{label}</SelectTrigger>{popup !== null && createPortal(popup, props.owner?.current ?? document.body)}</>;
};
