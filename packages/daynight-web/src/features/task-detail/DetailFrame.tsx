import { isNativeSelectPopupOpen } from "../../ui/native-select/NativeSelect";
import { useContext, useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { isTopOverlay, OverlayOwnerContext, registerOverlay } from '../../app/overlay';
import { useBodyScrollLock } from '../../app/useBodyScrollLock';
import { dialogFocusables } from './focus';

export type DetailFullscreen = {
  readonly active: boolean;
  readonly onChange: (active: boolean) => void;
};

export const useDetailOverlay = ({ root, initialFocus, modal, fullscreen, scope, blocked, onEscape, onRestoreFocus }: {
  readonly root: RefObject<HTMLElement | null>;
  readonly initialFocus: RefObject<HTMLElement | null>;
  readonly modal: boolean;
  readonly fullscreen: boolean;
  readonly scope: string;
  readonly blocked: () => boolean;
  readonly onEscape: () => void;
  readonly onRestoreFocus?: () => void;
}) => {
  const parentOverlay = useContext(OverlayOwnerContext);
  const callbacks = useRef({ blocked, onEscape, onRestoreFocus });
  callbacks.current = { blocked, onEscape, onRestoreFocus };
  useBodyScrollLock(modal);
  useLayoutEffect(() => {
    const element = root.current!;
    const parent = modal ? parentOverlay?.current ?? document.getElementById('root') : null;
    if (modal && parent === null) throw new Error('The application root is required for the detail dialog.');
    const release = registerOverlay(element, parent);
    // Reparenting an existing layer must preserve focus and any selection in it.
    if (isTopOverlay(element) && !element.contains(document.activeElement)) (modal ? initialFocus.current : element)?.focus();
    return release;
  }, [scope, modal, parentOverlay, root, initialFocus]);
  useLayoutEffect(() => {
    if (!modal && !fullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const element = root.current!;
      if (!isTopOverlay(element) || callbacks.current.blocked() || event.defaultPrevented) return;
      if (event.key === 'Escape') {
        if (event.isComposing || event.keyCode === 229) return;
        if (isNativeSelectPopupOpen(event.target)) { event.stopPropagation(); return; }
        event.preventDefault();
        callbacks.current.onEscape();
      } else if (event.key === 'Tab' && modal) {
        const buttons = dialogFocusables(element);
        const first = buttons[0]!;
        const last = buttons[buttons.length - 1]!;
        const active = document.activeElement;
        if (!element.contains(active) || (!event.shiftKey && active === last)) {
          event.preventDefault(); first.focus();
        } else if (event.shiftKey && active === first) {
          event.preventDefault(); last.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [scope, modal, fullscreen, root]);
  useEffect(() => () => {
    // Restore after sibling DOM removals so a disappearing trigger cannot capture focus.
    if (modal) callbacks.current.onRestoreFocus?.();
  }, []);
};

export const useDetailFullscreen = (root: RefObject<HTMLElement | null>, toggle: RefObject<HTMLButtonElement | null>, fullscreen: DetailFullscreen) => {
  const pending = useRef<readonly { element: HTMLElement; top: number; left: number }[] | null>(null);
  const change = (active: boolean) => {
    // Capture before the browser clamps offsets to the new viewport's scroll range.
    pending.current = Array.from(root.current!.querySelectorAll<HTMLElement>('*'))
      .filter((element) => element.scrollTop !== 0 || element.scrollLeft !== 0 || element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth)
      .map((element) => ({ element, top: element.scrollTop, left: element.scrollLeft }));
    fullscreen.onChange(active);
  };
  useLayoutEffect(() => {
    if (pending.current === null) return;
    for (const { element, top, left } of pending.current) {
      element.scrollTop = top;
      element.scrollLeft = left;
    }
    pending.current = null;
    if (!fullscreen.active) toggle.current?.focus({ preventScroll: true });
  }, [fullscreen.active, toggle]);
  return change;
};

export const DetailFrame = ({ modal, root, className, headingId, children }: {
  readonly modal: boolean;
  readonly root: RefObject<HTMLElement | null>;
  readonly className: string;
  readonly headingId: string;
  readonly children: ReactNode;
}) => {
  const Surface = modal ? 'section' : 'main';
  return <Surface ref={root} className={className} role={modal ? 'dialog' : undefined} aria-modal={modal ? true : undefined} aria-labelledby={headingId} tabIndex={modal ? undefined : -1}>{children}</Surface>;
};

export const KeptMountedSlot = ({ active, children, ...attributes }: {
  readonly active: boolean;
  readonly children: ReactNode;
} & Omit<import('react').ComponentProps<'div'>, 'children' | 'hidden' | 'inert'>) =>
  <div {...attributes} hidden={!active} inert={!active}>{children}</div>;
