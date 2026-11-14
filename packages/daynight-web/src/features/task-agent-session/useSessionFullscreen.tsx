import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useBodyScrollLock } from '../../app/useBodyScrollLock';
import { acquireInert } from '../../app/inert';
import { dialogFocusables } from '../task-detail/focus';
import { containSessionScroll } from './containSessionScroll';
import { isNativeSelectPopupOpen } from '../../ui/native-select/NativeSelect';

export type SessionFullscreenRegistration = { readonly owner: object; readonly root: HTMLElement; readonly exit: () => void };
export const SessionFullscreenContext = createContext<((registration: SessionFullscreenRegistration) => (() => void)) | null>(null);

type Identity = { readonly client: object; readonly userId: string; readonly identity: string | null };
type ViewportOwner = { refresh: () => void };
type ViewportOwnership = { readonly original: readonly string[]; readonly owners: ViewportOwner[] };
const viewportOwners = new WeakMap<HTMLElement, ViewportOwnership>();
type RootViewportOwnership = { readonly fullscreen: string | null; readonly original: readonly string[]; readonly reserve: string; readonly owners: ViewportOwner[] };
const rootViewportOwners = new WeakMap<HTMLElement, RootViewportOwnership>();

export function useSessionFullscreen({ client, userId, active, identity, fullscreenBoundary }: Identity & { readonly active: boolean; readonly fullscreenBoundary?: RefObject<HTMLElement | null> }) {
  const sectionRef = useRef<HTMLElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const rootElement = useCallback(() => {
    const section = sectionRef.current!;
    const root = fullscreenBoundary?.current ?? section;
    if (!root.contains(section)) throw new Error('The fullscreen boundary must contain its Session.');
    return root;
  }, [fullscreenBoundary]);
  const resultSlot = useCallback((): HTMLElement | null =>
    rootElement().closest('.standalone-task-route')?.querySelector<HTMLElement>('.standalone-deletion-slot') ?? null, [rootElement]);
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
  useBodyScrollLock(fullscreen, true);

  useLayoutEffect(() => {
    if (fullscreen) return containSessionScroll(rootElement(), resultSlot);
  }, [fullscreen, rootElement, resultSlot]);

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
      const results = resultSlot();
      const blocked = root.closest('[hidden], [inert]') !== null;
      if (blocked && results !== null) background.add(results);
      for (let branch: HTMLElement | null = blocked ? null : root; branch && branch !== document.body; branch = branch.parentElement) {
        for (const sibling of branch.parentElement?.children ?? []) {
          if (sibling !== branch && sibling !== results && sibling instanceof HTMLElement) background.add(sibling);
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
      if (!root.closest('[hidden], [inert]') && !root.contains(document.activeElement) && !resultSlot()?.contains(document.activeElement)) focusInside();
    });
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'inert'] });
    const focused = (event: FocusEvent) => { if (!root.contains(event.target as Node) && !resultSlot()?.contains(event.target as Node) && !root.closest('[hidden], [inert]')) focusInside(); };
    document.addEventListener('focusin', focused);
    return () => {
      mutations.disconnect();
      document.removeEventListener('focusin', focused);
      for (const release of owned.values()) release();
    };
  }, [fullscreen, rootElement, resultSlot]);

  useLayoutEffect(() => {
    if (!fullscreen) return;
    const root = rootElement();
    const viewport = window.visualViewport;
    const keys = ['width', 'height', 'top', 'left'] as const;
    const rootState = rootViewportOwners.get(root) ?? { fullscreen: root.getAttribute('data-session-fullscreen'), original: keys.map(key => root.style.getPropertyValue(`--session-viewport-${key}`)), reserve: root.style.getPropertyValue('--session-result-reserve'), owners: [] };
    const route = root.closest<HTMLElement>('.standalone-task-route');
    const slot = resultSlot();
    const routeKeys = [...keys.map(key => `--standalone-session-viewport-${key}`), '--standalone-session-result-reserve'];
    const routeState: ViewportOwnership | null = route !== null && slot !== null
      ? viewportOwners.get(route) ?? { original: routeKeys.map(key => route.style.getPropertyValue(key)), owners: [] }
      : null;
    const routeOwner: ViewportOwner = { refresh: () => {} };
    rootState.owners.push(routeOwner); rootViewportOwners.set(root, rootState);
    root.setAttribute('data-session-fullscreen', 'true');
    if (route !== null && routeState !== null) { routeState.owners.push(routeOwner); viewportOwners.set(route, routeState); }
    const resize = () => {
      const values = [viewport?.width ?? window.innerWidth, viewport?.height ?? window.innerHeight, viewport?.offsetTop ?? 0, viewport?.offsetLeft ?? 0];
      const currentRoot = rootState.owners.at(-1) === routeOwner;
      if (currentRoot) keys.forEach((key, index) => root.style.setProperty(`--session-viewport-${key}`, `${values[index]}px`));
      if (route !== null && slot !== null && routeState !== null) {
        const reserve = `${slot.getBoundingClientRect().height}px`;
        if (currentRoot) root.style.setProperty('--session-result-reserve', reserve);
        if (routeState.owners.at(-1) === routeOwner) {
          keys.forEach((key, index) => route.style.setProperty(`--standalone-session-viewport-${key}`, `${values[index]}px`));
          route.style.setProperty('--standalone-session-result-reserve', reserve);
        }
      }
    };
    routeOwner.refresh = resize;
    resize();
    const slotObserver = slot !== null && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    if (slot !== null) slotObserver?.observe(slot);
    window.addEventListener('resize', resize);
    viewport?.addEventListener('resize', resize);
    viewport?.addEventListener('scroll', resize);
    return () => {
      window.removeEventListener('resize', resize);
      viewport?.removeEventListener('resize', resize);
      viewport?.removeEventListener('scroll', resize);
      slotObserver?.disconnect();
      if (route !== null && routeState !== null) {
        const index = routeState.owners.indexOf(routeOwner);
        const wasCurrent = index === routeState.owners.length - 1;
        if (index >= 0) routeState.owners.splice(index, 1);
        if (routeState.owners.length === 0) {
          routeKeys.forEach((key, index) => { if (routeState.original[index]) route.style.setProperty(key, routeState.original[index]!); else route.style.removeProperty(key); });
          viewportOwners.delete(route);
        } else if (wasCurrent) routeState.owners.at(-1)!.refresh();
      }
      const index = rootState.owners.indexOf(routeOwner);
      const wasCurrent = index === rootState.owners.length - 1;
      if (index >= 0) rootState.owners.splice(index, 1);
      if (rootState.owners.length === 0) {
        if (rootState.fullscreen === null) root.removeAttribute('data-session-fullscreen');
        else root.setAttribute('data-session-fullscreen', rootState.fullscreen);
        keys.forEach((key, index) => { if (rootState.original[index]) root.style.setProperty(`--session-viewport-${key}`, rootState.original[index]!); else root.style.removeProperty(`--session-viewport-${key}`); });
        if (rootState.reserve) root.style.setProperty('--session-result-reserve', rootState.reserve);
        else root.style.removeProperty('--session-result-reserve');
        rootViewportOwners.delete(root);
      } else if (wasCurrent) rootState.owners.at(-1)!.refresh();
    };
  }, [fullscreen, rootElement, resultSlot]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLElement> | globalThis.KeyboardEvent) => {
    if (!fullscreen || event.defaultPrevented) return;
    if (event.key === 'Escape') {
      const nativeEvent = 'nativeEvent' in event ? event.nativeEvent : event;
      event.stopPropagation();
      if (nativeEvent.isComposing || nativeEvent.keyCode === 229 || isNativeSelectPopupOpen(event.target)) return;
      event.preventDefault(); exit();
    }
    else if (event.key === 'Tab') {
      const root = rootElement();
      const results = resultSlot();
      const controls = [...dialogFocusables(root), ...(results === null || results.closest('[hidden], [inert]') ? [] : dialogFocusables(results))];
      const first = controls[0], last = controls[controls.length - 1];
      if (!first || !last) { event.preventDefault(); root.focus({ preventScroll: true }); }
      else if ((!root.contains(document.activeElement) && !results?.contains(document.activeElement)) || (!event.shiftKey && document.activeElement === last)) { event.preventDefault(); first.focus({ preventScroll: true }); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus({ preventScroll: true }); }
      // The outer task owns a different focus boundary.
      event.stopPropagation();
    }
  }, [fullscreen, exit, rootElement, resultSlot]);
  useLayoutEffect(() => {
    if (!fullscreen) return;
    const root = rootElement();
    // React modal handlers run before this document listener, so their Escape
    // and Tab ownership is respected even when they are outside the Session.
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.target instanceof Node && !root.closest('[hidden], [inert]') && (resultSlot()?.contains(event.target) || fullscreenBoundary && root.contains(event.target))) handleKeyDown(event);
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [fullscreen, fullscreenBoundary, rootElement, resultSlot, handleKeyDown]);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => { if (!fullscreenBoundary) handleKeyDown(event); };
  return { sectionRef, buttonRef, fullscreen, toggle, onKeyDown };
}
