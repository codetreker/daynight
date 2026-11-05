import { useLayoutEffect, useRef } from 'react';
import type { ConfigurationDraft } from './model';

// The document scrolls this form. Keep the active field and its error above the
// anchored actions without moving focus or changing the input's selection.
const revealFocusedField = (form: HTMLFormElement) => {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !form.contains(active)) return;
  const field = active.closest<HTMLElement>('.field');
  const bar = form.querySelector<HTMLElement>('.config-save-bar');
  if (field === null || bar === null) return;
  const barBox = bar.getBoundingClientRect();
  if (barBox.height === 0) return;
  const bottom = barBox.top - 12;
  const fieldBox = field.getBoundingClientRect();
  const box = fieldBox.height <= bottom ? fieldBox : active.getBoundingClientRect();
  if (box.bottom > bottom) window.scrollBy({ top: box.bottom - bottom, behavior: 'instant' });
  else if (box.top < 0) window.scrollBy({ top: box.top - 12, behavior: 'instant' });
};

export const useConfigurationFormScroll = (active: boolean, draft: ConfigurationDraft | null) => {
  const ref = useRef<HTMLFormElement>(null);
  useLayoutEffect(() => {
    const form = ref.current;
    if (!active || form === null) return;
    const slot = form.querySelector<HTMLElement>('.config-save-slot');
    const bar = form.querySelector<HTMLElement>('.config-save-bar');
    if (slot === null || bar === null) return;
    const reveal = () => revealFocusedField(form);
    // Keep one footer in DOM order, anchored to its in-flow slot's width. Its
    // fixed position remains visible even when save notices push the form down.
    const measure = () => {
      const box = slot.getBoundingClientRect();
      form.style.setProperty('--config-save-left', `${box.left}px`);
      form.style.setProperty('--config-save-width', `${box.width}px`);
      slot.style.height = `${bar.getBoundingClientRect().height}px`;
    };
    const resize = () => { measure(); reveal(); };
    measure();
    form.addEventListener('focusin', reveal);
    window.addEventListener('resize', resize);
    window.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => {
      measure();
      if (entries.some(entry => entry.target === bar)) reveal();
    });
    observer?.observe(slot); observer?.observe(bar);
    observer?.observe(form.closest('.workspace') ?? form);
    return () => {
      form.removeEventListener('focusin', reveal); window.removeEventListener('resize', resize);
      window.removeEventListener('scroll', measure); observer?.disconnect();
      form.style.removeProperty('--config-save-left'); form.style.removeProperty('--config-save-width');
      slot.style.removeProperty('height');
    };
  }, [active]);
  useLayoutEffect(() => {
    if (active && ref.current !== null) revealFocusedField(ref.current);
  }, [active, draft]);
  return ref;
};
