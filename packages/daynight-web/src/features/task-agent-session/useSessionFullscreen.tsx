import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useBodyScrollLock } from '../../app/useBodyScrollLock';
import { dialogFocusables } from '../task-detail/focus';

export type SessionFullscreenRegistration = { readonly owner: object; readonly root: HTMLElement; readonly exit: () => void };
export const SessionFullscreenContext = createContext<((registration: SessionFullscreenRegistration) => (() => void)) | null>(null);

type Identity = { readonly client: object; readonly userId: string; readonly identity: string | null };

const inertOwners = new WeakMap<HTMLElement, { count: number; original: boolean }>();
function acquireInert(element: HTMLElement): () => void {
  let ownership = inertOwners.get(element);
  if (!ownership) {
    ownership = { count: 0, original: element.hasAttribute('inert') };
    inertOwners.set(element, ownership);
  }
  ownership.count++;
  element.setAttribute('inert', '');
  return () => {
    ownership.count--;
    if (ownership.count === 0) {
      if (!ownership.original) element.removeAttribute('inert');
      inertOwners.delete(element);
    }
  };
}

export function useSessionFullscreen({ client, userId, active, identity, fullscreenBoundary }: Identity & { readonly active: boolean; readonly fullscreenBoundary?: RefObject<HTMLElement | null> }) {
  const sectionRef = useRef<HTMLElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const rootElement = useCallback(() => {
    const section = sectionRef.current!;
    const root = fullscreenBoundary?.current ?? section;
    if (!root.contains(section)) throw new Error('The fullscreen boundary must contain its Session.');
    return root;
  }, [fullscreenBoundary]);
  const owner = useRef({});
  const register = useContext(SessionFullscreenContext);
  const knownIdentity = useRef<Identity>({ client, userId, identity });
  if (knownIdentity.current.client !== client || knownIdentity.current.userId !== userId) knownIdentity.current = { client, userId, identity };
  else if (identity !== null && identity !== knownIdentity.current.identity) knownIdentity.current = { client, userId, identity };
  const [expanded, setExpanded] = useState<Identity | null>(null);
  const fullscreen = active && expanded !== null && expanded.client === client && expanded.userId === userId && (expanded.identity === null || expanded.identity === knownIdentity.current.identity);
  const restoreFocus = useRef(false);
  const exit = useCallback(() => { restoreFocus.current = true; setExpanded(null); }, []);
  const toggle = () => { if (fullscreen) exit(); else if (active) setExpanded(knownIdentity.current); };
  useBodyScrollLock(fullscreen);

  useLayoutEffect(() => {
    if (expanded !== null && !fullscreen) setExpanded(null);
    else if (fullscreen && expanded?.identity === null && knownIdentity.current.identity !== null) setExpanded(knownIdentity.current);
    if (!fullscreen && restoreFocus.current) {
      restoreFocus.current = false;
      const button = buttonRef.current;
      if (active && button?.isConnected && !button.closest('[hidden], [inert]')) button.focus({ preventScroll: true });
    }
  }, [active, expanded, fullscreen, identity]);

  useLayoutEffect(() => {
    if (!fullscreen || !register) return;
    return register({ owner: owner.current, root: rootElement(), exit });
  }, [fullscreen, register, exit, rootElement]);

  useLayoutEffect(() => {
    if (!fullscreen) return;
    const root = rootElement();
    const owned = new Map<HTMLElement, () => void>();
    const isolate = () => {
      const background = new Set<HTMLElement>();
      // Authentication and other modal owners may temporarily disable this view.
      // Their foreground must remain accessible while this Session is inert.
      for (let branch: HTMLElement | null = root.closest('[hidden], [inert]') ? null : root; branch && branch !== document.body; branch = branch.parentElement) {
        for (const sibling of branch.parentElement?.children ?? []) {
          if (sibling !== branch && sibling instanceof HTMLElement) background.add(sibling);
        }
      }
      for (const [element, release] of owned) if (!background.has(element)) { release(); owned.delete(element); }
      for (const element of background) {
        if (!owned.has(element)) owned.set(element, acquireInert(element));
        else if (!element.hasAttribute('inert')) element.setAttribute('inert', '');
      }
    };
    isolate();
    const focusInside = () => (buttonRef.current ?? dialogFocusables(root)[0] ?? root).focus({ preventScroll: true });
    const mutations = new MutationObserver(() => {
      isolate();
      // Removing a focused composer or interaction moves focus to body without
      // firing focusin. Keep Escape reachable through loading/archive changes.
      if (!root.closest('[hidden], [inert]') && !root.contains(document.activeElement)) focusInside();
    });
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'inert'] });
    const focused = (event: FocusEvent) => { if (!root.contains(event.target as Node) && !root.closest('[hidden], [inert]')) focusInside(); };
    document.addEventListener('focusin', focused);
    return () => {
      mutations.disconnect();
      document.removeEventListener('focusin', focused);
      for (const release of owned.values()) release();
    };
  }, [fullscreen, rootElement]);

  useLayoutEffect(() => {
    if (!fullscreen) return;
    const root = rootElement();
    const originalFullscreen = root.getAttribute('data-session-fullscreen');
    root.setAttribute('data-session-fullscreen', 'true');
    const viewport = window.visualViewport;
    const keys = ['width', 'height', 'top', 'left'] as const;
    const original = keys.map(key => root.style.getPropertyValue(`--session-viewport-${key}`));
    const resize = () => {
      const values = [viewport?.width ?? window.innerWidth, viewport?.height ?? window.innerHeight, viewport?.offsetTop ?? 0, viewport?.offsetLeft ?? 0];
      keys.forEach((key, index) => root.style.setProperty(`--session-viewport-${key}`, `${values[index]}px`));
    };
    resize();
    window.addEventListener('resize', resize);
    viewport?.addEventListener('resize', resize);
    viewport?.addEventListener('scroll', resize);
    return () => {
      if (originalFullscreen === null) root.removeAttribute('data-session-fullscreen');
      else root.setAttribute('data-session-fullscreen', originalFullscreen);
      window.removeEventListener('resize', resize);
      viewport?.removeEventListener('resize', resize);
      viewport?.removeEventListener('scroll', resize);
      keys.forEach((key, index) => {
        if (original[index]) root.style.setProperty(`--session-viewport-${key}`, original[index]!);
        else root.style.removeProperty(`--session-viewport-${key}`);
      });
    };
  }, [fullscreen, rootElement]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLElement> | globalThis.KeyboardEvent) => {
    if (!fullscreen || event.defaultPrevented) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); exit(); }
    else if (event.key === 'Tab') {
      const root = rootElement();
      const controls = dialogFocusables(root);
      const first = controls[0], last = controls[controls.length - 1];
      if (!first || !last) { event.preventDefault(); root.focus({ preventScroll: true }); }
      else if (!root.contains(document.activeElement) || (!event.shiftKey && document.activeElement === last)) { event.preventDefault(); first.focus({ preventScroll: true }); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus({ preventScroll: true }); }
      // The outer task owns a different focus boundary.
      event.stopPropagation();
    }
  }, [fullscreen, exit, rootElement]);
  useLayoutEffect(() => {
    if (!fullscreen || !fullscreenBoundary) return;
    const root = rootElement();
    // React modal handlers run before this document listener, so their Escape
    // and Tab ownership is respected even when they are outside the Session.
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.target instanceof Node && root.contains(event.target) && !root.closest('[hidden], [inert]')) handleKeyDown(event);
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [fullscreen, fullscreenBoundary, rootElement, handleKeyDown]);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => { if (!fullscreenBoundary) handleKeyDown(event); };
  return { sectionRef, buttonRef, fullscreen, toggle, onKeyDown };
}
