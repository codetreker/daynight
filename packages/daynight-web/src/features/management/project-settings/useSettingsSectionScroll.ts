import { useCallback, useLayoutEffect, useRef } from 'react';
import type { ProjectSettingsTab } from '../../../app/project-settings-route';

type Position = { y: number; element: HTMLElement | null; start: number | null; end: number | null };
export const useSettingsSectionScroll = (tab: ProjectSettingsTab | null, onRoute: boolean) => {
  const positions = useRef<Partial<Record<ProjectSettingsTab, Position>>>({});
  const current = useRef<ProjectSettingsTab | null>(tab);
  const capture = useCallback(() => {
    if (!onRoute || current.current === null) return;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = focused?.closest('.project-settings-content') ? focused : positions.current[current.current]?.element ?? null;
    const input = element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement ? element : null;
    positions.current[current.current] = { y: window.scrollY, element, start: input?.selectionStart ?? null, end: input?.selectionEnd ?? null };
  }, [onRoute]);
  useLayoutEffect(() => {
    if (!onRoute) return;
    const old = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    window.addEventListener('scroll', capture, { passive: true });
    window.addEventListener('popstate', capture, true);
    document.addEventListener('focusin', capture);
    document.addEventListener('select', capture);
    return () => { window.removeEventListener('scroll', capture); window.removeEventListener('popstate', capture, true); document.removeEventListener('focusin', capture); document.removeEventListener('select', capture); window.history.scrollRestoration = old; };
  }, [onRoute, capture]);
  useLayoutEffect(() => {
    if (current.current === tab) return;
    current.current = tab;
    if (!onRoute || tab === null) return;
    const position = positions.current[tab];
    window.scrollTo(window.scrollX, position?.y ?? 0);
    if (document.activeElement === document.body && position?.element?.isConnected && !position.element.closest('[hidden], [inert]')) {
      position.element.focus({ preventScroll: true });
      if ((position.element instanceof HTMLTextAreaElement || position.element instanceof HTMLInputElement) && position.start !== null && position.end !== null) {
        try { position.element.setSelectionRange(position.start, position.end); } catch { /* Input type has no selection. */ }
      }
    }
  }, [tab, onRoute]);
  return capture;
};
